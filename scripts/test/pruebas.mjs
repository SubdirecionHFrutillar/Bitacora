/* Pruebas de la PWA + Código.gs (simulado). Uso:  npm test
 * Compila la app apuntando a un servidor local que imita Apps Script, abre Chromium y recorre los casos.
 * Requiere: npm install y Playwright con Chromium disponible. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearSimulador } from './gas-simulado.mjs';
import { servidorApi, servidorSitio } from './servidores.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUERTO_API = 8790, PUERTO_SITIO = 8791;
const CAPTURAS = process.env.CAPTURAS || '';

execFileSync('python3', ['-I', 'scripts/build.py', '--prueba', '--api-url', `http://127.0.0.1:${PUERTO_API}/exec`], { cwd: RAIZ, stdio: 'inherit' });

const sim = crearSimulador({ archivo: path.join(RAIZ, 'apps-script/Código.gs') });
sim.comoEditor(() => sim.g('setup')());
for (const f of [['Luis Paredes', 'Conductor', 'SI'], ['Camila Soto', 'TENS', 'SI']]) sim.hojas.get('Personal').appendRow(f);
const api = await servidorApi(sim, PUERTO_API);
const sitio = await servidorSitio(path.join(RAIZ, 'dist/bitacora'), PUERTO_SITIO);
const nuevoToken = (nombre) => sim.comoEditor(() => sim.g('crearTokenTablet_')(nombre));
const post = (obj) => fetch(api.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: typeof obj === 'string' ? obj : JSON.stringify(obj) }).then((r) => r.json());

const resultados = [];
async function prueba(nombre, fn) {
  try { const detalle = await fn(); resultados.push({ nombre, ok: true, detalle }); console.log(`✔ ${nombre}\n    ${detalle}`); }
  catch (e) { resultados.push({ nombre, ok: false, detalle: e.message }); console.log(`✘ ${nombre}\n    ${e.stack || e.message}`); }
}
const exigir = (cond, msg) => { if (!cond) throw new Error(msg); };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, msg, ms = 15000) { const t0 = Date.now(); for (;;) { if (await fn()) return; if (Date.now() - t0 > ms) throw new Error('Tiempo agotado: ' + msg); await espera(200); } }

const navegador = await chromium.launch();
const nuevoContexto = () => navegador.newContext({ viewport: { width: 900, height: 1300 }, serviceWorkers: 'allow' });
async function abrir(ctx, sufijo = '') {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('    [error en la página]', e.message));
  await p.goto(sitio.url + sufijo);
  return p;
}
async function confirmarTurno(p) {
  await p.locator('main').getByText('Móvil 01', { exact: true }).first().click();
  const sel = p.locator('main select');
  await sel.nth(0).selectOption('Luis Paredes'); await sel.nth(1).selectOption('Luis Paredes'); await sel.nth(2).selectOption('Camila Soto');
  await p.getByRole('button', { name: 'Confirmar turno' }).click();
}
const captura = async (p, nombre) => { if (CAPTURAS) await p.screenshot({ path: path.join(CAPTURAS, nombre + '.png'), fullPage: true }); };

/* 1 ─────────────────────────────────────────────────────────── */
await prueba('Sin token: la app pide el token y no envía nada', async () => {
  const ctx = await nuevoContexto(); const p = await abrir(ctx);
  await p.getByText('Configurar esta tablet').waitFor();
  await espera(1500);
  const n = api.registro.length;
  await captura(p, '1-sin-token');
  await ctx.close();
  exigir(n === 0, `el servidor recibió ${n} pedido(s)`);
  return 'Se muestra "Configurar esta tablet" y el servidor recibió 0 pedidos.';
});

/* 2 ─────────────────────────────────────────────────────────── */
await prueba('Token por enlace (#t=…): se guarda, se borra de la barra y la app trabaja', async () => {
  const tok = nuevoToken('Tablet enlace');
  const ctx = await nuevoContexto(); const p = await abrir(ctx, '#t=' + tok);
  await p.getByText('Turno en este equipo').waitFor();
  await hasta(() => api.registro.some((r) => r.fn === 'getConfig' && r.token === tok), 'getConfig con el token');
  const url = p.url(); const guardado = await p.evaluate(() => localStorage.getItem('hf-bitacora-token'));
  await ctx.close();
  exigir(!url.includes('#t='), 'el token quedó en la barra: ' + url);
  exigir(guardado === tok, 'el token no quedó guardado');
  exigir(!api.registro.some((r) => r.fn === 'PREFLIGHT'), 'hubo preflight CORS');
  exigir(api.registro.every((r) => r.tipo.startsWith('text/plain')), 'algún pedido no fue text/plain');
  return `URL final ${url} · token guardado · pedidos text/plain sin preflight.`;
});

/* 3 ─────────────────────────────────────────────────────────── */
await prueba('Token revocado: el servidor rechaza y la app vuelve a pedir el token', async () => {
  const tok = nuevoToken('Tablet a revocar');
  const ctx = await nuevoContexto(); const p = await abrir(ctx);
  await p.getByLabel('Token de la tablet').fill(tok);
  await p.getByRole('button', { name: 'Guardar' }).click();
  await p.getByText('Turno en este equipo').waitFor();
  const nombre = sim.comoEditor(() => sim.g('revocarTokenTablet_')(tok.slice(0, 10)));
  const locksAntes = sim.stats.locks;
  const r = await post({ fn: 'getConfig', args: [], token: tok });
  exigir(r.codigo === 'TOKEN_INVALIDO', 'respuesta directa: ' + JSON.stringify(r));
  exigir(sim.stats.locks === locksAntes, 'un pedido con token inválido tomó el LockService');
  await p.reload();
  await p.getByText('no es válido o fue revocado').waitFor();
  const guardado = await p.evaluate(() => localStorage.getItem('hf-bitacora-token'));
  await captura(p, '3-token-revocado');
  await ctx.close();
  exigir(!guardado, 'el token revocado siguió guardado');
  return `Revocado "${nombre}" (por sus primeros 10 caracteres). Respuesta: ${r.codigo}, sin tomar el lock. La app volvió a "Configurar esta tablet" con aviso.`;
});

/* 4 ─────────────────────────────────────────────────────────── */
await prueba('Funciones fuera de la lista blanca y pedidos mal formados: error, nunca se ejecutan', async () => {
  const tok = nuevoToken('Tablet lista blanca');
  const filasAntes = sim.hojas.get('Personal').getLastRow();
  const casos = {};
  for (const fn of ['setup', 'respaldoDiario', 'actualizarPanel', 'getConfig_', 'crearTokenTablet_', 'ADMIN_crearToken', 'doPost', 'constructor', '__proto__', 'toString']) {
    casos[fn] = (await post({ fn, args: ['Intruso'], token: tok })).codigo;
  }
  const sinToken = (await post({ fn: 'getConfig', args: [] })).codigo;
  const basura = (await post('esto no es json')).codigo;
  const vacio = (await post('')).codigo;
  exigir(Object.values(casos).every((c) => c === 'FN_NO_PERMITIDA'), JSON.stringify(casos));
  exigir(sinToken === 'TOKEN_INVALIDO' && basura === 'PEDIDO' && vacio === 'PEDIDO', `${sinToken} ${basura} ${vacio}`);
  exigir(sim.hojas.get('Personal').getLastRow() === filasAntes, 'cambió la hoja Personal');
  const tokens = JSON.parse(sim.props.get('tokens'));
  exigir(!Object.values(tokens).some((x) => x.nombre === 'Intruso'), 'se creó un token desde la web');
  let adminBloqueado = false;
  try { sim.g('ADMIN_listarTokens')(); } catch (e) { adminBloqueado = /editor/.test(e.message); }
  exigir(adminBloqueado, 'ADMIN_listarTokens corrió sin ser el dueño en el editor');
  return `10 funciones no permitidas → FN_NO_PERMITIDA · sin token → TOKEN_INVALIDO · cuerpo inválido/vacío → PEDIDO · ADMIN_ fuera del editor → bloqueado.`;
});

/* 5 ─────────────────────────────────────────────────────────── */
let ctxTablet, pTablet, tokTablet;
await prueba('Traslado completo de punta a punta: llega a Eventos y Traslados con folio, turno y dispositivo', async () => {
  tokTablet = nuevoToken('Tablet Móvil 01');
  ctxTablet = await nuevoContexto(); pTablet = await abrir(ctxTablet, '#t=' + tokTablet);
  const p = pTablet;
  await confirmarTurno(p);
  await p.getByRole('button', { name: /Nuevo traslado/ }).click();
  const sec = p.locator('main section').filter({ hasText: 'Llegada destino' }).first();
  const km = async (v) => { await sec.getByPlaceholder('Km del odómetro').fill(String(v)); await sec.getByRole('button', { name: 'OK', exact: true }).click(); };
  await sec.getByText('1 · Urgencia').click();
  await sec.locator('select').first().selectOption('HPM');
  await sec.getByText('TOCAR').click(); await km(10000);
  await sec.getByText('TOCAR').click(); await km(10042);
  await sec.getByText('TOCAR').click();
  await sec.getByText('TOCAR').click(); await km(10085);
  await sec.getByRole('button', { name: /Revisar y cerrar/ }).click();
  await captura(p, '5-cerrar');
  await p.getByRole('button', { name: 'Confirmar y cerrar' }).click();
  await hasta(() => sim.filas('Traslados').some((t) => t.estado === 'cerrado'), 'traslado cerrado en la planilla', 20000);
  await hasta(async () => (await p.evaluate(() => JSON.parse(localStorage.getItem('hf-bitacora-piloto-v1')).cola.length)) === 0, 'cola vacía');
  const t = sim.filas('Traslados').find((x) => x.estado === 'cerrado');
  const ev = sim.filas('Eventos').filter((e) => e.traslado_id === t.traslado_id);
  const disp = await p.evaluate(() => localStorage.getItem('hf-bitacora-dispositivo'));
  exigir(/^D-\d{6}$/.test(t.folio), 'folio ' + t.folio);
  exigir(t.chofer === 'Luis Paredes' && t.tens === 'Camila Soto' && t.registrado_por === 'Luis Paredes' && t.movil === 'Móvil 01', 'turno en Traslados');
  exigir(t.km_recorridos === 85 && t.destino === 'HPM' && t.motivo_salida === 'Urgencia', `km ${t.km_recorridos} destino ${t.destino}`);
  exigir(ev.length >= 8 && ev.every((e) => e.folio === t.folio && e.dispositivo === disp && e.usuario === 'Luis Paredes'), 'eventos sin folio/dispositivo/usuario');
  exigir(ev.every((e) => e.cuenta_google === `token:Tablet Móvil 01 · ${disp}`), 'cuenta_google: ' + ev[0].cuenta_google);
  exigir(sim.hojas.get('Bitácora').getLastRow() >= 4, 'la hoja Bitácora no se actualizó');
  await captura(p, '5-cerrado');
  return `${t.folio} cerrado · ${ev.length} eventos (${[...new Set(ev.map((e) => e.tipo))].join(', ')}) · chofer/TENS/registra del turno · ` +
    `km ${t.km_recorridos} · dispositivo ${disp} · cuenta_google "${ev[0].cuenta_google}" · hoja Bitácora actualizada.`;
});

/* 6 ─────────────────────────────────────────────────────────── */
await prueba('Modo avión: cerrar y volver a abrir → abre, registra y al volver la señal envía la cola', async () => {
  const p0 = pTablet;
  await hasta(() => p0.evaluate(() => !!navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true)), 'service worker activo');
  await p0.evaluate(() => navigator.serviceWorker.ready);
  const antes = sim.filas('Eventos').length;
  await ctxTablet.setOffline(true);
  await p0.close();                                  // "cerrar la app"
  const p = await abrir(ctxTablet);                   // "volver a abrirla" sin señal
  await p.getByText('Bitácora de Ambulancia').first().waitFor({ timeout: 15000 });
  await p.getByRole('button', { name: /Nuevo traslado/ }).click();
  const sec = p.locator('main section').filter({ hasText: 'Llegada destino' }).first();
  await sec.getByText('2 · Programado').click();
  await sec.getByText('TOCAR').click();
  await sec.getByPlaceholder('Km del odómetro').fill('10090'); await sec.getByRole('button', { name: 'OK', exact: true }).click();
  await p.getByText(/Sin señal · \d+ en cola/).first().waitFor();
  const enCola = await p.evaluate(() => JSON.parse(localStorage.getItem('hf-bitacora-piloto-v1')).cola.length);
  await captura(p, '6-sin-senal');
  exigir(sim.filas('Eventos').length === antes, 'llegaron eventos estando sin señal');
  await ctxTablet.setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await hasta(async () => (await p.evaluate(() => JSON.parse(localStorage.getItem('hf-bitacora-piloto-v1')).cola.length)) === 0, 'cola enviada', 20000);
  const despues = sim.filas('Eventos').length;
  exigir(despues - antes === enCola, `en cola ${enCola}, llegaron ${despues - antes}`);
  const nuevo = sim.filas('Traslados').find((x) => x.motivo_salida === 'Programado');
  exigir(nuevo && /^D-\d{6}$/.test(nuevo.folio), 'el traslado sin señal no recibió folio');
  await captura(p, '6-enviado');
  pTablet = p;
  return `Sin señal la app abrió desde el service worker y dejó ${enCola} eventos en cola (0 llegaron). Con señal se enviaron los ${enCola}; folio ${nuevo.folio}.`;
});

/* 7 ─────────────────────────────────────────────────────────── */
await prueba('Dos tablets agregan el mismo nombre a la vez: una sola fila en Personal', async () => {
  const t1 = tokTablet, t2 = nuevoToken('Tablet Móvil 02');
  const [a, b] = await Promise.all([
    post({ fn: 'agregarPersona', args: [{ nombre: 'josé   pérez', rol: 'Conductor' }], token: t1, dispositivo: 'TAB-A' }),
    post({ fn: 'agregarPersona', args: [{ nombre: 'Jose Perez', rol: 'Conductor' }], token: t2, dispositivo: 'TAB-B' }),
  ]);
  const filas = sim.filas('Personal').filter((x) => x.rol === 'Conductor' && x.nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() === 'jose perez');
  exigir(filas.length === 1, `${filas.length} filas: ${JSON.stringify(filas)}`);
  exigir(a.data && b.data && [a.data.existente, b.data.existente].sort().join() === 'false,true', JSON.stringify([a, b]));
  // y desde la interfaz: "+ Agregar otro nombre…"
  const p = pTablet;
  await p.getByRole('button', { name: 'Cambiar', exact: true }).first().click();
  await p.locator('main select').nth(2).selectOption('__agregar_otro__');
  await p.getByPlaceholder('Nombre y apellido').fill('maría   josé oyarzún');
  await p.getByRole('button', { name: 'Guardar', exact: true }).first().click();
  await hasta(() => sim.filas('Personal').some((x) => x.nombre === 'María José Oyarzún' && x.rol === 'TENS'), 'nombre agregado desde la app');
  await captura(p, '7-agregar');
  return `"josé   pérez" y "Jose Perez" enviados a la vez desde dos tablets → 1 fila ("${filas[0].nombre}"); la otra recibió el existente. ` +
    'Desde la app, "+ Agregar otro nombre…" dejó "María José Oyarzún" en Personal. (Node atiende un pedido a la vez: el bloqueo real lo da LockService en Google.)';
});

/* 8 ─────────────────────────────────────────────────────────── */
await prueba('Versión nueva publicada: la tablet muestra "Actualizar" y al tocarlo carga la nueva', async () => {
  const p = pTablet;
  const vAntes = await p.locator('header').innerText();
  const fs = await import('node:fs');
  const sw = path.join(RAIZ, 'dist/bitacora/sw.js');
  fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(/const VERSION = '([^']+)'/, "const VERSION = '$1-b'"));
  await p.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await p.getByRole('button', { name: 'Actualizar' }).waitFor({ timeout: 15000 });
  await captura(p, '8-actualizar');
  await Promise.all([p.waitForEvent('load'), p.getByRole('button', { name: 'Actualizar' }).click()]);
  const cache = await p.evaluate(() => caches.keys());
  exigir(cache.length === 1 && cache[0].endsWith('-b'), 'cachés: ' + cache.join(', '));
  return `Aviso "Hay una versión nueva" → Actualizar → recarga; queda una sola caché (${cache[0]}). Cabecera: ${vAntes.split('\n').find((l) => l.includes('v20'))}`;
});

await navegador.close(); api.srv.close(); sitio.srv.close();
const malas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - malas.length}/${resultados.length} pruebas correctas`);
process.exit(malas.length ? 1 : 0);
