/* Service worker de la Bitácora de Ambulancia HF (alcance: solo la carpeta /bitacora/).
 * - Guarda la app completa en caché al instalarse: abre aunque no haya señal.
 * - NUNCA intercepta la API (script.google.com): los envíos van siempre directo a la red.
 * - Cada publicación tiene su propio nombre de caché; la app muestra "Actualizar" cuando hay versión nueva
 *   y al pulsarlo se activa (SKIP_WAITING). Las cachés anteriores se borran al activar.
 * Generado por scripts/build.py: no editar dist/bitacora/sw.js a mano. */
const VERSION = '%VERSION%';
const CACHE = 'bitacora-' + VERSION;
const ARCHIVOS = %ARCHIVOS%;
const BASE = new URL('./', self.location).pathname;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('bitacora-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;   // API y otros sitios: red directa
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html', { ignoreSearch: true }).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});
