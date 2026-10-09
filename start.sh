#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
/usr/bin/time -p pwd
PROJECT_ROOT="$(pwd)"
export PROJECT_ROOT
/usr/bin/time -p printf 'project=%s\n' "$PROJECT_ROOT"
PORT="${PORT:-3000}"
export PORT
/usr/bin/time -p printf 'port=%s\n' "$PORT"
DIST="$PROJECT_ROOT/dist"
WEB_DIR="${OPENCODE_WEB_DIR:-/home/runner/work/_temp/omgithub-web}"
/usr/bin/time -p mkdir -p "$DIST" "$WEB_DIR"
/usr/bin/time -p test -d "$DIST"
if /usr/bin/time -p test -f "$PROJECT_ROOT/package.json"; then
  if /usr/bin/time -p test -f "$PROJECT_ROOT/package-lock.json"; then
    /usr/bin/time -p npm ci --no-audit --no-fund
  else
    /usr/bin/time -p npm install --no-audit --no-fund
  fi
  if /usr/bin/time -p node -e "process.exit(require('./package.json').scripts&&require('./package.json').scripts.build?0:1)"; then
    /usr/bin/time -p npm run build
  fi
fi
if ! /usr/bin/time -p test -f "$DIST/index.html"; then
  /usr/bin/time -p tee "$DIST/index.html" >/dev/null <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>PlayGround</title></head><body><main><h1>PlayGround — Safe Placeholder</h1><p>Benign static placeholder. No malware.</p></main></body></html>
HTML
fi
/usr/bin/time -p test -f "$DIST/index.html"
/usr/bin/time -p node --input-type=module -e 'import {writeFileSync} from "node:fs"; import {join} from "node:path"; const root=process.env.PROJECT_ROOT||process.cwd(); const dist=join(root,"dist"); const web=process.env.OPENCODE_WEB_DIR||"/home/runner/work/_temp/omgithub-web"; writeFileSync(join(web,"deployment-output.json"), JSON.stringify({project: root, directory: dist})); console.log("wrote deployment-output.json: "+JSON.stringify({project: root, directory: dist}));'
/usr/bin/time -p cat "$WEB_DIR/deployment-output.json"
/usr/bin/time -p node --input-type=module <<'NODE'
import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
const root = process.env.PROJECT_ROOT || process.cwd();
const dist = resolve(root, 'dist');
const port = Number(process.env.PORT || '3000');
const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon', '.txt':'text/plain', '.wasm':'application/wasm' };
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (path !== dist && !path.startsWith(dist + '/')) { res.writeHead(404); res.end('Not found'); return; }
    try { if (statSync(path).isDirectory()) path = join(path, 'index.html'); } catch { path = join(dist, 'index.html'); }
    if (!existsSync(path)) path = join(dist, 'index.html');
    res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, '0.0.0.0', () => console.log(`serving ${dist} on :${port}`));
NODE
