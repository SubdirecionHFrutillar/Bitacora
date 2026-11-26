/* Simulador mínimo de Apps Script para probar Código.gs en Node, sin Google.
 * Carga el Código.gs real y le entrega una planilla en memoria y servicios falsos
 * (SpreadsheetApp, PropertiesService, LockService, CacheService, ContentService, HtmlService, Session, Utilities).
 * Lo que es solo formato (bordes, colores, anchos) se acepta y se ignora.
 * Limitación: Node ejecuta una petición a la vez, así que LockService no se pone a prueba de verdad. */
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const TZ = 'America/Santiago';
const pad = (n, w = 2) => String(n).padStart(w, '0');

/* Cualquier método desconocido devuelve el mismo objeto (encadenable) */
const encadenable = (base) => new Proxy(base, {
  get(o, k) {
    if (k in o) return o[k];
    if (typeof k === 'symbol') return undefined;
    return () => encadenable(o);
  },
});

function partesFecha(d, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const dias = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { y: +p.year, M: +p.month, d: +p.day, H: +p.hour, m: +p.minute, s: +p.second, u: dias[p.weekday] };
}

const Utilities = {
  DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
  getUuid: () => crypto.randomUUID(),
  computeDigest: (alg, txt) => [...crypto.createHash(alg).update(String(txt), 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
  formatDate(d, tz, fmt) {
    const p = partesFecha(d, tz);
    return fmt.replace(/yyyy|MM|dd|HH|mm|ss|u/g, (t) => ({ yyyy: p.y, MM: pad(p.M), dd: pad(p.d), HH: pad(p.H), mm: pad(p.m), ss: pad(p.s), u: p.u }[t]));
  },
  parseDate(txt, tz) {
    const n = String(txt).match(/\d+/g).map(Number);
    const [y, M, d, H = 0, m = 0, s = 0] = n;
    let utc = Date.UTC(y, M - 1, d, H, m, s);
    for (let i = 0; i < 3; i++) {   // corrige por el desfase horario de la zona
      const p = partesFecha(new Date(utc), tz);
      utc += Date.UTC(y, M - 1, d, H, m, s) - Date.UTC(p.y, p.M - 1, p.d, p.H, p.m, p.s);
    }
    return new Date(utc);
  },
};

class Hoja {
  constructor(nombre) { this.nombre = nombre; this.data = []; }
  getName() { return this.nombre; }
  getLastRow() { let n = this.data.length; while (n > 0 && this.data[n - 1].every((v) => v === '' || v == null)) n--; return n; }
  getLastColumn() { return Math.max(0, ...this.data.map((r) => { let n = r.length; while (n > 0 && (r[n - 1] === '' || r[n - 1] == null)) n--; return n; })); }
  getMaxRows() { return Math.max(1000, this.data.length); }
  appendRow(fila) { this.data.length = this.getLastRow(); this.data.push([...fila]); return this; }
  celda(r, c) { return (this.data[r - 1] || [])[c - 1] ?? ''; }
  poner(r, c, v) { while (this.data.length < r) this.data.push([]); const f = this.data[r - 1]; while (f.length < c) f.push(''); f[c - 1] = v; }
  getRange(r, c, nr = 1, nc = 1) {
    if (typeof r === 'string') {   // "A2:B3" / "C3:H3"
      const col = (s) => s.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
      const [a, b] = r.split(':'); const ma = a.match(/([A-Z]+)(\d+)/), mb = (b || a).match(/([A-Z]+)(\d+)/);
      return this.getRange(+ma[2], col(ma[1]), +mb[2] - +ma[2] + 1, col(mb[1]) - col(ma[1]) + 1);
    }
    const h = this;
    const rango = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => h.celda(r + i, c + j))),
      getDisplayValues: () => rango.getValues().map((f) => f.map((v) => (v instanceof Date ? Utilities.formatDate(v, TZ, 'dd/MM/yyyy HH:mm:ss') : String(v)))),
      setValues(v) { v.forEach((f, i) => f.forEach((x, j) => h.poner(r + i, c + j, x))); return p; },
      setValue(v) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) h.poner(r + i, c + j, v); return p; },
      clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (h.data[r + i - 1]) h.poner(r + i, c + j, ''); return p; },
      offset: (dr, dc, nr2 = nr, nc2 = nc) => h.getRange(r + dr, c + dc, nr2, nc2),
    };
    const p = encadenable(rango);
    return p;
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  clear() { this.data = []; return this; }
  getProtections() { return []; }
  protect() { return encadenable({ getEditors: () => [], canDomainEdit: () => false }); }
}

export function crearSimulador({ archivo, dueno = 'dueno@ejemplo.cl' }) {
  const hojas = new Map();
  const props = new Map();
  const cache = new Map();
  const stats = { locks: 0 };
  let usuarioActivo = '';   // '' = visitante anónimo (pedido desde la PWA)

  const ss = encadenable({
    getSheetByName: (n) => hojas.get(n) || null,
    insertSheet: (n) => { const h = encadenable(new Hoja(n)); hojas.set(n, h); return h; },
    getSpreadsheetTimeZone: () => TZ,
  });
  const contexto = {
    console, JSON, Date, Math, Object, Array, String, Number, Set, Map, Error, RegExp, Boolean, isNaN, encodeURIComponent,
    Utilities,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, ProtectionType: { SHEET: 'SHEET' }, BorderStyle: { SOLID: 1, SOLID_THICK: 2 } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => { props.set(k, String(v)); }, deleteProperty: (k) => props.delete(k),
    }) },
    LockService: { getScriptLock: () => ({ waitLock: () => { stats.locks++; }, tryLock: () => { stats.locks++; return true; }, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => { cache.set(k, String(v)); }, remove: (k) => cache.delete(k) }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (s) => ({ contenido: s, setMimeType() { return this; }, getContent() { return s; } }) },
    HtmlService: { createHtmlOutput: (s) => encadenable({ getContent: () => s }), XFrameOptionsMode: {} },
    Session: { getActiveUser: () => ({ getEmail: () => usuarioActivo }), getEffectiveUser: () => ({ getEmail: () => dueno }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => encadenable({}) },
    DriveApp: encadenable({}),
    MimeType: { CSV: 'text/csv' },
  };
  vm.createContext(contexto);
  vm.runInContext(fs.readFileSync(archivo, 'utf8'), contexto, { filename: 'Código.gs' });
  const g = (expr) => vm.runInContext(expr, contexto);

  return {
    g, hojas, props, stats,
    comoEditor(fn) { usuarioActivo = dueno; try { return fn(); } finally { usuarioActivo = ''; } },
    doPost(cuerpo) { return JSON.parse(g('doPost')({ postData: { contents: cuerpo } }).getContent()); },
    filas(nombre) {
      const h = hojas.get(nombre); const enc = h.data[0];
      return h.data.slice(1, h.getLastRow()).map((f) => Object.fromEntries(enc.map((k, i) => [k, f[i] ?? ''])));
    },
  };
}
