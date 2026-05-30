# c3-ssg

Production-ready static hosting. **Put your site in `public/`, run one command to serve it, push to deploy it free.** Zero runtime dependencies.

## Quick start

```bash
npm run dev        # serve public/ with live-reload at http://localhost:8080
npm run build      # produce optimized dist/ (precompressed .br/.gz)
npm run preview    # build + serve dist/ exactly as production does
npm start          # serve dist/ (what hosts run)
npm test           # run the server test suite
```

No `npm install` needed — the server and build use only the Node.js standard library (Node ≥ 18).

## Project layout

```
public/              ← your website — edit this
  index.html
  about.html
  404.html           ← served on not-found
  styles.css  app.js
  assets/            ← images, fonts, fingerprinted bundles
  robots.txt  site.webmanifest
dist/                ← generated build output (git-ignored)
server.mjs           ← production static server
scripts/build.mjs    ← build + precompression
```

Anything you drop in `public/` is part of the site. Subfolders, images, fonts — all served.

## The server (`server.mjs`)

A small, hardened static server with production defaults:

- **MIME types**, `ETag` + `Last-Modified`, conditional **304** responses
- **Cache-Control**: `no-cache` for HTML, `immutable` 1-year for fingerprinted assets (`app.1a2b3c4d.js`), short revalidate otherwise
- **Brotli / gzip**: serves precompressed `.br`/`.gz` siblings when present, else compresses text on the fly
- **HTTP range requests** for media streaming / resumable downloads
- **Security**: path-traversal & dotfile blocking, `nosniff`, `X-Frame-Options`, `Referrer-Policy`, GET/HEAD only
- **Clean URLs** (`/about` → `about.html`), custom `404.html`, optional **SPA fallback**
- **Graceful shutdown** on SIGINT/SIGTERM, request logging, optional dev **live-reload**

### Options

| Flag / Env | Default | Meaning |
|---|---|---|
| `--root <dir>` / `ROOT` | `dist` | Directory to serve |
| `--port <n>` / `PORT` | `8080` | Listen port |
| `--host <h>` / `HOST` | `0.0.0.0` | Listen host |
| `--spa` / `SPA=true` | off | Serve `index.html` for unknown routes (single-page apps) |
| `--watch` | off | Live-reload on file changes (dev) |
| `--no-cache` | off | Disable caching (debugging) |

```bash
node server.mjs --root dist --port 3000 --spa
```

## Deploy to a free host

### GitHub Pages (default, automatic)

1. Create a repo and push:
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin master   # or: git branch -M main && git push -u origin main
   ```
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Every push builds and publishes automatically via `.github/workflows/deploy.yml`.

> Project-page URLs are served from `/<repo>/`. If assets 404, either use a custom domain / user-page repo (`<you>.github.io`), or switch the absolute paths in `public/*.html` (e.g. `/styles.css`) to relative ones.

### Netlify

Connect the repo at [app.netlify.com](https://app.netlify.com). `netlify.toml` sets build = `npm run build`, publish = `dist`, plus caching/security headers.

### Vercel

Import the repo at [vercel.com](https://vercel.com). `vercel.json` configures the build, output dir, clean URLs, and headers.

### Docker (Render / Fly.io / Railway / Cloud Run)

```bash
docker build -t c3-ssg .
docker run -p 8080:8080 c3-ssg
```

## License

MIT
