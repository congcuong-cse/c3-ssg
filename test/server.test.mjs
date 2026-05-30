import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

// Build a temp site and boot the server against it.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'c3ssg-'));
await fs.mkdir(path.join(tmp, 'assets'), { recursive: true });
await fs.writeFile(path.join(tmp, 'index.html'), '<!doctype html><body>home</body>');
await fs.writeFile(path.join(tmp, '404.html'), '<!doctype html><body>missing</body>');
await fs.writeFile(path.join(tmp, 'about.html'), '<!doctype html><body>about</body>');
await fs.writeFile(path.join(tmp, 'assets', 'app.css'), 'body{color:red}'.repeat(200));

process.env.ROOT = tmp;
process.env.PORT = '0';
const { server, resolvePath, contentType, cacheControl } = await import('../server.mjs');

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

function req(pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + pathname, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('serves index.html at /', async () => {
  const res = await req('/');
  assert.equal(res.status, 200);
  assert.match(res.body, /home/);
  assert.match(res.headers['content-type'], /text\/html/);
});

test('clean URL resolves to .html', async () => {
  const res = await req('/about');
  assert.equal(res.status, 200);
  assert.match(res.body, /about/);
});

test('custom 404 page for unknown path', async () => {
  const res = await req('/nope');
  assert.equal(res.status, 404);
  assert.match(res.body, /missing/);
});

test('path traversal is blocked', async () => {
  const res = await req('/../../etc/passwd');
  assert.equal(res.status, 404);
});

test('dotfiles are not served', async () => {
  await fs.writeFile(path.join(tmp, '.secret'), 'nope');
  const res = await req('/.secret');
  assert.equal(res.status, 404);
});

test('conditional request returns 304', async () => {
  const first = await req('/');
  const res = await req('/', { headers: { 'If-None-Match': first.headers.etag } });
  assert.equal(res.status, 304);
});

test('brotli precompressed / on-the-fly negotiation', async () => {
  const res = await req('/assets/app.css', { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'br');
});

test('security headers present', async () => {
  const res = await req('/');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
});

test('disallowed method returns 405', async () => {
  const res = await req('/', { method: 'POST' });
  assert.equal(res.status, 405);
});

test('range request returns 206 with content-range', async () => {
  const res = await req('/assets/app.css', { headers: { Range: 'bytes=0-9' } });
  assert.equal(res.status, 206);
  assert.match(res.headers['content-range'], /^bytes 0-9\//);
});

test('unit: resolvePath rejects traversal, accepts normal', () => {
  assert.equal(resolvePath('/../../etc/passwd'), null);
  assert.ok(resolvePath('/index.html'));
});

test('unit: cacheControl immutable for hashed assets', () => {
  assert.match(cacheControl('app.a1b2c3d4.js', contentType('x.js')), /immutable/);
  assert.equal(cacheControl('page.html', 'text/html; charset=utf-8'), 'no-cache');
});

test.after(() => { server.close(); });
