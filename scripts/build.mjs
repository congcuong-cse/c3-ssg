#!/usr/bin/env node
/**
 * c3-ssg build: copy the source folder into dist/ and prepare it for
 * production hosting.
 *
 *   - Mirrors public/ → dist/ (clean rebuild)
 *   - Precompresses text assets to .br and .gz (servers/CDNs serve these directly)
 *   - Emits .nojekyll so GitHub Pages serves _underscore paths verbatim
 *   - Writes build-manifest.json (file list + sizes) for debugging
 *
 * Usage: node scripts/build.mjs [--src public] [--out dist]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, [])
);

const SRC = path.resolve(args.src || 'public');
const OUT = path.resolve(args.out || 'dist');
const COMPRESS_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.xml', '.txt', '.map', '.webmanifest']);
const MIN_COMPRESS_BYTES = 1024; // don't bother compressing tiny files

async function walk(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === '.DS_Store') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

async function main() {
  const srcStat = await fs.stat(SRC).catch(() => null);
  if (!srcStat || !srcStat.isDirectory()) {
    console.error(`✗ source folder not found: ${SRC}`);
    process.exit(1);
  }

  // Clean rebuild.
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const files = await walk(SRC);
  if (files.length === 0) {
    console.error(`✗ no files found in ${SRC}`);
    process.exit(1);
  }

  const manifest = [];
  let compressedCount = 0;

  for (const rel of files) {
    const from = path.join(SRC, rel);
    const to = path.join(OUT, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    const data = await fs.readFile(from);
    await fs.writeFile(to, data);

    const ext = path.extname(rel).toLowerCase();
    let compressed = false;
    if (COMPRESS_EXT.has(ext) && data.length >= MIN_COMPRESS_BYTES) {
      const [br, gz] = await Promise.all([
        brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
        gzip(data, { level: 9 }),
      ]);
      // Only keep precompressed variants when they actually shrink the file.
      if (br.length < data.length) { await fs.writeFile(to + '.br', br); compressed = true; }
      if (gz.length < data.length) { await fs.writeFile(to + '.gz', gz); compressed = true; }
      if (compressed) compressedCount++;
    }
    manifest.push({ path: rel.split(path.sep).join('/'), bytes: data.length, compressed });
  }

  // GitHub Pages: disable Jekyll so files/dirs starting with _ are served.
  await fs.writeFile(path.join(OUT, '.nojekyll'), '');

  await fs.writeFile(
    path.join(OUT, 'build-manifest.json'),
    JSON.stringify({ builtFrom: path.basename(SRC), files: manifest.length, manifest }, null, 2)
  );

  const totalBytes = manifest.reduce((n, f) => n + f.bytes, 0);
  console.log(`✓ built ${OUT}`);
  console.log(`  ${manifest.length} files, ${(totalBytes / 1024).toFixed(1)} KiB, ${compressedCount} precompressed (.br/.gz)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
