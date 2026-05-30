#!/usr/bin/env node
/**
 * c3-ssg — a zero-dependency, production-grade static file server.
 *
 * Serves a folder of HTML and assets with sane production defaults:
 *   - Correct MIME types, ETag / Last-Modified, conditional 304 responses
 *   - Smart Cache-Control (immutable for fingerprinted assets, revalidate for HTML)
 *   - Brotli/gzip: serves precompressed .br/.gz when present, else compresses text on the fly
 *   - HTTP range requests (streaming media, resumable downloads)
 *   - Security headers and path-traversal / dotfile protection
 *   - Custom 404.html, optional SPA fallback, graceful shutdown
 *   - Optional dev live-reload (--watch)
 *
 * Usage:
 *   node server.mjs [--root dir] [--port n] [--host h] [--spa] [--watch] [--no-cache]
 * Env: PORT, HOST, ROOT, SPA=true
 */
import http from 'node:http';
import { promises as fs, createReadStream, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[key] = true;
    else { o[key] = next; i++; }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const truthy = (v) => v === true || v === 'true' || v === '1';

const ROOT = path.resolve(args.root || process.env.ROOT || 'dist');
const PORT = Number(args.port || process.env.PORT || 8080);
const HOST = args.host || process.env.HOST || '0.0.0.0';
// SPA fallback: off by default; enabled by --spa or SPA=true; --spa-off forces off.
const SPA = !truthy(args['spa-off']) && (truthy(args.spa) || truthy(process.env.SPA));
const NO_CACHE = truthy(args['no-cache']);
const WATCH = truthy(args.watch);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.zip': 'application/zip',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set([
  'text/html', 'text/css', 'text/javascript', 'application/json',
  'application/xml', 'image/svg+xml', 'text/plain', 'application/manifest+json',
]);
// Extensions whose content is fingerprinted by build tools → safe to cache forever.
const HASHED = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i;

const LIVERELOAD_PATH = '/__c3_livereload';
const liveClients = new Set();

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function cacheControl(file, type) {
  if (NO_CACHE) return 'no-store';
  if (type.startsWith('text/html')) return 'no-cache';
  if (HASHED.test(file)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600, must-revalidate';
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
}

function etagOf(stat) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/** Resolve a URL path to an absolute file path inside ROOT, or null if unsafe. */
function resolvePath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); }
  catch { return null; }
  // Reject dotfiles / dotdirs (.git, .env, .htaccess, …) but allow .well-known.
  const segments = decoded.split('/').filter(Boolean);
  for (const s of segments) {
    if (s.startsWith('.') && s !== '.well-known') return null;
  }
  const resolved = path.resolve(ROOT, '.' + path.posix.normalize('/' + decoded));
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null; // traversal
  return resolved;
}

async function statFile(p) {
  try {
    const s = await fs.stat(p);
    return s.isDirectory() ? null : s;
  } catch { return null; }
}

/** Find the file to serve for a request path. Returns {file, stat} or null. */
async function locate(urlPath) {
  const base = resolvePath(urlPath);
  if (base === null) return null;

  let s = await statFile(base);
  if (s) return { file: base, stat: s };

  // Directory → index.html
  try {
    const dirStat = await fs.stat(base);
    if (dirStat.isDirectory()) {
      const idx = path.join(base, 'index.html');
      s = await statFile(idx);
      if (s) return { file: idx, stat: s };
    }
  } catch { /* not a dir */ }

  // Extensionless → try .html (clean URLs)
  if (!path.extname(base)) {
    s = await statFile(base + '.html');
    if (s) return { file: base + '.html', stat: s };
  }
  return null;
}

function chooseEncoding(acceptEncoding = '') {
  const ae = acceptEncoding.toLowerCase();
  if (ae.includes('br')) return 'br';
  if (ae.includes('gzip')) return 'gzip';
  return null;
}

function injectLiveReload(html) {
  const snippet = `<script>(function(){try{var s=new EventSource('${LIVERELOAD_PATH}');s.onmessage=function(e){if(e.data==='reload')location.reload();};}catch(_){}})();</script>`;
  return html.includes('</body>')
    ? html.replace('</body>', snippet + '</body>')
    : html + snippet;
}

async function sendFile(req, res, file, stat, status = 200) {
  const type = contentType(file);
  const etag = etagOf(stat);
  const lastMod = stat.mtime.toUTCString();

  securityHeaders(res);
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', cacheControl(file, type));
  res.setHeader('Last-Modified', lastMod);
  res.setHeader('ETag', etag);

  // Conditional request handling.
  const inm = req.headers['if-none-match'];
  const ims = req.headers['if-modified-since'];
  if ((inm && inm === etag) || (ims && new Date(ims) >= new Date(lastMod))) {
    res.writeHead(304);
    return res.end();
  }

  res.setHeader('Content-Type', type);
  const isHTML = type.startsWith('text/html');
  const wantLive = WATCH && isHTML;

  // HTML in dev: read, inject live-reload, send (small files, fine to buffer).
  if (wantLive) {
    const buf = await fs.readFile(file);
    const out = Buffer.from(injectLiveReload(buf.toString('utf8')), 'utf8');
    res.setHeader('Content-Length', out.length);
    res.writeHead(status);
    return res.end(req.method === 'HEAD' ? undefined : out);
  }

  // Range requests (media seeking / resumable downloads). No range when compressing.
  const range = req.headers.range;
  const encoding = chooseEncoding(req.headers['accept-encoding']);
  const compressible = COMPRESSIBLE.has(type.split(';')[0]);

  if (range && !(compressible && encoding)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end = m[2] === '' ? null : parseInt(m[2], 10);
      const size = stat.size;
      if (start === null) { start = size - end; end = size - 1; }
      else if (end === null) { end = size - 1; }
      if (start > end || start < 0 || end >= size) {
        res.setHeader('Content-Range', `bytes */${size}`);
        res.writeHead(416);
        return res.end();
      }
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      res.writeHead(206);
      if (req.method === 'HEAD') return res.end();
      return createReadStream(file, { start, end }).pipe(res);
    }
  }
  res.setHeader('Accept-Ranges', 'bytes');

  // Serve precompressed sibling (.br/.gz) if the build produced one.
  if (compressible && encoding) {
    const ext = encoding === 'br' ? '.br' : '.gz';
    const pre = await statFile(file + ext);
    if (pre) {
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', pre.size);
      res.writeHead(status);
      if (req.method === 'HEAD') return res.end();
      return createReadStream(file + ext).pipe(res);
    }
    // On-the-fly compression for text assets (no precompressed sibling).
    res.setHeader('Content-Encoding', encoding);
    res.writeHead(status);
    if (req.method === 'HEAD') return res.end();
    const comp = encoding === 'br'
      ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
      : zlib.createGzip({ level: 6 });
    return createReadStream(file).pipe(comp).pipe(res);
  }

  // Plain identity response.
  res.setHeader('Content-Length', stat.size);
  res.writeHead(status);
  if (req.method === 'HEAD') return res.end();
  return createReadStream(file).pipe(res);
}

async function send404(req, res) {
  const custom = path.join(ROOT, '404.html');
  const s = await statFile(custom);
  if (s) {
    res.statusCode = 404;
    return sendFile(req, res, custom, s, 404);
  }
  securityHeaders(res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found\n');
}

const server = http.createServer(async (req, res) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    process.stdout.write(`${req.method} ${req.url} → ${res.statusCode} (${ms.toFixed(1)}ms)\n`);
  });

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain' });
      return res.end('405 Method Not Allowed\n');
    }

    // Live-reload SSE channel (dev only).
    if (WATCH && req.url.split('?')[0] === LIVERELOAD_PATH) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      liveClients.add(res);
      req.on('close', () => liveClients.delete(res));
      return;
    }

    const found = await locate(req.url);
    if (found) return sendFile(req, res, found.file, found.stat);

    // SPA fallback: serve index.html for unknown non-asset routes.
    if (SPA && !path.extname(req.url.split('?')[0])) {
      const idx = path.join(ROOT, 'index.html');
      const s = await statFile(idx);
      if (s) return sendFile(req, res, idx, s);
    }
    return send404(req, res);
  } catch (err) {
    process.stderr.write(`500 ${req.url}: ${err && err.stack ? err.stack : err}\n`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('500 Internal Server Error\n');
    } else res.destroy();
  }
});

// Dev file watcher → push reload events.
if (WATCH) {
  let timer = null;
  try {
    fsWatch(ROOT, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const c of liveClients) c.write('data: reload\n\n');
      }, 80);
    });
  } catch {
    process.stderr.write('watch: recursive fs.watch unsupported on this platform; live-reload disabled\n');
  }
}

server.listen(PORT, HOST, async () => {
  const exists = await fs.stat(ROOT).then(() => true).catch(() => false);
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  process.stdout.write(`\nc3-ssg serving ${ROOT}${exists ? '' : '  (⚠ directory not found — did you run `npm run build`?)'}\n`);
  process.stdout.write(`  → http://${shown}:${PORT}/${WATCH ? '   (watch + live-reload on)' : ''}${SPA ? '   [SPA fallback]' : ''}\n\n`);
});

// Graceful shutdown.
function shutdown(sig) {
  process.stdout.write(`\n${sig} received, closing server…\n`);
  for (const c of liveClients) try { c.end(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { server, resolvePath, contentType, cacheControl };
