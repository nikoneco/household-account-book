import http from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};
const allowed = new Set(['index.html','manifest.webmanifest','sw.js','runtime-config.json']);
const server = http.createServer(async (req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\//, '') || 'index.html';
  if (!allowed.has(requested) && !/^(web|shared|assets)\/[\w./-]+$/.test(requested)) { res.writeHead(404); res.end('Not found'); return; }
  const target = path.resolve(root, requested);
  if (!target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    let content;
    if (requested === 'runtime-config.json') content = await readFile(path.join(root,'.local','runtime-config.json'));
    else { if (!(await stat(target)).isFile()) throw new Error(); content = await readFile(target); }
    res.writeHead(200, {'Content-Type':types[path.extname(target)] || 'application/octet-stream', 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(Number(process.env.HOUSEHOLD_DEV_PORT || 4283), '127.0.0.1', () => console.log('家計簿 preview: http://127.0.0.1:' + server.address().port));
