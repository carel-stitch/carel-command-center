import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const root = '/workspace/leave-handover';
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/,'');
    if (path.includes('..')) throw new Error('bad path');
    const file = join(root, path);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control':'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'content-type':'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});
server.listen(4173, '0.0.0.0', () => console.log('Leave handover preview: http://127.0.0.1:4173'));
