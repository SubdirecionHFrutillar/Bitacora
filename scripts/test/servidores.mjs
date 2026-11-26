/* Dos servidores locales para las pruebas:
 *  - API  (puerto A): imita la URL /exec de Apps Script. Como Google, responde el POST con un 302 hacia otra
 *    dirección y entrega el JSON en el GET siguiente, con Access-Control-Allow-Origin: *.
 *  - Sitio (puerto B): sirve dist/bitacora/ en /Bitacora/bitacora/ como GitHub Pages (otro origen que la API).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

export function servidorApi(sim, puerto) {
  const respuestas = new Map();
  const registro = [];   // cada pedido recibido: { fn, token }
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/exec')) {
      let cuerpo = '';
      req.on('data', (c) => { cuerpo += c; });
      req.on('end', () => {
        let fn = '', token = '';
        try { const j = JSON.parse(cuerpo); fn = j.fn; token = j.token; } catch (e) { /* */ }
        registro.push({ fn, token, tipo: req.headers['content-type'] });
        const id = crypto.randomUUID();
        respuestas.set(id, JSON.stringify(sim.doPost(cuerpo)));
        res.writeHead(302, { Location: `/echo?id=${id}`, 'Access-Control-Allow-Origin': '*' });   // Google también la envía en el 302
        res.end();
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/echo')) {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(respuestas.get(id) || '{}');
      respuestas.delete(id);
      return;
    }
    if (req.method === 'OPTIONS') { res.writeHead(405); res.end(); registro.push({ fn: 'PREFLIGHT' }); return; }   // Apps Script no responde preflight
    res.writeHead(404); res.end();
  });
  return new Promise((ok) => srv.listen(puerto, '127.0.0.1', () => ok({ srv, registro, url: `http://127.0.0.1:${puerto}/exec` })));
}

export function servidorSitio(carpeta, puerto) {
  const BASE = '/Bitacora/bitacora/';
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!u.pathname.startsWith(BASE)) { res.writeHead(404); res.end(); return; }
    let rel = decodeURIComponent(u.pathname.slice(BASE.length)) || 'index.html';
    const archivo = path.join(carpeta, rel);
    if (!archivo.startsWith(carpeta) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
    fs.createReadStream(archivo).pipe(res);
  });
  return new Promise((ok) => srv.listen(puerto, 'localhost', () => ok({ srv, url: `http://localhost:${puerto}${BASE}` })));
}
