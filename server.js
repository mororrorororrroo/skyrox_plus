'use strict';

const path = require('path');
const express = require('express');
const compression = require('compression');
const Unblocker = require('unblocker');
const http = require('http');
const https = require('https');

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROXY_PREFIX = '/proxy/';
const CONTEXT_COOKIE = '__proxy_origin';

const MAX_SOCKETS = positiveInteger(process.env.MAX_SOCKETS, 128);
const MAX_FREE_SOCKETS = positiveInteger(process.env.MAX_FREE_SOCKETS, 32);
const MAX_TOTAL_SOCKETS = positiveInteger(process.env.MAX_TOTAL_SOCKETS, 512);

const agentOptions = {
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS,
  maxTotalSockets: MAX_TOTAL_SOCKETS,
  scheduling: 'lifo'
};

const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Some upstream sites, including DuckDuckGo, can produce a redirect URL that
// contains Unicode or control characters. Node.js rejects such a value when it
// is written to the Location header, so normalize it at the final write point.
app.use((req, res, next) => {
  const originalSetHeader = res.setHeader;
  res.setHeader = function setSafeHeader(name, value) {
    if (String(name).toLowerCase() === 'location') {
      value = sanitizeLocationValue(value);
    }
    return originalSetHeader.call(this, name, value);
  };
  next();
});

function sanitizeLocationValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeLocationValue);
  if (typeof value !== 'string') return value;

  // Drop characters that must never be accepted in an HTTP header, then
  // percent-encode spaces and non-ASCII URL characters without double-encoding
  // existing percent escapes.
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/ /g, '%20')
    .replace(/[^\x21-\x7e]/gu, (character) => encodeURIComponent(character));
}

function sanitizeProxyResponseHeaders(data) {
  if (!data?.headers || data.headers.location == null) return;
  data.headers.location = sanitizeLocationValue(data.headers.location);
}

// Small responses are cheaper to send as-is. Range/download responses are not compressed.
app.use(compression({
  level: 1,
  threshold: 4 * 1024,
  filter(req, res) {
    if (req.headers.range || req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Serve public assets early so they do not pass through proxy recovery logic.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  lastModified: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.[a-f0-9]{8,}\./i.test(path.basename(filePath))) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

app.use((req, res, next) => {
  const repairedUrl = repairProxyPath(req.url);

  if (typeof req.headers.referer === 'string') {
    req.headers.referer = repairProxyReference(req.headers.referer);
  }

  if (repairedUrl !== req.url) req.url = repairedUrl;
  next();
});

function repairProxyReference(value) {
  try {
    const reference = new URL(value);
    const repaired = repairProxyPath(
      `${reference.pathname}${reference.search}${reference.hash}`
    );
    return `${reference.origin}${repaired}`;
  } catch {
    return repairProxyPath(value);
  }
}

function repairProxyPath(value) {
  if (typeof value !== 'string' || !value.includes(PROXY_PREFIX)) return value;

  const prefixIndex = value.indexOf(PROXY_PREFIX);
  const before = value.slice(0, prefixIndex + PROXY_PREFIX.length);
  let target = value.slice(prefixIndex + PROXY_PREFIX.length);

  if (!/^https?:/i.test(target)) return value;

  target = target.replace(/^(https?):\/(?!\/)/i, '$1://');
  target = target.replace(/%25([0-9a-f]{2})/gi, '%$1');
  return before + target;
}

function rememberDocumentOrigin(data) {
  if (!data?.headers || !data.url || !data.clientRequest) return;

  const method = String(data.clientRequest.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return;

  const contentType = String(
    data.headers['content-type'] || data.contentType || ''
  ).toLowerCase();
  if (!contentType.includes('text/html')) return;

  const destination = String(
    data.clientRequest.headers['sec-fetch-dest'] || ''
  ).toLowerCase();
  if (destination && destination !== 'document' && destination !== 'iframe') return;

  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }

  if (!isHttpOrigin(target)) return;

  const encodedOrigin = Buffer.from(target.origin, 'utf8').toString('base64url');
  const secure = isSecureClientRequest(data.clientRequest) ? '; Secure' : '';
  const cookie = `${CONTEXT_COOKIE}=${encodedOrigin}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax${secure}`;
  appendSetCookie(data.headers, cookie);
}

function cleanProxyRequest(data) {
  if (!data?.headers) return;
  delete data.headers['proxy-connection'];
}

function addConservativeAssetCache(data) {
  if (!data?.headers || !data.clientRequest || !data.remoteResponse) return;

  const method = String(data.clientRequest.method || 'GET').toUpperCase();
  if ((method !== 'GET' && method !== 'HEAD') || data.remoteResponse.statusCode !== 200) return;

  if (
    data.headers['cache-control'] ||
    data.headers['set-cookie'] ||
    data.clientRequest.headers.authorization
  ) return;

  const contentType = String(data.headers['content-type'] || '').toLowerCase();
  const staticAsset =
    contentType.startsWith('image/') ||
    contentType.startsWith('font/') ||
    contentType.startsWith('audio/') ||
    contentType.includes('text/css') ||
    contentType.includes('javascript') ||
    contentType.includes('application/wasm');

  if (staticAsset) data.headers['cache-control'] = 'private, max-age=300';
}

function preserveDownloadResponse(data) {
  if (!data?.headers || !data.url || !data.remoteResponse) return;

  const status = Number(data.remoteResponse.statusCode || 0);
  if (status < 200 || status >= 300) return;

  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }

  const pathname = target.pathname;
  const extension = pathname.includes('.')
    ? pathname.slice(pathname.lastIndexOf('.')).toLowerCase()
    : '';
  const contentType = String(data.headers['content-type'] || '').toLowerCase();
  const downloadExtensions = new Set([
    '.mcworld', '.mcpack', '.zip', '.rar', '.7z', '.tar', '.gz',
    '.pdf', '.apk', '.exe', '.msi', '.dmg', '.iso'
  ]);

  const isDownload =
    downloadExtensions.has(extension) ||
    contentType.includes('application/zip') ||
    contentType.includes('application/octet-stream') ||
    contentType.includes('application/x-rar-compressed') ||
    contentType.includes('application/vnd.rar');

  if (!isDownload) return;

  if (!data.headers['content-disposition']) {
    const rawName = decodePathFilename(pathname) || `download${extension}`;
    const asciiName = rawName
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_')
      .slice(0, 180) || `download${extension}`;
    const encodedName = encodeURIComponent(rawName).replace(/['()]/g, escapeChar);
    data.headers['content-disposition'] =
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
  }

  data.headers['cache-control'] ||= 'private, no-transform';
}

function escapeChar(character) {
  return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
}

function decodePathFilename(pathname) {
  const last = pathname.split('/').filter(Boolean).pop();
  if (!last) return '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

app.use((req, res, next) => {
  if (req.originalUrl.startsWith(PROXY_PREFIX)) return next();

  // The root is always local, even when it has a query string or a proxy
  // context cookie. This prevents "/" and "/?q=..." from being restored to
  // a previously visited upstream site such as DuckDuckGo.
  if (req.path === '/') return next();
  if (isLocalRoute(req.path)) return next();

  const proxyRefererOrigin = getOriginFromProxyReferer(req);
  const contextCookieOrigin = getOriginFromContextCookie(req);
  const upstreamOrigin = proxyRefererOrigin || contextCookieOrigin;

  const destination = String(req.get('sec-fetch-dest') || '').toLowerCase();
  const mode = String(req.get('sec-fetch-mode') || '').toLowerCase();
  const isNavigation =
    req.method === 'HEAD' ||
    mode === 'navigate' ||
    destination === 'document' ||
    destination === 'iframe';

  if (!isNavigation || !upstreamOrigin) return next();

  let target;
  try {
    target = new URL(req.originalUrl, `${upstreamOrigin}/`);
  } catch {
    return next();
  }

  if (!isHttpOrigin(target)) return next();

  const proxiedUrl = `${PROXY_PREFIX}${target.href}`;

  req.url = proxiedUrl;
  next();
});

const unblocker = new Unblocker({
  prefix: PROXY_PREFIX,
  cookieRewrite: true,
  redirectFollow: true,
  clientScripts: true,
  httpAgent,
  httpsAgent,
  requestMiddleware: [cleanProxyRequest],
  responseMiddleware: [
    sanitizeProxyResponseHeaders,
    rememberDocumentOrigin,
    preserveDownloadResponse,
    addConservativeAssetCache
  ]
});

app.use(unblocker);

app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).send('ok');
});

// Root access always returns public/index.html.
app.get('/', (req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (error) => {
    if (error) next(error);
  });
});

app.use((req, res) => {
  res.status(404).send('Not found');
});

const server = app.listen(PORT, () => {
  console.log(`Proxy listening on ${PORT}`);
});

server.keepAliveTimeout = 15_000;
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;
server.setTimeout(120_000);
server.maxRequestsPerSocket = 1_000;

const handleUpgrade = unblocker.onUpgrade.bind(unblocker);
server.on('upgrade', (req, socket, head) => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);
  socket.setTimeout(0);
  handleUpgrade(req, socket, head);
});

function getOriginFromProxyReferer(req) {
  const referer = req.get('referer');
  const requestHost = req.get('host');
  if (!referer || !requestHost) return null;

  let refererUrl;
  try {
    refererUrl = new URL(referer);
  } catch {
    return null;
  }

  if (refererUrl.host !== requestHost || !refererUrl.pathname.startsWith(PROXY_PREFIX)) {
    return null;
  }

  const proxiedTargetText =
    refererUrl.pathname.slice(PROXY_PREFIX.length) + refererUrl.search;
  try {
    const proxiedTarget = new URL(proxiedTargetText);
    return isHttpOrigin(proxiedTarget) ? proxiedTarget.origin : null;
  } catch {
    return null;
  }
}

function getOriginFromContextCookie(req) {
  const encoded = parseCookies(req.headers.cookie)[CONTEXT_COOKIE];
  if (!encoded || encoded.length > 2048) return null;

  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  try {
    const origin = new URL(decoded);
    return isHttpOrigin(origin) && origin.href === `${origin.origin}/`
      ? origin.origin
      : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const result = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) result[name] = value;
  }
  return result;
}

function appendSetCookie(headers, cookie) {
  const current = headers['set-cookie'];
  if (!current) headers['set-cookie'] = [cookie];
  else if (Array.isArray(current)) headers['set-cookie'] = current.concat(cookie);
  else headers['set-cookie'] = [current, cookie];
}

function isSecureClientRequest(request) {
  const forwarded = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwarded === 'https' || Boolean(request.socket?.encrypted);
}

function isHttpOrigin(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function isLocalRoute(pathname) {
  return pathname === '/' ||
    pathname === '/healthz' ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt';
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);

  server.close(() => {
    httpAgent.destroy();
    httpsAgent.destroy();
    process.exit(0);
  });

  setTimeout(() => {
    httpAgent.destroy();
    httpsAgent.destroy();
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
