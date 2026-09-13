'use strict';

const path = require('path');
const fs = require('fs');
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
const POKI_WEB_ORIGIN = 'https://poki.com';
const POKI_AUTH_HOSTS = new Set(['poki-auth.poki.com']);
const YOUTUBE_TV_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; UHD Google TV STB Build/UTT1.250214.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.7922.199 Mobile Safari/537.36';
const MAX_SOCKETS = positiveInteger(process.env.MAX_SOCKETS, 16);
const MAX_FREE_SOCKETS = positiveInteger(process.env.MAX_FREE_SOCKETS, 16);
const MAX_TOTAL_SOCKETS = positiveInteger(process.env.MAX_TOTAL_SOCKETS, 64);
const MINECRAFT_DOWNLOAD_HOSTS = new Set([
  'minecraft-mcworld.com',
  'www.minecraft-mcworld.com'
]);
const MINECRAFT_DOWNLOAD_EXTENSIONS = new Set(['.mcworld', '.mcpack', '.zip']);

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

app.use((req, res, next) => {
  const originalSetHeader = res.setHeader;
  res.setHeader = function setSafeHeader(name, value) {
    const lowerName = String(name).toLowerCase();
    if (lowerName === 'location') {
      value = sanitizeLocationValue(value);
    }
    if (lowerName === 'permissions-policy') {
      value = sanitizePermissionsPolicyValue(value);
      if (value == null || value === '') return this;
    }
    return originalSetHeader.call(this, name, value);
  };
  next();
});

function sanitizePermissionsPolicyValue(value) {
  const values = Array.isArray(value) ? value : [value];
  const cleaned = values
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/^attribution-reporting\s*=/i.test(item));
  return cleaned.length ? cleaned.join(', ') : null;
}

function sanitizeLocationValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeLocationValue);
  if (typeof value !== 'string') return value;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/ /g, '%20')
    .replace(/[^\x21-\x7e]/gu, (character) => encodeURIComponent(character));
}

function keepYouTubeTvRedirectInsideProxy(data) {
  if (!data?.headers || data.headers.location == null || !data.url) return;
  let source;
  try { source = new URL(data.url); } catch { return; }
  const sourceHost = source.hostname.toLowerCase();
  if (sourceHost !== 'youtube.com' && sourceHost !== 'www.youtube.com') return;
  const rewrite = (value) => {
    if (typeof value !== 'string') return value;
    try {
      const target = new URL(value, source);
      const host = target.hostname.toLowerCase();
      if ((host === 'youtube.com' || host === 'www.youtube.com') &&
          (target.pathname === '/tv' || target.pathname.startsWith('/tv/'))) {
        return `${PROXY_PREFIX}${target.href}`;
      }
    } catch {}
    return value;
  };
  data.headers.location = Array.isArray(data.headers.location)
    ? data.headers.location.map(rewrite)
    : rewrite(data.headers.location);
}

function sanitizeProxyResponseHeaders(data) {
  if (!data?.headers || data.headers.location == null) return;
  data.headers.location = sanitizeLocationValue(data.headers.location);
}

// Normalize malformed proxied Location values such as /proxy/https:/host/path.
function repairMalformedProxyLocation(data) {
  if (!data?.headers || data.headers.location == null) return;
  const repair = (location) => {
    if (typeof location !== 'string') return location;
    return location.replace(
      /\/proxy\/(https?):\/(?!\/)/gi,
      '/proxy/$1://'
    );
  };
  data.headers.location = Array.isArray(data.headers.location)
    ? data.headers.location.map(repair)
    : repair(data.headers.location);
}

// Fix minecraft-mcworld.com download redirects whose Japanese filename was
// decoded as Latin-1 and then encoded again, for example ç·´ç¿ã... -> 練習ワールド.
function repairMinecraftDownloadRedirect(data) {
  if (!data?.headers || data.headers.location == null || !data.url) return;
  const repair = (location) => {
    const repaired = repairMinecraftDownloadLocation(location, data.url);
    if (repaired !== location) {
      console.log(JSON.stringify({
        type: 'minecraft-download-redirect-repaired',
        sourceUrl: data.url,
        before: location,
        after: repaired
      }));
    }
    return repaired;
  };
  data.headers.location = Array.isArray(data.headers.location)
    ? data.headers.location.map(repair)
    : repair(data.headers.location);
}
function repairMinecraftDownloadLocation(location, baseUrl) {
  if (typeof location !== 'string') return location;
  let absolute;
  try {
    absolute = new URL(location, baseUrl);
  } catch {
    return location;
  }

  // Unblocker may already have wrapped the upstream Location in this proxy's
  // URL. Repair the inner minecraft-mcworld.com URL without confusing the
  // proxy host with the upstream host.
  const proxyIndex = absolute.pathname.indexOf(PROXY_PREFIX);
  if (proxyIndex !== -1) {
    let innerTarget =
      absolute.pathname.slice(proxyIndex + PROXY_PREFIX.length) +
      absolute.search +
      absolute.hash;
    innerTarget = innerTarget.replace(/^(https?):\/(?!\/)/i, '$1://');
    innerTarget = innerTarget.replace(/%25([0-9a-f]{2})/gi, '%$1');
    const repairedInnerTarget = repairMinecraftDownloadUrl(innerTarget);
    if (repairedInnerTarget !== innerTarget) {
      const proxyPath = absolute.pathname.slice(0, proxyIndex + PROXY_PREFIX.length);
      return `${absolute.origin}${proxyPath}${repairedInnerTarget}`;
    }
  }

  return repairMinecraftDownloadUrl(absolute.href);
}

function repairMinecraftDownloadUrl(value) {
  if (typeof value !== 'string') return value;

  let target;
  try {
    target = new URL(value);
  } catch {
    return value;
  }

  if (!MINECRAFT_DOWNLOAD_HOSTS.has(target.hostname.toLowerCase())) return value;
  if (!target.pathname.startsWith('/wp-content/uploads/')) return value;

  const lowerPath = target.pathname.toLowerCase();
  const matchingExtension = [...MINECRAFT_DOWNLOAD_EXTENSIONS]
    .some((extension) => lowerPath.endsWith(extension));
  if (!matchingExtension) return value;

  const repairedPath = target.pathname
    .split('/')
    .map(repairEncodedMojibakeSegment)
    .join('/');

  if (repairedPath === target.pathname) return value;
  return `${target.protocol}//${target.host}${repairedPath}${target.search}${target.hash}`;
}

function repairEncodedMojibakeSegment(segment) {
  if (!segment) return segment;

  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return segment;
  }

  const repaired = repairUtf8Mojibake(decoded);
  return repaired === decoded ? segment : encodeURIComponent(repaired);
}

function repairUtf8Mojibake(value) {
  // These characters commonly appear when UTF-8 Japanese text is interpreted
  // as Latin-1/Windows-1252. Restricting conversion avoids changing valid names.
  if (!/[ÃÂãçåæä]/u.test(value)) return value;
  if ([...value].some((character) => character.codePointAt(0) > 0xff)) return value;

  const repaired = Buffer.from(value, 'latin1').toString('utf8');
  if (!repaired || repaired.includes('\uFFFD')) return value;
  return mojibakeScore(repaired) < mojibakeScore(value) ? repaired : value;
}

function mojibakeScore(value) {
  return (value.match(/[ÃÂãçåæä]/gu) || []).length;
}

app.use(compression({
  level: 1,
  threshold: 4 * 1024,
  filter(req, res) {
    if (req.headers.range || req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

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
  target = repairMinecraftDownloadUrl(target);
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
// Keep Poki authentication requests consistent with the upstream web origin.
// This does not bypass authentication. A 401 from /sessions/whoami remains the
// correct response when the browser has no valid Poki session cookie.
function applyPokiRequestContext(data) {
  if (!data?.headers || !data.url) return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  if (!POKI_AUTH_HOSTS.has(target.hostname.toLowerCase())) return;

  data.headers.origin = POKI_WEB_ORIGIN;
  data.headers.referer = `${POKI_WEB_ORIGIN}/`;
  data.headers.host = target.host;

  // These browser-facing values describe the proxy origin and can cause an
  // upstream origin check to fail. Let Node generate the actual connection
  // headers while retaining Cookie and Authorization when present.
  delete data.headers['proxy-connection'];
  delete data.headers['sec-fetch-site'];
  delete data.headers['sec-fetch-mode'];
  delete data.headers['sec-fetch-dest'];
}

// Poki auth responses must never be cached. cookieRewrite:true below remains
// responsible for mapping upstream Set-Cookie headers onto the proxy origin.
function normalizePokiAuthResponse(data) {
  if (!data?.headers || !data.url) return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  if (!POKI_AUTH_HOSTS.has(target.hostname.toLowerCase())) return;

  data.headers['cache-control'] = 'private, no-store, max-age=0';
  data.headers.pragma = 'no-cache';
  delete data.headers.expires;

  // Keep redirects from the authentication service inside the proxy.
  if (data.headers.location != null) {
    const rewrite = (value) => {
      if (typeof value !== 'string') return value;
      try {
        const redirected = new URL(value, target);
        return `${PROXY_PREFIX}${redirected.href}`;
      } catch {
        return value;
      }
    };
    data.headers.location = Array.isArray(data.headers.location)
      ? data.headers.location.map(rewrite)
      : rewrite(data.headers.location);
  }

  const status = Number(data.remoteResponse?.statusCode || 0);
  if (status === 401 && target.pathname === '/sessions/whoami') {
    console.info(JSON.stringify({
      type: 'poki-auth-session-missing',
      status,
      path: target.pathname,
      note: 'Expected when no valid Poki session cookie is available'
    }));
  }
}

// Chromium versions that do not recognise attribution-reporting emit a noisy
// console warning. Remove only that unsupported Permissions-Policy directive.
function sanitizePermissionsPolicy(data) {
  if (!data?.headers || data.headers['permissions-policy'] == null) return;
  const values = Array.isArray(data.headers['permissions-policy'])
    ? data.headers['permissions-policy']
    : [data.headers['permissions-policy']];
  const cleaned = values
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !/^attribution-reporting\s*=/i.test(value));
  if (cleaned.length) data.headers['permissions-policy'] = cleaned.join(', ');
  else delete data.headers['permissions-policy'];
}

function applyYouTubeTvUserAgent(data) {
  if (!data?.headers || !data.url) return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  const hostname = target.hostname.toLowerCase();
  const isYouTubeHost = hostname === 'youtube.com' || hostname === 'www.youtube.com';
  if (!isYouTubeHost) return;
  const referer = String(data.headers.referer || '');
  const isTvRequest = target.pathname === '/tv' || target.pathname.startsWith('/tv/');
  const isTvSubrequest = /^https?:\/\/(?:www\.)?youtube\.com\/tv(?:[/?#]|$)/i.test(referer);
  if (!isTvRequest && !isTvSubrequest) return;
  data.headers['user-agent'] = YOUTUBE_TV_USER_AGENT;
  data.headers.origin = 'https://www.youtube.com';
  if (data.headers.referer) data.headers.referer = 'https://www.youtube.com/tv';
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
  const contentDisposition = String(data.headers['content-disposition'] || '').toLowerCase();
  const downloadExtensions = new Set([
    '.mcworld', '.mcpack', '.zip', '.rar', '.7z', '.tar', '.gz',
    '.pdf', '.apk', '.exe', '.msi', '.dmg', '.iso'
  ]);
  const isDownload =
    contentDisposition.includes('attachment') ||
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

// Fallback for hosting environments where /dl/ reaches Express. Cloud Shell may
// reserve /dl/, so the browser-side patch below remains the primary fix there.
app.use((req, res, next) => {
  if (req.path !== '/dl' && req.path !== '/dl/') return next();
  const refererOrigin = getOriginFromProxyReferer(req);
  if (refererOrigin !== 'https://minecraft-mcworld.com' &&
      refererOrigin !== 'https://www.minecraft-mcworld.com') return next();
  let target;
  try {
    target = new URL(req.originalUrl, `${refererOrigin}/`);
  } catch {
    return next();
  }
  req.url = `${PROXY_PREFIX}${target.href}`;
  console.log(JSON.stringify({
    type: 'minecraft-download-navigation',
    originalUrl: req.originalUrl,
    target: target.href
  }));
  next();
});

app.use((req, res, next) => {
  if (req.originalUrl.startsWith(PROXY_PREFIX)) return next();
  if (req.path === '/') return next();
  if (isLocalRoute(req.path)) return next();
  const proxyRefererOrigin = getOriginFromProxyReferer(req);
  const contextCookieOrigin = getOriginFromContextCookie(req);
  // If a Referer exists but cannot be parsed as a proxied page, do not reuse a
  // stale origin cookie from another site.
  const upstreamOrigin = req.get('referer')
    ? proxyRefererOrigin
    : contextCookieOrigin;
  // Relative URLs emitted by the upstream page arrive at this Express app as
  // /textures/..., /cdn-cgi/..., etc. Proxy both navigations and subresources;
  // limiting this to navigations was the reason thumbnails returned local 404s.
  if (!upstreamOrigin) return next();
  let target;
  try {
    target = new URL(req.originalUrl, `${upstreamOrigin}/`);
  } catch {
    return next();
  }
  if (!isHttpOrigin(target)) return next();
  req.url = `${PROXY_PREFIX}${target.href}`;
  next();
});

// Relay selected Bloxd backend APIs directly. On Cloud Shell, allowing
// Unblocker to answer an OPTIONS request with a redirect makes the browser reject
// the preflight. A direct relay keeps the request on this origin and returns CORS
// headers without attempting to bypass any upstream authentication or challenge.
app.use(PROXY_PREFIX, relayBloxdBackendApi);
function relayBloxdBackendApi(req, res, next) {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return next();
  let rawTarget = req.originalUrl.slice(PROXY_PREFIX.length);
  rawTarget = rawTarget.replace(/^(https?):\/(?!\/)/i, '$1://');

  let target;
  try { target = new URL(rawTarget); } catch { return next(); }

  const hostname = target.hostname.toLowerCase();
  const allowedHosts = new Set([
    'firebaseinstallations.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'firebaseremoteconfig.googleapis.com'
  ]);
  if (target.protocol !== 'https:' || !allowedHosts.has(hostname)) return next();

  if (req.method === 'OPTIONS') {
    setRelayCors(req, res);
    return res.status(204).end();
  }

  const headers = Object.create(null);
  const blockedRequestHeaders = new Set([
    'host', 'connection', 'proxy-connection', 'keep-alive',
    'transfer-encoding', 'upgrade', 'origin', 'referer'
  ]);
  for (const [name, value] of Object.entries(req.headers)) {
    if (!blockedRequestHeaders.has(name.toLowerCase()) && value != null) headers[name] = value;
  }
  headers.host = target.host;
  headers.origin = 'https://bloxd.io';
  headers.referer = 'https://bloxd.io/';

  const upstream = https.request(target, {
    method: req.method,
    headers,
    agent: httpsAgent,
    timeout: 30_000
  }, (remote) => {
    const responseHeaders = { ...remote.headers };
    stripHopByHopHeaders(responseHeaders);
    applyRelayCors(req, responseHeaders);
    if (responseHeaders.location) {
      try {
        const redirected = new URL(responseHeaders.location, target);
        if (redirected.protocol === 'https:' && allowedHosts.has(redirected.hostname.toLowerCase())) {
          responseHeaders.location = `${PROXY_PREFIX}${redirected.href}`;
        }
      } catch {}
    }
    res.writeHead(Number(remote.statusCode || 502), responseHeaders);
    if (req.method === 'HEAD') {
      remote.resume();
      res.end();
    } else {
      remote.pipe(res);
    }
  });

  upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
  upstream.once('error', (error) => {
    console.error(JSON.stringify({
      type: 'bloxd-backend-api-error',
      host: hostname,
      code: error.code || 'ERROR',
      path: target.pathname
    }));
    if (!res.headersSent) res.status(502).send('Bad Gateway');
    else res.destroy(error);
  });
  req.once('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

function setRelayCors(req, res) {
  const origin = req.get('origin');
  if (origin) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'content-type,authorization');
  res.set('Access-Control-Max-Age', '600');
  res.set('Vary', 'Origin, Access-Control-Request-Headers');
}

function applyRelayCors(req, headers) {
  const origin = req.get('origin');
  if (!origin) return;
  headers['access-control-allow-origin'] = origin;
  headers['access-control-allow-credentials'] = 'true';
  headers.vary = appendVary(headers.vary, 'Origin');
}

function stripHopByHopHeaders(headers) {
  for (const name of [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade'
  ]) delete headers[name];
}

// Relay Poki authentication directly. Keeping this endpoint out of the generic
// HTML proxy avoids losing Set-Cookie headers and preserves the upstream request
// method/body. Authentication is not bypassed: an anonymous whoami still returns 401.
app.use(PROXY_PREFIX, relayPokiAuthApi);
function relayPokiAuthApi(req, res, next) {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return next();
  let rawTarget = req.originalUrl.slice(PROXY_PREFIX.length);
  rawTarget = rawTarget.replace(/^(https?):\/(?!\/)/i, '$1://');
  let target;
  try { target = new URL(rawTarget); } catch { return next(); }
  if (target.protocol !== 'https:' || !POKI_AUTH_HOSTS.has(target.hostname.toLowerCase())) return next();

  if (req.method === 'OPTIONS') {
    setRelayCors(req, res);
    return res.status(204).end();
  }

  const headers = Object.create(null);
  for (const name of [
    'accept', 'accept-encoding', 'accept-language', 'authorization',
    'content-type', 'content-length', 'user-agent', 'x-csrf-token', 'x-xsrf-token'
  ]) {
    if (req.headers[name] != null) headers[name] = req.headers[name];
  }
  const upstreamCookie = decodePokiAuthCookies(req.headers.cookie);
  if (upstreamCookie) headers.cookie = upstreamCookie;
  headers.host = target.host;
  headers.origin = POKI_WEB_ORIGIN;
  headers.referer = `${POKI_WEB_ORIGIN}/`;

  const upstream = https.request(target, {
    method: req.method,
    headers,
    agent: httpsAgent,
    timeout: 30_000
  }, (remote) => {
    const responseHeaders = { ...remote.headers };
    stripHopByHopHeaders(responseHeaders);
    responseHeaders['cache-control'] = 'private, no-store, max-age=0';
    responseHeaders.pragma = 'no-cache';
    delete responseHeaders.expires;
    applyRelayCors(req, responseHeaders);

    const setCookies = remote.headers['set-cookie'];
    if (setCookies) {
      responseHeaders['set-cookie'] = (Array.isArray(setCookies) ? setCookies : [setCookies])
        .map(encodePokiAuthSetCookie);
    }
    if (responseHeaders.location) {
      try {
        responseHeaders.location = `${PROXY_PREFIX}${new URL(responseHeaders.location, target).href}`;
      } catch {}
    }
    res.writeHead(Number(remote.statusCode || 502), responseHeaders);
    if (req.method === 'HEAD') { remote.resume(); res.end(); }
    else remote.pipe(res);
  });
  upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
  upstream.once('error', (error) => {
    console.error(JSON.stringify({ type: 'poki-auth-api-error', code: error.code || 'ERROR', path: target.pathname }));
    if (!res.headersSent) res.status(502).send('Bad Gateway');
    else res.destroy(error);
  });
  req.once('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

const POKI_AUTH_COOKIE_PREFIX = '__poki_auth__';
function encodePokiAuthSetCookie(cookie) {
  const parts = String(cookie).split(';');
  const first = parts.shift();
  const separator = first.indexOf('=');
  if (separator < 1) return cookie;
  const name = first.slice(0, separator).trim();
  const value = first.slice(separator + 1);
  const attributes = parts
    .map((part) => part.trim())
    .filter((part) => !/^domain=/i.test(part) && !/^path=/i.test(part) && !/^samesite=/i.test(part));
  attributes.push('Path=/');
  attributes.push('SameSite=Lax');
  if (!attributes.some((part) => /^secure$/i.test(part))) attributes.push('Secure');
  return `${POKI_AUTH_COOKIE_PREFIX}${encodeURIComponent(name)}=${value}; ${attributes.join('; ')}`;
}

function decodePokiAuthCookies(header) {
  const cookies = parseCookies(header);
  const result = [];
  for (const [name, value] of Object.entries(cookies)) {
    if (!name.startsWith(POKI_AUTH_COOKIE_PREFIX)) continue;
    let upstreamName;
    try { upstreamName = decodeURIComponent(name.slice(POKI_AUTH_COOKIE_PREFIX.length)); }
    catch { continue; }
    if (upstreamName) result.push(`${upstreamName}=${value}`);
  }
  return result.join('; ');
}

// Relay YouTube TV account APIs directly. Unblocker normalizes a target like
// https://www.youtube.com/... into a 307 Location containing https:/..., which
// breaks POST-based device OAuth and account discovery in a redirect loop.
app.use(PROXY_PREFIX, relayYouTubeTvAccountApi);
function relayYouTubeTvAccountApi(req, res, next) {
  if (!['GET', 'POST', 'OPTIONS'].includes(req.method)) return next();
  let rawTarget = req.originalUrl.slice(PROXY_PREFIX.length);
  rawTarget = rawTarget.replace(/^(https?):\/(?!\/)/i, '$1://');
  let target;
  try { target = new URL(rawTarget); } catch { return next(); }
  const host = target.hostname.toLowerCase();
  if (target.protocol !== 'https:' || (host !== 'youtube.com' && host !== 'www.youtube.com')) return next();
  const allowed = target.pathname === '/o/oauth2/token' ||
    target.pathname.startsWith('/youtubei/v1/account/') ||
    target.pathname.startsWith('/api/lounge/');
  if (!allowed) return next();
  if (req.method === 'OPTIONS') {
    setYouTubeTvCors(req, res);
    return res.status(204).end();
  }
  const headers = Object.create(null);
  const forwarded = [
    'accept', 'accept-encoding', 'accept-language', 'authorization',
    'content-type', 'cookie', 'x-goog-request-time', 'x-goog-visitor-id',
    'x-youtube-client-name', 'x-youtube-client-version',
    'x-youtube-lava-device-context', 'x-youtube-page-cl', 'x-youtube-page-label'
  ];
  for (const name of forwarded) if (req.headers[name] != null) headers[name] = req.headers[name];
  headers.host = target.host;
  headers['user-agent'] = YOUTUBE_TV_USER_AGENT;
  headers.origin = 'https://www.youtube.com';
  headers.referer = 'https://www.youtube.com/tv';
  if (req.headers['content-length'] != null) headers['content-length'] = req.headers['content-length'];
  const upstream = https.request(target, {
    method: req.method,
    headers,
    agent: httpsAgent,
    timeout: 30_000
  }, (remote) => {
    const responseHeaders = { ...remote.headers };
    for (const name of ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']) {
      delete responseHeaders[name];
    }
    // The browser talks to this proxy origin, so expose the API response there.
    const origin = req.get('origin');
    if (origin) {
      responseHeaders['access-control-allow-origin'] = origin;
      responseHeaders['access-control-allow-credentials'] = 'true';
      responseHeaders.vary = appendVary(responseHeaders.vary, 'Origin');
    }
    if (responseHeaders.location) {
      try {
        const redirected = new URL(responseHeaders.location, target);
        if (redirected.protocol === 'https:' &&
            (redirected.hostname === 'youtube.com' || redirected.hostname === 'www.youtube.com')) {
          responseHeaders.location = `${PROXY_PREFIX}${redirected.href}`;
        }
      } catch {}
    }
    res.writeHead(Number(remote.statusCode || 502), responseHeaders);
    remote.pipe(res);
  });
  upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
  upstream.once('error', (error) => {
    console.error(JSON.stringify({ type: 'youtube-tv-account-api-error', code: error.code || 'ERROR', path: target.pathname }));
    if (!res.headersSent) res.status(502).send('Bad Gateway');
    else res.destroy(error);
  });
  req.once('aborted', () => upstream.destroy());
  req.pipe(upstream);
}
function setYouTubeTvCors(req, res) {
  const origin = req.get('origin');
  if (origin) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'content-type,authorization');
  res.set('Vary', 'Origin, Access-Control-Request-Headers');
}
function appendVary(current, value) {
  const values = String(current || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  return values.join(', ');
}

// MCPEDL loads many Nuxt chunks simultaneously. Relay only its static assets
// directly and retry one safe GET/HEAD once on transient upstream failures.
app.use(PROXY_PREFIX, relayMcpedlStaticAsset);

function relayMcpedlStaticAsset(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let target;
  try {
    target = new URL(req.originalUrl.slice(PROXY_PREFIX.length));
  } catch {
    return next();
  }
  const host = target.hostname.toLowerCase();
  if (target.protocol !== 'https:' || (host !== 'mcpedl.com' && host !== 'www.mcpedl.com')) return next();
  if (!target.pathname.startsWith('/_nuxt/') && !target.pathname.startsWith('/js/') && !target.pathname.startsWith('/web/')) return next();
  if (!/\.(?:js|mjs|css|map|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|ico)$/i.test(target.pathname)) return next();
  requestMcpedlStatic(target, req, res, Date.now(), 0);
}

function requestMcpedlStatic(target, req, res, startedAt, attempt) {
  if (res.headersSent || res.destroyed) return;
  const headers = Object.create(null);
  for (const name of ['accept','accept-encoding','accept-language','cache-control','if-modified-since','if-none-match','range','user-agent']) {
    if (req.headers[name] != null) headers[name] = req.headers[name];
  }
  headers.host = target.host;
  headers.referer = `${target.origin}/`;

  const upstream = https.request(target, { method: req.method, headers, agent: httpsAgent, timeout: 20_000 }, (remote) => {
    const status = Number(remote.statusCode || 502);
    if (attempt === 0 && [502, 503, 504].includes(status)) {
      remote.resume();
      remote.once('end', () => setTimeout(() => requestMcpedlStatic(target, req, res, startedAt, 1), 150));
      return;
    }
    const responseHeaders = { ...remote.headers };
    for (const name of ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']) delete responseHeaders[name];
    if (responseHeaders.location != null) responseHeaders.location = sanitizeLocationValue(responseHeaders.location);
    res.writeHead(status, responseHeaders);
    if (req.method === 'HEAD') { remote.resume(); res.end(); } else remote.pipe(res);
    remote.once('end', () => console.log(JSON.stringify({ type:'mcpedl-static', status, attempt, elapsedMs:Date.now()-startedAt, path:target.pathname })));
  });
  upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code:'ETIMEDOUT' })));
  upstream.once('error', (error) => {
    if (attempt === 0 && !res.headersSent) {
      console.warn(JSON.stringify({ type:'mcpedl-static-retry', code:error.code || 'ERROR', path:target.pathname }));
      setTimeout(() => requestMcpedlStatic(target, req, res, startedAt, 1), 150);
    } else if (!res.headersSent) {
      console.error(JSON.stringify({ type:'mcpedl-static-error', code:error.code || 'ERROR', message:error.message, path:target.pathname }));
      res.status(502).send('Bad Gateway');
    } else res.destroy(error);
  });
  req.once('aborted', () => upstream.destroy());
  upstream.end();
}

const unblocker = new Unblocker({
  prefix: PROXY_PREFIX,
  cookieRewrite: true,
  redirectFollow: true,
  clientScripts: true,
  httpAgent,
  httpsAgent,
  requestMiddleware: [cleanProxyRequest, applyPokiRequestContext, applyYouTubeTvUserAgent],
  responseMiddleware: [
    repairMalformedProxyLocation,
    normalizePokiAuthResponse,
    sanitizePermissionsPolicy,
    repairMinecraftDownloadRedirect,
    keepYouTubeTvRedirectInsideProxy,
    sanitizeProxyResponseHeaders,
    rememberDocumentOrigin,
    preserveDownloadResponse,
    addConservativeAssetCache
  ]
});

// Prefer the package's local browser helper. If its layout differs, fall back
// to Unblocker's own route instead of returning a false 404.
const unblockerClientPath = findUnblockerClientScript();
let unblockerClientSource = null;
if (unblockerClientPath) {
  try {
    unblockerClientSource = patchUnblockerClientForUrlObjects(
      fs.readFileSync(unblockerClientPath, 'utf8')
    );
  } catch (error) {
    console.error('Unable to load unblocker client script:', error.message);
  }
}

// YouTube TV uses Trusted Types and may assign TrustedScriptURL objects to
// script.src. Older unblocker clients assume src is always a string and crash
// in fixUrl() when they call urlStr.substr(...). Coerce the value at the start
// of fixUrl so both strings and URL-like Trusted Types values are supported.
function patchUnblockerClientForUrlObjects(source) {
  let patched = String(source || '');

  // note uses Next.js/webpack and can pass URL, TrustedScriptURL, TrustedURL,
  // or other string-like values to script/link setters. Older unblocker builds
  // call string-only methods directly, which aborts hydration on note.
  const declarations = [
    /(function\s+fixUrl\s*\(\s*urlStr\b[^)]*\)\s*\{)/,
    /(fixUrl\s*=\s*function\s*\(\s*urlStr\b[^)]*\)\s*\{)/,
    /((?:const|let|var)\s+fixUrl\s*=\s*\(\s*urlStr\b[^)]*\)\s*=>\s*\{)/
  ];

  for (const declaration of declarations) {
    if (declaration.test(patched)) {
      patched = patched.replace(declaration, '$1\n    urlStr = String(urlStr);');
      break;
    }
  }

  // Cover minified/transformed variants and other string-only operations.
  patched = patched
    .replace(/urlStr\.substr\(/g, 'String(urlStr).substr(')
    .replace(/urlStr\.substring\(/g, 'String(urlStr).substring(')
    .replace(/urlStr\.startsWith\(/g, 'String(urlStr).startsWith(')
    .replace(/urlStr\.indexOf\(/g, 'String(urlStr).indexOf(');

  return patched;
}

function sendPatchedUnblockerClient(req, res, next) {
  if (!unblockerClientSource) return next();
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  // Do not let a previously cached, unpatched helper keep breaking note.
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(`${unblockerClientSource}\n${BLOXD_RELATIVE_RESOURCE_PATCH}\n${GLOBAL_PROXIED_NAVIGATION_PATCH}\n${MINECRAFT_DOWNLOAD_NAVIGATION_PATCH}\n${YOUTUBE_TV_WATERMARK_PATCH}\n${MCPEDL_CLIENT_RECOVERY}\n${POKI_SPA_ROUTE_PATCH}`);
}

// Different unblocker releases emit either path. Register both before
// app.use(unblocker), so note always receives the patched browser helper.
app.get(`${PROXY_PREFIX}client/unblocker-client.js`, sendPatchedUnblockerClient);
app.get(`${PROXY_PREFIX}unblocker-client.js`, sendPatchedUnblockerClient);

// Keep top-level link navigation inside the proxy. Unblocker's URL wrappers
// cover many DOM assignments, but sites such as DuckDuckGo can install a
// direct absolute result URL after rendering. Capture navigation gestures and
// normalize those links before the browser leaves this origin.
const BLOXD_RELATIVE_RESOURCE_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';
  function upstream() {
    var path = String(window.location.pathname || '');
    if (path.indexOf(PREFIX) !== 0) return null;
    var raw = path.slice(PREFIX.length) + String(window.location.search || '');
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');
    try { return new URL(raw); } catch (error) { return null; }
  }
  function fix(value) {
    if (typeof value !== 'string' || value.charAt(0) !== '/' || value.indexOf('//') === 0 || value.indexOf(PREFIX) === 0) return value;
    var base = upstream();
    if (!base) return value;
    try { return PREFIX + new URL(value, base.origin).href; } catch (error) { return value; }
  }
  function rewrite(root) {
    if (!root || root.nodeType !== 1) return;
    var nodes = [root];
    if (root.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll('[src],[href],[poster]')));
    for (var i = 0; i < nodes.length; i += 1) {
      for (var j = 0; j < 3; j += 1) {
        var attr = ['src', 'href', 'poster'][j];
        if (!nodes[i].hasAttribute || !nodes[i].hasAttribute(attr)) continue;
        var before = nodes[i].getAttribute(attr);
        var after = fix(before);
        if (after !== before) nodes[i].setAttribute(attr, after);
      }
    }
  }
  function start() {
    rewrite(document.documentElement);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        if (records[i].type === 'attributes') rewrite(records[i].target);
        for (var j = 0; j < records[i].addedNodes.length; j += 1) rewrite(records[i].addedNodes[j]);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'poster'] });
  }
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

const GLOBAL_PROXIED_NAVIGATION_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';

  function upstreamPageUrl() {
    var path = String(window.location.pathname || '');
    if (path.indexOf(PREFIX) !== 0) return null;
    var raw = path.slice(PREFIX.length) + String(window.location.search || '') + String(window.location.hash || '');
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');
    try {
      var url = new URL(raw);
      return /^https?:$/.test(url.protocol) ? url : null;
    } catch (error) {
      return null;
    }
  }

  function unwrapDuckDuckGoRedirect(url) {
    var host = String(url.hostname || '').toLowerCase();
    if (host !== 'duckduckgo.com' && host !== 'www.duckduckgo.com' && host !== 'links.duckduckgo.com') return url;
    var encoded = url.searchParams.get('uddg');
    if (!encoded) return url;
    try {
      var destination = new URL(encoded);
      if (/^https?:$/.test(destination.protocol)) return destination;
    } catch (error) {}
    return url;
  }

  function proxiedHref(anchor) {
    if (!anchor || !anchor.getAttribute) return null;
    var raw = anchor.getAttribute('href');
    if (!raw || raw.charAt(0) === '#' || /^(?:javascript|mailto|tel|data|blob):/i.test(raw)) return null;
    if (raw.indexOf(PREFIX) === 0) return null;

    var upstream = upstreamPageUrl();
    if (!upstream) return null;

    var target;
    try {
      target = new URL(raw, upstream);
    } catch (error) {
      return null;
    }
    if (!/^https?:$/.test(target.protocol)) return null;
    target = unwrapDuckDuckGoRedirect(target);
    return PREFIX + target.href;
  }

  function rewriteAnchor(event) {
    var node = event.target;
    var anchor = node && node.closest ? node.closest('a[href]') : null;
    if (!anchor) return;
    var fixed = proxiedHref(anchor);
    if (fixed) anchor.setAttribute('href', fixed);
  }

  // pointerdown/mousedown makes middle-click, Ctrl/Cmd-click and context-menu
  // "open in new tab" see the rewritten href before the browser navigates.
  document.addEventListener('pointerdown', rewriteAnchor, true);
  document.addEventListener('mousedown', rewriteAnchor, true);
  document.addEventListener('contextmenu', rewriteAnchor, true);
  document.addEventListener('click', rewriteAnchor, true);
  document.addEventListener('auxclick', rewriteAnchor, true);
})();`;
// Cloud Shell reserves the top-level /dl/ path. Crafters Colony's original
// download_bt_func navigates there, so intercept the gesture before the site's
// inline onclick handler and navigate directly to the proxied upstream /dl/.
const MINECRAFT_DOWNLOAD_NAVIGATION_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';

  function upstreamPageUrl() {
    var path = String(window.location.pathname || '');
    if (path.indexOf(PREFIX) !== 0) return null;
    var raw = path.slice(PREFIX.length) + String(window.location.search || '');
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');
    try {
      var url = new URL(raw);
      return /^https?:$/.test(url.protocol) ? url : null;
    } catch (error) {
      return null;
    }
  }

  function isMinecraftPage() {
    var upstream = upstreamPageUrl();
    if (!upstream) return false;
    var host = String(upstream.hostname || '').toLowerCase();
    return host === 'minecraft-mcworld.com' || host === 'www.minecraft-mcworld.com';
  }

  function downloadUrl(postid, type) {
    var target = new URL('https://minecraft-mcworld.com/dl/');
    target.searchParams.set('postid', String(postid));
    target.searchParams.set('type', String(type == null ? 0 : type));
    return PREFIX + target.href;
  }

  function parseInvocation(node) {
    var clickable = node && node.closest
      ? node.closest('[onclick*="download_bt_func"]')
      : null;
    if (!clickable) return null;
    var source = String(clickable.getAttribute('onclick') || '');
    var match = source.match(/download_bt_func\s*\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*\)/);
    return match ? { postid: match[1], type: match[2] } : null;
  }

  // Capture phase runs before the page's inline onclick handler.
  document.addEventListener('click', function (event) {
    if (!isMinecraftPage()) return;
    var invocation = parseInvocation(event.target);
    if (!invocation) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    var destination = downloadUrl(invocation.postid, invocation.type);
    console.info('[proxy] Minecraft download navigation:', destination);
    window.location.assign(destination);
  }, true);

  // Also replace the global function for keyboard/programmatic invocations.
  var attempts = 0;
  function installFunctionPatch() {
    attempts += 1;
    if (!isMinecraftPage()) return;
    var original = window.download_bt_func;
    if (typeof original === 'function' && !original.__proxyDownloadPatched) {
      function patched(postid, type) {
        window.location.assign(downloadUrl(postid, type));
      }
      patched.__proxyDownloadPatched = true;
      patched.__proxyOriginal = original;
      window.download_bt_func = patched;
      return;
    }
    if (attempts < 300) window.setTimeout(installFunctionPatch, 100);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installFunctionPatch, { once: true });
  } else {
    installFunctionPatch();
  }
})();`;

// YouTube TV inserts <yt-debug-watermark> when the current host is not an
// approved debug-access domain. This UI-only patch removes that warning node
// and watches for later re-insertion by client-side rendering.
const YOUTUBE_TV_WATERMARK_PATCH = String.raw`;(function () {
  'use strict';
  // Keep the post-login /tv return URL on the proxy origin. YouTube may use an
  // absolute top-level navigation which cannot be fixed by response headers.
  function proxyYouTubeTvUrl(value) {
    try {
      var url = new URL(String(value), 'https://www.youtube.com');
      if ((url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com') &&
          (url.pathname === '/tv' || url.pathname.indexOf('/tv/') === 0)) {
        return '/proxy/' + url.href;
      }
    } catch (error) {}
    return value;
  }
  document.addEventListener('click', function (event) {
    var element = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!element) return;
    var fixed = proxyYouTubeTvUrl(element.getAttribute('href'));
    if (fixed !== element.getAttribute('href')) element.setAttribute('href', fixed);
  }, true);
  function isYouTubeTvPage() {
    var path = String(window.location.pathname || '').toLowerCase();
    return path.indexOf('/proxy/https://www.youtube.com/tv') === 0 ||
      path.indexOf('/proxy/https://youtube.com/tv') === 0;
  }
  if (!isYouTubeTvPage()) return;
  function removeDebugWatermarks(root) {
    if (!root) return;
    if (root.nodeType === 1 && root.matches && root.matches('yt-debug-watermark')) {
      root.remove();
      return;
    }
    if (!root.querySelectorAll) return;
    var nodes = root.querySelectorAll('yt-debug-watermark');
    for (var i = 0; i < nodes.length; i += 1) nodes[i].remove();
  }
  function start() {
    removeDebugWatermarks(document);
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j += 1) removeDebugWatermarks(added[j]);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

// MCPEDL marks the home-page Nuxt fetch as client-only. When its cached SSR
// response contains frontpageV2=null, hydration can leave all shelves empty.
// Retry the site's own Vuex action after Nuxt is ready. The existing XHR/fetch
// wrappers proxy the api.mcpedl.com request through this server.
// Poki's client router reads the proxy-visible pathname after hydration.
// It initially renders the upstream /jp page from server state, then interprets
// /proxy/https://poki.com/jp as a Poki route and replaces the page with its 404.
// Preserve the successfully rendered home view and restore it if that specific
// false 404 is mounted. Links remain normal anchors and are handled by the
// existing proxy navigation patch.
const POKI_SPA_ROUTE_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';
  var path = String(window.location.pathname || '');
  var lower = path.toLowerCase();
  if (lower.indexOf(PREFIX + 'https://poki.com/') !== 0 &&
      lower.indexOf(PREFIX + 'https://www.poki.com/') !== 0) return;

  // The language redirect adds a tracking fragment. It is not part of the
  // upstream route and can trigger an unnecessary POP navigation.
  if (/^#utm_/i.test(String(window.location.hash || ''))) {
    try {
      history.replaceState(history.state, document.title,
        window.location.pathname + window.location.search);
    } catch (error) {}
  }

  var savedMarkup = '';
  var restoring = false;
  var settled = false;

  function isRealHome(root) {
    return !!root && !root.querySelector('#pageError') &&
      !!(root.querySelector('[id^="pageHome"]') ||
         root.querySelector('.summaryTile') ||
         root.querySelector('a[href*="/g/"]'));
  }

  function capture(root) {
    if (!savedMarkup && isRealHome(root)) {
      savedMarkup = root.innerHTML;
      console.info('[proxy] captured Poki page before client-route hydration');
    }
  }

  function repair() {
    if (restoring || settled) return;
    var root = document.getElementById('app-root');
    if (!root) return;
    capture(root);
    if (!root.querySelector('#pageError') || !savedMarkup) return;

    restoring = true;
    root.innerHTML = savedMarkup;
    settled = true;
    restoring = false;
    document.title = 'Poki';
    console.info('[proxy] prevented false Poki 404 caused by proxy pathname');
  }

  function start() {
    var root = document.getElementById('app-root');
    if (!root) {
      window.setTimeout(start, 10);
      return;
    }
    capture(root);
    var observer = new MutationObserver(function () {
      repair();
      if (settled) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    // Poll briefly as a fallback for frameworks that replace the root quickly.
    var attempts = 0;
    var timer = window.setInterval(function () {
      attempts += 1;
      repair();
      if (settled || attempts >= 400) window.clearInterval(timer);
    }, 10);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();`;

const MCPEDL_CLIENT_RECOVERY = String.raw`;(function () {
  'use strict';

  if (window.location.pathname.toLowerCase().indexOf('mcpedl.com') === -1) return;

  var tries = 0;
  var maxTries = 80;
  var running = false;
  var completed = false;

  function hasFrontpage(store) {
    var submission = store && store.state && store.state.submission;
    var value = submission && submission.frontpageV2;
    return !!(value && value.shelves);
  }

  function recover() {
    if (completed || running) return;
    tries += 1;

    var nuxt = window.$nuxt;
    var store = nuxt && nuxt.$store;
    if (!store || typeof store.dispatch !== 'function') {
      if (tries < maxTries) window.setTimeout(recover, 250);
      return;
    }

    if (hasFrontpage(store)) {
      completed = true;
      return;
    }

    running = true;
    Promise.resolve(store.dispatch('submission/fetchFrontpageV2'))
      .then(function () {
        running = false;
        if (hasFrontpage(store)) {
          completed = true;
          console.info('[proxy] MCPEDL front page recovered');
          return;
        }
        if (tries < maxTries) window.setTimeout(recover, 750);
      })
      .catch(function (error) {
        running = false;
        console.warn('[proxy] MCPEDL front page retry failed', error);
        if (tries < maxTries) window.setTimeout(recover, 1000);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', recover, { once: true });
  } else {
    recover();
  }
})();`;

function findUnblockerClientScript() {
  let entry;
  try { entry = require.resolve('unblocker'); } catch { return null; }
  let root = path.dirname(entry);
  for (let i = 0; i < 8 && path.dirname(root) !== root; i += 1) {
    if (fs.existsSync(path.join(root, 'package.json'))) break;
    root = path.dirname(root);
  }
  return findNamedFile(root, 'unblocker-client.js', 5);
}

function findNamedFile(directory, filename, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) if (entry.isFile() && entry.name === filename) return path.join(directory, filename);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const found = findNamedFile(path.join(directory, entry.name), filename, depth - 1);
    if (found) return found;
  }
  return null;
}

app.use(unblocker);

app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).send('ok');
});

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
