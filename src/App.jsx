const { useState, useEffect, useRef, useMemo, createContext, useContext } = React;
const __L = window.LucideReact || {};
const __stub = () => null;
const { Ambulance = __stub, Sun = __stub, Moon = __stub, Plus = __stub, Check = __stub, X = __stub, AlertTriangle = __stub, Clock = __stub, Copy = __stub, Download = __stub, Users = __stub, RefreshCw = __stub, CloudOff = __stub, Cloud = __stub, Pencil = __stub, Ban = __stub, ChevronDown = __stub, ChevronUp = __stub, FileText = __stub, Route = __stub, Gauge = __stub } = __L;

/* ==================================================================
   PILOTO · BITÁCORA DIGITAL DE TRASLADOS — HOSPITAL DE FRUTILLAR
   - Mismos datos que la bitácora en papel + quién solicita / autoriza.
   - Sin nombres de pacientes (solo N° y episodio/folio clínico).
   - Todo cambio es un EVENTO que se encola offline y se envía a la
     planilla institucional (Apps Script). Nada se borra: se anula
     o se corrige con motivo.
   - Si no hay servidor (vista previa), funciona en "modo demo".
   ================================================================== */

const STORE = 'hf-bitacora-piloto-v1';
const DEVICE_KEY = 'hf-bitacora-dispositivo';
const HOSPITAL = 'Hospital de Frutillar';

const DEFAULT_CONFIG = {
  moviles: ['Móvil 01', 'Móvil 02'],
  personal: [
    { nombre: 'Luis Paredes', rol: 'Conductor' }, { nombre: 'Héctor Mansilla', rol: 'Conductor' }, { nombre: 'Rodrigo Alvarado', rol: 'Conductor' },
    { nombre: 'Camila Soto', rol: 'TENS' }, { nombre: 'Daniela Vera', rol: 'TENS' }, { nombre: 'Francisco Oyarzo', rol: 'TENS' },
    { nombre: 'Dra. Médico Turno A', rol: 'Médico' }, { nombre: 'Dr. Médico Turno B', rol: 'Médico' },
  ],
  destinos: ['HPM', 'Clínica Puerto Varas (TAC RIU)', 'Diálisis', 'Policlínico en otra comuna', 'Rescate comunal', 'Alta a domicilio', 'Otro'],
  solicitantes: ['Urgencia', 'Hospitalizados', 'HODOM', 'Regulación SAMU', 'CESFAM / APS', 'Otro hospital'],
};

/* Traslado avanzado: profesionales que pueden acompañar (se marcan uno o más) */
const APOYO = ['Médico', 'Enfermera', 'Matrona'];
const avanzadoTexto = (x) => (x.avanzado ? `Avanzado${(x.apoyo || []).length ? ': ' + x.apoyo.join(', ') : ''}` : (x.medico || ''));

const MOTIVOS = [
  { k: 'Urgencia', n: '1' }, { k: 'Programado', n: '2' }, { k: 'Rescate comunal', n: '3' },
];

/* Etapas = columnas del papel. km: se pide el kilometraje en esa etapa */
const ETAPAS = [
  { k: 'salidaHF', l: 'Salida HF', sub: 'Hora + km', km: true },
  { k: 'llegadaDest', l: 'Llegada destino', sub: 'Hora + km', km: true },
  { k: 'salidaDest', l: 'Salida destino', sub: 'Hora' },
  { k: 'llegadaHF', l: 'Llegada HF', sub: 'Hora + km', km: true },
];

/* ---------------- utilidades ---------------- */
const pad = (n) => String(n).padStart(2, '0');
const uid = () => (crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const hm = (iso) => { if (!iso) return '--:--'; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fechaLocal = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtFecha = (f) => (f ? f.split('-').reverse().join('-') : '');
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${fechaLocal(d)}T${hm(iso)}`; };
const minEntre = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);
const fmtMin = (m) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h ${pad(m % 60)}` : `${m} min`);
const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
const fmtKm = (v) => (v == null ? '—' : Number(v).toLocaleString('es-CL'));
const kmTotal = (t) => (num(t.km.salidaHF) != null && num(t.km.llegadaHF) != null ? t.km.llegadaHF - t.km.salidaHF : null);
const velocidad = (kmA, kmB, tA, tB) => { const m = minEntre(tA, tB); if (num(kmA) == null || num(kmB) == null || !m || m <= 0) return null; return Math.round(((kmB - kmA) / m) * 60); };
const siguienteEtapa = (t) => ETAPAS.find((e) => !t.t[e.k] || (e.km && num(t.km[e.k]) == null));
const folioDe = (t) => t.folio || `Pendiente (${t.id.slice(0, 4)})`;

function cargarLS(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
function guardarLS(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; } }
function dispositivoId() {
  try { let d = localStorage.getItem(DEVICE_KEY); if (!d) { d = 'TAB-' + uid().slice(0, 6).toUpperCase(); localStorage.setItem(DEVICE_KEY, d); } return d; } catch (e) { return 'TAB-SIN-ID'; }
}

/* ---------------- turno en este equipo ----------------
   El turno confirmado (móvil, quién registra, chofer, TENS) se guarda en la tablet y vence a las 12 h
   o al pulsar "Cambiar". Sin turno vigente no se registra nada (también lo valida el servidor).
   Todo acceso a localStorage va en try/catch: si falla, la app sigue y solo pide el turno de nuevo. */
const TURNO_KEY = 'hf-bitacora-turno-v1';
const TURNO_HORAS = 12;
const AVISO_TURNO = 'Primero completa el turno en este equipo';
const AGREGAR = '__agregar_otro__';
const turnoCompleto = (x) => !!x && ['movil', 'usuario', 'chofer', 'tens'].every((k) => String(x[k] || '').trim() !== '');
const turnoVigente = (x) => turnoCompleto(x) && Number(x.confirmadoEn) > 0 && Date.now() - Number(x.confirmadoEn) < TURNO_HORAS * 3600000;
function leerTurno() { try { const v = JSON.parse(localStorage.getItem(TURNO_KEY) || 'null'); return turnoVigente(v) ? v : null; } catch (e) { return null; } }
function guardarTurno(x) { try { localStorage.setItem(TURNO_KEY, JSON.stringify(x)); return true; } catch (e) { return false; } }
function borrarTurno() { try { localStorage.removeItem(TURNO_KEY); } catch (e) { /* sin almacenamiento: no hay nada que borrar */ } }
/* Solo para la vista previa sin servidor (en la planilla lo normaliza Código.gs) */
const normalizarNombre = (x) => String(x).replace(/\s+/g, ' ').trim().toLowerCase().replace(/(^|[\s'-])([a-záéíóúüñ])/g, (m, sep, l) => sep + l.toUpperCase());
const claveNombre = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/* ---------------- conexión con Apps Script ---------------- */
const hayServidor = () => typeof google !== 'undefined' && google.script && google.script.run;
const gas = (fn, ...args) => new Promise((res, rej) => { google.script.run.withSuccessHandler(res).withFailureHandler(rej)[fn](...args); });

async function copiarTexto(texto) {
  try { await navigator.clipboard.writeText(texto); return true; } catch (e) { /* fallback */ }
  try { const ta = document.createElement('textarea'); ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch (e) { return false; }
}
async function descargar(nombre, contenido) {
  try { if (window.claude && window.claude.use) { const dl = await window.claude.use('downloads'); if (dl) { await dl.save({ filename: nombre, data: contenido }); return true; } } } catch (e) { return false; }
  try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([contenido], { type: 'text/csv;charset=utf-8' })); a.download = nombre; document.body.appendChild(a); a.click(); a.remove(); return true; } catch (e) { return false; }
}

/* ---------------- datos de ejemplo (modo demo) ---------------- */
function isoHoy(h, m, diasAtras = 0) { const d = new Date(); d.setDate(d.getDate() - diasAtras); d.setHours(h, m, 0, 0); return d.toISOString(); }
function trasladoBase(p) {
  return {
    id: uid(), folio: null, estado: 'en_curso', fecha: fechaLocal(), movil: 'Móvil 01', motivo: null, destino: '',
    solicitadoPor: '', autorizadoPor: '', conductor: '', tens: '', medico: '', avanzado: false, apoyo: [], nPacientes: 1, episodios: '', obs: '',
    t: {}, km: {}, kmSinRegistro: null, anulacion: '', registradoPor: '', ...p,
  };
}
function demo() {
  const ayer = fechaLocal(new Date(Date.now() - 864e5));
  const traslados = [
    trasladoBase({ folio: 'D-000001', estado: 'cerrado', fecha: ayer, motivo: 'Urgencia', destino: 'HPM', solicitadoPor: 'Urgencia', autorizadoPor: 'Dr. Médico Turno B',
      conductor: 'Héctor Mansilla', tens: 'Daniela Vera', nPacientes: 1, episodios: 'DAU 88412', obs: 'Hemorragia digestiva, estable.',
      t: { salidaHF: isoHoy(23, 20, 1), llegadaDest: isoHoy(23, 50, 1), salidaDest: isoHoy(0, 0, 0), llegadaHF: isoHoy(0, 33, 0) },
      km: { salidaHF: 35444, llegadaDest: 35489, llegadaHF: 35533 }, registradoPor: 'Daniela Vera' }),
    trasladoBase({ folio: 'D-000002', estado: 'cerrado', motivo: 'Programado', destino: 'HPM', solicitadoPor: 'Hospitalizados', autorizadoPor: 'Dra. Médico Turno A',
      conductor: 'Luis Paredes', tens: 'Camila Soto', nPacientes: 2, episodios: 'Hosp 1204, Hosp 1209', obs: 'Dos pacientes a hora de especialidad.',
      t: { salidaHF: isoHoy(9, 45), llegadaDest: isoHoy(10, 15), salidaDest: isoHoy(10, 50), llegadaHF: isoHoy(11, 20) },
      km: { salidaHF: 35533, llegadaDest: 35578, llegadaHF: 35624 }, kmSinRegistro: 0, registradoPor: 'Camila Soto' }),
    trasladoBase({ folio: 'D-000003', estado: 'cerrado', motivo: 'Rescate comunal', destino: 'Rescate comunal', solicitadoPor: 'Regulación SAMU', autorizadoPor: 'Dra. Médico Turno A',
      conductor: 'Luis Paredes', tens: 'Camila Soto', nPacientes: 1, episodios: 'DAU 88501', obs: 'Caída en domicilio sector rural, se trae a Urgencia HF.',
      t: { salidaHF: isoHoy(11, 40), llegadaDest: isoHoy(11, 58), salidaDest: isoHoy(12, 15), llegadaHF: isoHoy(12, 32) },
      km: { salidaHF: 35631, llegadaDest: 35646, llegadaHF: 35662 }, kmSinRegistro: 7, registradoPor: 'Camila Soto' }),
    trasladoBase({ estado: 'en_curso', motivo: 'Urgencia', destino: 'HPM', solicitadoPor: 'Urgencia', autorizadoPor: 'Dra. Médico Turno A',
      conductor: 'Luis Paredes', tens: 'Camila Soto', nPacientes: 1, episodios: 'DAU 88533',
      t: { salidaHF: isoHoy(13, 5) }, km: { salidaHF: 35662 }, kmSinRegistro: 0, registradoPor: 'Camila Soto' }),
  ];
  return {
    theme: 'day', tab: 'traslados', movil: 'Móvil 01', usuario: 'Camila Soto',
    tripulacion: { conductor: 'Luis Paredes', tens: 'Camila Soto', medico: '' },
    traslados, cola: [], ultimoSync: null, config: DEFAULT_CONFIG, ultimoKmServidor: {}, abierto: traslados[3].id,
  };
}

/* ---------------- tema ---------------- */
/* Estilo institucional (Kit Digital Gobierno de Chile): azul #0F69C4, rojo #EB3C46, azul oscuro #001C41, tipografía gobCL / Roboto */
/* Tonos bajados (21-11-2026): azul menos saturado, estados con tinte suave + borde en vez de bloques llenos.
   Contraste de texto ≥ 4.5:1 (AA). Cada estado lleva además texto, nunca solo color. */
const THEMES = {
  day: { page: 'bg-[#F3F5F8] text-[#1B2B44]', head: 'bg-white text-[#1B2B44] border-b border-[#D3DAE3] shadow-sm', card: 'bg-white border border-[#D3DAE3] shadow-sm', muted: 'text-[#55647A]',
    input: 'bg-white border-2 border-[#9AA8BA] text-[#1B2B44] placeholder-[#97A3B3] focus:border-[#2F67A8] focus:outline-none', btn: 'bg-white border-2 border-[#7E9BC0] text-[#24548C]',
    on: 'bg-[#DCE7F4] text-[#183E6B] border-2 border-[#2F67A8]', primary: 'bg-[#2F67A8] text-white border-2 border-[#26568D]', soft: 'bg-[#EFF2F6]', nav: 'bg-white border-t border-[#D3DAE3]', line: 'border-[#D3DAE3]',
    title: 'text-[#2F67A8]', folio: 'text-[#2F6E47]',
    done: 'bg-[#E4F0E8] text-[#1F5235]', doneLine: 'border-[#8DBF9F]', next: 'border-[#2F67A8]',
    dotOk: 'bg-[#4F9468]', dotRun: 'bg-[#D6A94A]', dotOff: 'bg-[#A3ADB8]', run: 'ring-2 ring-[#D6A94A]', runText: 'text-[#8A6414]',
    warn: 'text-[#80600F]', warnBox: 'border-2 border-[#E2C878] bg-[#FBF4DF] text-[#3B2F0B]', alert: 'text-[#B02E3A]', voided: 'bg-[#E7EAEE] text-[#2B3647]',
    ok: 'bg-[#E4F0E8] text-[#1F5235] border-[#8DBF9F]' },
  night: { page: 'bg-[#0B1626] text-[#DDE5EF]', head: 'bg-[#13233A] text-[#E6ECF4] border-b border-[#24395A]', card: 'bg-[#13233A] border border-[#24395A]', muted: 'text-[#9DAEC4]',
    input: 'bg-[#0B1626] border-2 border-[#33496B] text-[#E6ECF4] placeholder-[#6A7F9E] focus:border-[#6B95C9] focus:outline-none', btn: 'bg-[#13233A] border-2 border-[#5D86BA] text-[#C3D4EA]',
    on: 'bg-[#22406A] text-[#DCE7F5] border-2 border-[#6B95C9]', primary: 'bg-[#5D86BA] text-[#0B1626] border-2 border-[#7FA2CF]', soft: 'bg-[#1A2D47]', nav: 'bg-[#13233A] border-t border-[#24395A]', line: 'border-[#24395A]',
    title: 'text-[#93B3DA]', folio: 'text-[#8CCBA2]',
    done: 'bg-[#183527] text-[#C3E3CF]', doneLine: 'border-[#3F7656]', next: 'border-[#6B95C9]',
    dotOk: 'bg-[#5FA77A]', dotRun: 'bg-[#D9B25E]', dotOff: 'bg-[#6E7C8E]', run: 'ring-2 ring-[#B8923F]', runText: 'text-[#E3C47E]',
    warn: 'text-[#E3C47E]', warnBox: 'border-2 border-[#7D6A33] bg-[#2E2716] text-[#F1E6C6]', alert: 'text-[#F0959B]', voided: 'bg-[#26344A] text-[#DDE5EF]',
    ok: 'bg-[#183527] text-[#C3E3CF] border-[#3F7656]' },
};
const Th = createContext(THEMES.day);
const useT = () => useContext(Th);

/* ---------------- piezas UI ---------------- */
function Card({ title, icon: I, right, children, className = '' }) {
  const t = useT();
  return (
    <section className={`${t.card} rounded-lg p-4 mb-4 ${className}`}>
      {title && <div className="flex items-center justify-between gap-2 mb-3"><h2 className={`text-lg font-extrabold flex items-center gap-2 ${t.title}`}>{I && <I size={22} />}{title}</h2>{right}</div>}
      {children}
    </section>
  );
}
function Field({ label, children, hint }) {
  const t = useT();
  return <label className="block mb-3"><span className={`block text-sm font-bold mb-1 ${t.muted}`}>{label}</span>{children}{hint && <span className={`block text-xs mt-1 ${t.muted}`}>{hint}</span>}</label>;
}
function Input(props) { const t = useT(); return <input {...props} className={`${t.input} w-full min-h-[52px] rounded-md px-3 text-lg font-semibold ${props.className || ''}`} />; }
function Btn({ children, onClick, kind = 'btn', className = '', disabled, icon: I }) {
  const t = useT();
  return <button type="button" onClick={onClick} disabled={disabled} className={`${t[kind]} min-h-[56px] px-4 rounded-md font-extrabold flex items-center justify-center gap-2 active:scale-95 transition disabled:opacity-40 ${className}`}>{I && <I size={22} />}{children}</button>;
}
function Seg({ options, value, onChange, disabled, compact }) {
  const t = useT();
  return (
    <div className={`flex gap-2 ${compact ? 'flex-nowrap' : 'flex-wrap'}`}>
      {options.map((o) => { const k = o.k ?? o; const l = o.l ?? o; return (
        <button key={k} type="button" disabled={disabled} onClick={() => onChange(k)}
          className={`${value === k ? t.on : t.btn} min-h-[52px] px-3 rounded-md font-bold flex-1 ${compact ? 'min-w-[52px]' : 'min-w-[96px]'} disabled:opacity-60`}>{l}</button>); })}
    </div>
  );
}
/* Casilla grande (≥52 px) para usar con guantes */
function Casilla({ checked, label, onChange, disabled }) {
  const t = useT();
  return (
    <button type="button" role="checkbox" aria-checked={!!checked} disabled={disabled} onClick={() => onChange(!checked)}
      className={`${checked ? t.on : t.btn} min-h-[52px] px-3 rounded-md font-bold flex items-center gap-2 w-full disabled:opacity-60`}>
      <span className={`w-6 h-6 shrink-0 rounded border-2 flex items-center justify-center ${checked ? 'border-current' : 'border-current opacity-60'}`}>{checked && <Check size={18} />}</span>
      <span className="text-left">{label}</span>
    </button>
  );
}
function Select({ value, onChange, options, placeholder, disabled }) {
  const t = useT();
  return (
    <select value={value || ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={`${t.input} w-full min-h-[52px] rounded-md px-3 text-lg font-semibold`}>
      <option value="">{placeholder || 'Seleccionar…'}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

/* Texto libre: se registra un solo evento al salir del campo, no por cada tecla */
function TextoDato({ value, onCommit, area, ...rest }) {
  const t = useT();
  const [v, setV] = useState(value || '');
  useEffect(() => { setV(value || ''); }, [value]);
  const commit = () => { if ((v || '') !== (value || '')) onCommit(v); };
  return area
    ? <textarea rows={2} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} className={`${t.input} w-full rounded-md p-3 text-base`} {...rest} />
    : <Input value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} {...rest} />;
}

/* ---------------- modal de corrección / anulación ---------------- */
function Modal({ titulo, children, onClose }) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center overflow-auto p-3">
      <div className={`${t.card} rounded-lg w-full max-w-lg p-4 mt-10`}>
        <div className="flex items-center justify-between mb-3"><h3 className="font-black text-lg">{titulo}</h3>
          <button type="button" onClick={onClose} className={`${t.btn} min-h-[52px] min-w-[52px] rounded-md flex items-center justify-center`} aria-label="Cerrar"><X /></button></div>
        {children}
      </div>
    </div>
  );
}

/* Una corrección no puede dejar la etapa antes de la anterior registrada ni después de la siguiente
   (horas comparadas al minuto, igual que el selector; km de las etapas con km). */
function limitesCorreccion(tr, campo) {
  const [grupo, k] = campo.split('.');
  const fuente = grupo === 't' ? tr.t : tr.km;
  const tiene = (e) => (grupo === 't' ? !!fuente[e.k] : e.km && num(fuente[e.k]) != null);
  const i = ETAPAS.findIndex((e) => e.k === k);
  const prev = ETAPAS.slice(0, i).reverse().find(tiene);
  const next = ETAPAS.slice(i + 1).find(tiene);
  return { prev: prev && { l: prev.l, v: fuente[prev.k] }, next: next && { l: next.l, v: fuente[next.k] } };
}
const minuto = (d) => Math.floor(new Date(d).getTime() / 60000);

function errorCorreccion(c, valor) {
  if (valor === '' || !c.tr) return '';
  const { prev, next } = limitesCorreccion(c.tr, c.campo);
  if (c.tipo === 'hora') {
    const d = new Date(valor);
    if (isNaN(d.getTime())) return 'Hora no válida.';
    if (prev && minuto(d) < minuto(prev.v)) return `${c.label} no puede ser antes de ${prev.l} (${hm(prev.v)}).`;
    if (next && minuto(d) > minuto(next.v)) return `${c.label} no puede ser después de ${next.l} (${hm(next.v)}).`;
    if (minuto(d) > minuto(Date.now())) return 'La hora no puede ser posterior a la hora actual.';
    return '';
  }
  const n = Number(valor);
  if (prev && n < num(prev.v)) return `El km no puede ser menor que el de ${prev.l} (${fmtKm(prev.v)}).`;
  if (next && n > num(next.v)) return `El km no puede ser mayor que el de ${next.l} (${fmtKm(next.v)}).`;
  return '';
}

/* El selector no tiene segundos: dentro del mismo minuto se ajusta al segundo de la etapa vecina
   para que el orden quede estricto (nunca "llegó antes de salir" por segundos). */
function horaCorregida(c, valor) {
  const d = new Date(valor);
  if (!c.tr) return d.toISOString();
  const { prev, next } = limitesCorreccion(c.tr, c.campo);
  if (prev && d < new Date(prev.v)) return new Date(prev.v).toISOString();
  if (next && d > new Date(next.v)) return new Date(next.v).toISOString();
  return d.toISOString();
}

const MOTIVOS_HORA = ['Me equivoqué al marcar', 'Marqué tarde', 'Marqué la etapa que no era', 'Hora del papel'];
const MOTIVOS_KM = ['Error al digitar', 'Odómetro mal leído', 'Km del otro móvil', 'Km del papel'];
const motivoAjuste = (iso) => `Ajuste al marcar (hora del toque ${hm(iso)})`;

/* Ajuste al marcar: el toque pone la hora actual y, hasta tocar la etapa siguiente, se puede cambiar aquí
   (evento CORREGIR con motivo automático y la hora del toque). Después, solo con «Corregir» y motivo. */
function AjusteHora({ tr, etapa, onSave }) {
  const t = useT();
  const actual = hm(tr.t[etapa.k]);
  const [hhmm, setHhmm] = useState(actual);
  useEffect(() => { setHhmm(actual); }, [actual]);
  let iso = '', error = '';
  if (/^\d{2}:\d{2}$/.test(hhmm) && hhmm !== actual) {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(); d.setHours(h, m, 0, 0);
    if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1); // hora "mayor" que ahora = ayer (cruce de medianoche)
    iso = d.toISOString();
    error = errorCorreccion({ tr, campo: `t.${etapa.k}`, tipo: 'hora', label: etapa.l }, iso);
    if (!error && Date.now() - d.getTime() > 12 * 3600000) error = 'Solo se puede ajustar dentro de las últimas 12 horas.';
  }
  return (
    <div className="px-2 pb-2">
      <div className="flex items-center gap-2">
        <span className={`text-sm font-bold ${t.muted} shrink-0`}>¿Fue a otra hora?</span>
        <Input type="time" value={hhmm} onChange={(e) => setHhmm(e.target.value)} aria-label={`Hora de ${etapa.l}`} className="!w-36" />
        {iso && !error && <Btn kind="primary" icon={Check} className="!min-h-[52px]" onClick={() => onSave(horaCorregida({ tr, campo: `t.${etapa.k}` }, iso))}>Guardar</Btn>}
      </div>
      {error && <p role="alert" className={`${t.alert} font-bold mt-1`}>{error}</p>}
    </div>
  );
}

/* Cierre: muestra el traslado como una fila del talonario y deja constancia de quién cierra y a qué hora */
function CerrarTraslado({ tr, usuario, onSave, onClose }) {
  const t = useT();
  const fila = (l, v) => <div className="flex justify-between gap-3 py-1 border-b border-current/10"><span className={t.muted}>{l}</span><b className="text-right tabular-nums">{v}</b></div>;
  return (
    <Modal titulo="Revisar y cerrar" onClose={onClose}>
      <div className={`${t.soft} rounded-md p-3 mb-3 text-base`}>
        {fila('Folio', tr.folio || 'se asigna al enviar')}
        {fila('Fecha · móvil', `${fmtFecha(tr.fecha)} · ${tr.movil}`)}
        {fila('Salida HF', `${hm(tr.t.salidaHF)} · ${fmtKm(num(tr.km.salidaHF))} km`)}
        {fila('Llegada destino', `${hm(tr.t.llegadaDest)} · ${fmtKm(num(tr.km.llegadaDest))} km`)}
        {fila('Motivo', `${(MOTIVOS.find((m) => m.k === tr.motivo) || {}).n || ''} ${tr.motivo || '—'}`)}
        {fila('Destino', tr.destino || '—')}
        {fila('Salida destino', hm(tr.t.salidaDest))}
        {fila('Llegada HF', `${hm(tr.t.llegadaHF)} · ${fmtKm(num(tr.km.llegadaHF))} km`)}
        {fila('Pacientes', tr.nPacientes)}
        {tr.avanzado && fila('Traslado', avanzadoTexto(tr))}
      </div>
      <div className={`rounded-md border-2 ${t.line} p-3 mb-3`}>
        <div className={`text-sm font-bold ${t.muted}`}>Firma digital</div>
        <div className="font-bold">Chofer: {tr.conductor || '—'}</div>
        <div className="font-bold">TENS: {tr.tens || '—'}</div>
        <div className={`text-sm mt-1 ${t.muted}`}>Cierra: {usuario || '—'} · {hm(new Date().toISOString())}. Queda en el registro con la cuenta y el equipo; después solo se corrige con motivo.</div>
      </div>
      <div className="flex gap-2">
        <Btn className="flex-1" onClick={onClose}>Volver</Btn>
        <Btn kind="primary" icon={Check} className="flex-[2]" onClick={onSave}>Confirmar y cerrar</Btn>
      </div>
    </Modal>
  );
}

function Correccion({ c, onSave, onClose }) {
  const t = useT();
  const [valor, setValor] = useState(c.tipo === 'hora' ? toLocalInput(c.actual) : c.actual ?? '');
  const [motivo, setMotivo] = useState('');
  const error = errorCorreccion(c, valor);
  const ok = motivo.trim().length >= 5 && valor !== '' && !error;
  return (
    <Modal titulo={`Corregir: ${c.label}`} onClose={onClose}>
      <p className="text-sm mb-3">Valor registrado: <b>{c.tipo === 'hora' ? hm(c.actual) : c.actual ?? '—'}</b>. La corrección queda en el registro de eventos junto al valor original.</p>
      <Field label="Nuevo valor">
        {c.tipo === 'hora' ? <Input type="datetime-local" value={valor} onChange={(e) => setValor(e.target.value)} />
          : <Input inputMode="numeric" value={valor} onChange={(e) => setValor(e.target.value.replace(/\D/g, ''))} />}
        {error && <p role="alert" className={`${t.alert} font-bold mt-1`}>{error}</p>}
      </Field>
      <Field label="Motivo de la corrección (obligatorio) — toque uno o escríbalo">
        <div className="grid grid-cols-2 gap-2 mb-2">
          {(c.tipo === 'hora' ? MOTIVOS_HORA : MOTIVOS_KM).map((m) => (
            <button key={m} type="button" onClick={() => setMotivo(m)} className={`${motivo === m ? t.on : t.btn} min-h-[52px] px-2 rounded-md font-bold text-sm`}>{m}</button>))}
        </div>
        <Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Otro motivo (mín. 5 letras)" /></Field>
      <Btn kind="primary" icon={Check} className="w-full" disabled={!ok}
        onClick={() => onSave(c.tipo === 'hora' ? horaCorregida(c, valor) : Number(valor), motivo.trim())}>Guardar corrección</Btn>
    </Modal>
  );
}

/* ==================================================================
   TARJETA DE TRASLADO
   ================================================================== */
function Traslado({ tr, abierto, setAbierto, cfg, ultimoKm, registrar, setModal }) {
  const t = useT();
  const [kmDraft, setKmDraft] = useState('');
  const [verTrip, setVerTrip] = useState(false);
  const [mas, setMas] = useState(false);
  const nMas = [tr.solicitadoPor, tr.episodios, tr.obs].filter((v) => v && String(v).trim()).length;
  const pideObs = tr.destino === 'Otro' || tr.destino === 'Policlínico en otra comuna';
  const sig = siguienteEtapa(tr);
  const cerrado = tr.estado !== 'en_curso';
  const vIda = velocidad(tr.km.salidaHF, tr.km.llegadaDest, tr.t.salidaHF, tr.t.llegadaDest);
  const vVuelta = velocidad(tr.km.llegadaDest, tr.km.llegadaHF, tr.t.salidaDest, tr.t.llegadaHF);
  const enRuta = minEntre(tr.t.salidaHF, tr.t.llegadaHF);
  const personas = (rol) => cfg.personal.filter((p) => p.rol === rol).map((p) => p.nombre);
  const faltan = [];
  if (!tr.motivo) faltan.push('motivo'); if (!tr.destino) faltan.push('destino'); if (!tr.conductor) faltan.push('conductor');
  if (!tr.tens) faltan.push('TENS');
  if (tr.avanzado && !(tr.apoyo || []).length) faltan.push('profesional del traslado avanzado');
  if (pideObs && !(tr.obs || '').trim()) faltan.push('lugar de destino');

  const setDato = (campo, valor) => {
    if (cerrado) { setModal({ tipo: 'dato-cerrado' }); return; }
    registrar(tr.id, 'DATO', campo, tr[campo], valor, '', (x) => ({ ...x, [campo]: valor }));
  };

  const marcar = (e) => {
    if (e.km && tr.t[e.k]) return; // falta solo km
    const ahora = new Date().toISOString();
    registrar(tr.id, 'ETAPA', `t.${e.k}`, null, ahora, '', (x) => ({ ...x, t: { ...x.t, [e.k]: ahora } }));
    if (e.km) setKmDraft(e.k === 'salidaHF' && ultimoKm != null ? String(ultimoKm) : '');
  };
  const ajustar = (e, iso) => {
    const antes = tr.t[e.k];
    registrar(tr.id, 'CORREGIR', `t.${e.k}`, antes, iso, motivoAjuste(antes),
      (x) => ({ ...x, t: { ...x.t, [e.k]: iso }, informadas: { ...(x.informadas || {}), [e.k]: true } }));
  };
  const ultimaK = cerrado ? null : ([...ETAPAS].reverse().find((e) => tr.t[e.k]) || {}).k;
  const guardarKm = (e) => {
    const v = num(kmDraft); if (v == null) return;
    registrar(tr.id, 'KM', `km.${e.k}`, null, v, '', (x) => {
      const km = { ...x.km, [e.k]: v };
      const extra = e.k === 'salidaHF' && ultimoKm != null ? { kmSinRegistro: v - ultimoKm } : {};
      return { ...x, km, ...extra };
    });
    setKmDraft('');
  };
  const kmPrevio = sig?.k === 'llegadaDest' ? num(tr.km.salidaHF) : sig?.k === 'llegadaHF' ? num(tr.km.llegadaDest) ?? num(tr.km.salidaHF) : null;
  const kmInvalido = sig?.km && tr.t[sig.k] && num(kmDraft) != null && kmPrevio != null && num(kmDraft) < kmPrevio;

  if (!abierto) {
    const color = tr.estado === 'anulado' ? t.dotOff : tr.estado === 'cerrado' ? t.dotOk : t.dotRun;
    return (
      <button type="button" onClick={() => setAbierto(tr.id)} className={`${t.card} w-full text-left rounded-lg p-4 mb-3 flex items-center gap-3 min-h-[76px] ${tr.estado === 'anulado' ? 'opacity-60' : ''}`}>
        <span className={`w-4 h-4 rounded-full shrink-0 ${color}`} />
        <div className="flex-1 min-w-0">
          <div className="font-extrabold truncate">{folioDe(tr)} · {tr.motivo || 'Sin motivo'}{tr.estado === 'anulado' ? ' · ANULADO' : ''}</div>
          <div className={`text-sm truncate ${t.muted}`}>{tr.destino || 'Sin destino'} · {tr.conductor || 'sin conductor'}</div>
        </div>
        <div className="text-right text-sm font-bold tabular-nums">
          <div>{hm(tr.t.salidaHF)}–{hm(tr.t.llegadaHF)}</div>
          <div className={tr.estado === 'en_curso' ? `${t.runText} font-bold` : ''}>{tr.estado === 'en_curso' ? (sig ? sig.l : 'Por cerrar') : `${fmtKm(kmTotal(tr))} km`}</div>
        </div>
        <ChevronDown />
      </button>
    );
  }

  return (
    <section className={`${t.card} rounded-lg p-4 mb-4 ${tr.estado === 'en_curso' ? t.run : ''}`}>
      <div className="flex items-start gap-2 mb-3">
        <div className="flex-1">
          <div className="text-xl font-black">N° {tr.folio ? <span className={`font-mono ${t.folio}`}>{tr.folio}</span> : <span className={`text-base ${t.muted}`}>pendiente (se asigna al sincronizar)</span>}</div>
          <div className={`text-sm ${t.muted}`}>{fmtFecha(tr.fecha)} · {tr.movil} · {tr.estado === 'en_curso' ? 'EN CURSO' : tr.estado.toUpperCase()}</div>
        </div>
        <button type="button" onClick={() => setAbierto(null)} className={`${t.btn} min-h-[52px] min-w-[52px] rounded-md flex items-center justify-center`} aria-label="Contraer"><ChevronUp /></button>
      </div>
      {tr.estado === 'anulado' && <p className={`mb-3 p-3 rounded-md ${t.voided} font-bold`}>Anulado: {tr.anulacion}</p>}

      {/* Etapas a un toque */}
      {!cerrado && <p className={`text-sm mb-2 ${t.muted}`}>Toque cada etapa: queda la hora actual y puede cambiarla ahí mismo. Una etapa anterior se cambia con «Corregir» (el valor original queda guardado).</p>}
      <div className="space-y-2 mb-3">
        {ETAPAS.map((e) => {
          const hecho = tr.t[e.k] && (!e.km || num(tr.km[e.k]) != null);
          const esSig = !cerrado && sig && sig.k === e.k;
          const pideKm = esSig && e.km && tr.t[e.k];
          return (
            <div key={e.k} className={`rounded-lg border-2 ${hecho ? t.doneLine : esSig ? t.next : t.line}`}>
              <div className="flex items-stretch gap-2 p-2">
                <button type="button" disabled={!esSig || pideKm} onClick={() => marcar(e)}
                  className={`flex-1 min-h-[72px] rounded-md font-black flex flex-col items-center justify-center ${hecho ? t.done : esSig && !pideKm ? `${t.primary} animate-pulse` : `${t.soft} opacity-80`}`}>
                  <span className="text-sm">{e.l}</span>
                  <span className="text-3xl tabular-nums">{tr.t[e.k] ? hm(tr.t[e.k]) : esSig ? 'TOCAR' : '--:--'}</span>
                  {(tr.informadas || {})[e.k] && <span className="text-xs font-bold">hora ajustada</span>}
                </button>
                {e.km && (
                  <div className={`w-32 rounded-md ${t.soft} flex flex-col items-center justify-center`}>
                    <span className={`text-xs font-bold ${t.muted}`}>Km</span>
                    <span className="text-xl font-black tabular-nums">{fmtKm(num(tr.km[e.k]))}</span>
                  </div>
                )}
                {tr.t[e.k] && tr.estado !== 'anulado' && ultimaK !== e.k && (
                  <button type="button" onClick={() => setModal({ tipo: 'corregir', tr, label: e.l, campo: `t.${e.k}`, actual: tr.t[e.k], kind: 'hora' })}
                    className={`${t.btn} min-w-[64px] px-1 rounded-md flex flex-col items-center justify-center text-xs font-bold`} aria-label={`Corregir ${e.l}`}><Pencil size={20} />Corregir</button>
                )}
              </div>
              {ultimaK === e.k && <AjusteHora tr={tr} etapa={e} onSave={(iso) => ajustar(e, iso)} />}
              {pideKm && (
                <div className="p-2 pt-0">
                  <div className="flex gap-2">
                    <Input autoFocus inputMode="numeric" placeholder="Km del odómetro" value={kmDraft} onChange={(ev) => setKmDraft(ev.target.value.replace(/\D/g, ''))} />
                    <Btn kind="primary" icon={Check} disabled={num(kmDraft) == null || kmInvalido} onClick={() => guardarKm(e)}>OK</Btn>
                  </div>
                  {kmInvalido && <p className={`${t.alert} font-bold mt-1`}>El km no puede ser menor que {fmtKm(kmPrevio)}.</p>}
                  {e.k === 'salidaHF' && ultimoKm != null && num(kmDraft) != null && num(kmDraft) > ultimoKm &&
                    <p className={`${t.warn} font-bold mt-1`}>⚠ {fmtKm(num(kmDraft) - ultimoKm)} km desde el último traslado registrado ({fmtKm(ultimoKm)}).</p>}
                </div>
              )}
              {e.km && num(tr.km[e.k]) != null && !pideKm && tr.estado !== 'anulado' && (
                <div className="px-2 pb-2 text-right">
                  <button type="button" className={`text-sm underline min-h-[40px] ${t.muted}`} onClick={() => setModal({ tipo: 'corregir', tr, label: `Km ${e.l}`, campo: `km.${e.k}`, actual: tr.km[e.k], kind: 'km' })}>Corregir km</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Indicadores del traslado */}
      <div className={`${t.soft} rounded-md p-3 mb-4 grid grid-cols-2 sm:grid-cols-3 gap-2 text-center`}>
        <div><div className={`text-xs font-bold ${t.muted}`}>Móvil fuera de HF</div><div className="font-black">{fmtMin(enRuta)}</div></div>
        <div><div className={`text-xs font-bold ${t.muted}`}>Km recorridos</div><div className="font-black">{fmtKm(kmTotal(tr))}</div></div>
        <div><div className={`text-xs font-bold ${t.muted}`}>Vel. prom. ida / vuelta*</div>
          <div className={`font-black ${(vIda > 100 || vVuelta > 100) ? t.alert : ''}`}>{vIda ?? '—'} / {vVuelta ?? '—'} km/h</div></div>
      </div>
      {tr.kmSinRegistro > 0 && <p className={`mb-3 font-bold ${t.warn}`}>⚠ {fmtKm(tr.kmSinRegistro)} km entre el traslado anterior y esta salida sin registro.</p>}

      {/* Datos del papel */}
      <Field label="Motivo de salida · obligatorio">
        <Seg options={MOTIVOS.map((m) => ({ k: m.k, l: `${m.n} · ${m.k}` }))} value={tr.motivo} onChange={(v) => setDato('motivo', v)} disabled={cerrado} />
      </Field>
      <Field label="Destino · obligatorio"><Select value={tr.destino} onChange={(v) => setDato('destino', v)} options={cfg.destinos} disabled={cerrado} /></Field>
      {/* Tripulación: viene del turno; se cambia aquí solo si este traslado salió con otra dupla */}
      <div className={`${t.soft} rounded-md p-3 mb-3`}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0"><div className={`text-sm font-bold ${t.muted}`}>Tripulación</div>
            <div className="font-bold truncate">{tr.conductor || 'Sin chofer'} · {tr.tens || 'Sin TENS'}</div></div>
          {!cerrado && <Btn className="!min-h-[48px] shrink-0" onClick={() => setVerTrip((v) => !v)}>{verTrip ? 'Listo' : 'Cambiar'}</Btn>}
        </div>
        {verTrip && !cerrado && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 mt-3">
            <Field label="Chofer"><Select value={tr.conductor} onChange={(v) => setDato('conductor', v)} options={personas('Conductor')} /></Field>
            <Field label="TENS"><Select value={tr.tens} onChange={(v) => setDato('tens', v)} options={personas('TENS')} /></Field>
          </div>
        )}
      </div>
      <div className="mb-3">
        <Casilla label="Traslado avanzado" checked={!!tr.avanzado} disabled={cerrado}
          onChange={(v) => registrar(tr.id, 'DATO', 'avanzado', !!tr.avanzado, v, '', (x) => ({ ...x, avanzado: v, apoyo: v ? (x.apoyo || []) : [] }))} />
        {tr.avanzado && (
          <div className="grid grid-cols-3 gap-2 mt-2">
            {APOYO.map((p) => <Casilla key={p} label={p} checked={(tr.apoyo || []).includes(p)} disabled={cerrado}
              onChange={(v) => setDato('apoyo', v ? [...(tr.apoyo || []), p] : (tr.apoyo || []).filter((q) => q !== p))} />)}
          </div>
        )}
      </div>
      <Field label="N° pacientes">
        <Seg compact options={['1', '2', '3']} value={String(tr.nPacientes)} onChange={(v) => setDato('nPacientes', Number(v))} disabled={cerrado} />
      </Field>
      {pideObs && (
        <Field label="Lugar · obligatorio para este destino">
          <TextoDato value={tr.obs} disabled={cerrado} onCommit={(v) => setDato('obs', v)} placeholder="Ej: Policlínico de Llanquihue" /></Field>
      )}
      <div className={`rounded-md border-2 ${t.line} mb-3`}>
        <button type="button" onClick={() => setMas((v) => !v)} className="w-full min-h-[56px] px-3 flex items-center justify-between font-bold">
          <span>Más datos (opcional){nMas ? ` · ${nMas} con dato` : ''}</span>{mas ? <ChevronUp /> : <ChevronDown />}</button>
        {mas && (
          <div className="px-3 pb-1">
            <Field label="Solicitado por (unidad)"><Select value={tr.solicitadoPor} onChange={(v) => setDato('solicitadoPor', v)} options={cfg.solicitantes} disabled={cerrado} /></Field>
            <Field label="N° DAU / episodio (sin nombres)" hint="La identidad del paciente queda en la ficha clínica.">
              <TextoDato value={tr.episodios} disabled={cerrado} onCommit={(v) => setDato('episodios', v)} placeholder="Ej: DAU 88533" /></Field>
            {!pideObs && (
              <Field label="Observaciones operativas">
                <TextoDato area value={tr.obs} disabled={cerrado} onCommit={(v) => setDato('obs', v)} placeholder="Breve, sin datos clínicos sensibles" /></Field>
            )}
            <p className={`text-xs mb-3 ${t.muted}`}>* Velocidad promedio calculada con km y horas registrados; es referencial (no reemplaza GPS). Se marca en rojo sobre 100 km/h.</p>
          </div>
        )}
      </div>
      {tr.estado === 'en_curso' && (
        <>
          {faltan.length > 0 && <p className={`mb-2 p-3 rounded-md ${t.warnBox} font-bold`}>Para cerrar falta: {faltan.join(', ')}{sig ? `, etapa "${sig.l}"` : ''}.</p>}
          <div className="flex gap-2">
            <Btn icon={Ban} className="flex-1" onClick={() => setModal({ tipo: 'anular', tr })}>Anular</Btn>
            <Btn icon={Check} kind="primary" className="flex-[2]" disabled={faltan.length > 0 || !!sig}
              onClick={() => setModal({ tipo: 'cerrar', tr, alCerrar: () => setAbierto(null) })}>Revisar y cerrar</Btn>
          </div>
        </>
      )}
      {tr.estado === 'cerrado' && tr.cerradoEn && <p className={`mb-3 p-3 rounded-md ${t.soft} font-bold`}>Cerrado por {tr.cerradoPor || '—'} a las {hm(tr.cerradoEn)} · Chofer {tr.conductor || '—'} · TENS {tr.tens || '—'}</p>}
      {tr.estado === 'cerrado' && <Btn icon={Ban} className="w-full" onClick={() => setModal({ tipo: 'anular', tr })}>Anular traslado (con motivo)</Btn>}
    </section>
  );
}

/* ==================================================================
   RESUMEN DEL DÍA / GESTIÓN
   ================================================================== */
function calcularDia(traslados, fecha) {
  const delDia = traslados.filter((x) => x.estado !== 'anulado' && x.t.salidaHF && fechaLocal(new Date(x.t.salidaHF)) === fecha);
  const porConductor = {};
  delDia.forEach((x) => {
    const n = x.conductor || 'Sin conductor';
    porConductor[n] = porConductor[n] || { salidas: 0, km: 0, min: 0, tramos: [] };
    porConductor[n].salidas++; porConductor[n].km += kmTotal(x) || 0;
    porConductor[n].min += minEntre(x.t.salidaHF, x.t.llegadaHF || new Date().toISOString()) || 0;
    porConductor[n].tramos.push([x.t.salidaHF, x.t.llegadaHF || new Date().toISOString()]);
  });
  // racha continua: tramos separados por menos de 30 min se consideran conducción continua
  Object.values(porConductor).forEach((c) => {
    const tr = c.tramos.sort((a, b) => new Date(a[0]) - new Date(b[0]));
    let max = 0, ini = null, fin = null;
    tr.forEach(([a, b]) => {
      if (fin && minEntre(fin, a) < 30) fin = b; else { ini = a; fin = b; }
      max = Math.max(max, minEntre(ini, fin));
    });
    c.racha = max;
  });
  const porMotivo = Object.fromEntries(MOTIVOS.map((m) => [m.k, delDia.filter((x) => x.motivo === m.k).length]));
  const fuera = delDia.reduce((a, x) => a + (minEntre(x.t.salidaHF, x.t.llegadaHF || new Date().toISOString()) || 0), 0);
  const kmSin = delDia.reduce((a, x) => a + (x.kmSinRegistro > 0 ? x.kmSinRegistro : 0), 0);
  const rapidos = delDia.filter((x) => (velocidad(x.km.salidaHF, x.km.llegadaDest, x.t.salidaHF, x.t.llegadaDest) || 0) > 100 || (velocidad(x.km.llegadaDest, x.km.llegadaHF, x.t.salidaDest, x.t.llegadaHF) || 0) > 100);
  return {
    delDia, porConductor, porMotivo, fuera, kmSin, rapidos,
    km: delDia.reduce((a, x) => a + (kmTotal(x) || 0), 0),
  };
}

function csv(traslados) {
  const cols = ['folio', 'estado', 'fecha', 'movil', 'motivo', 'destino', 'solicitado_por', 'autorizado_por', 'salida_hf', 'km_salida_hf',
    'llegada_destino', 'km_llegada_destino', 'salida_destino', 'llegada_hf', 'km_llegada_hf', 'km_recorridos', 'km_sin_registro_previo', 'chofer', 'tens', 'traslado_avanzado',
    'n_pacientes', 'episodios', 'observaciones', 'motivo_anulacion'];
  const f = (iso) => (iso ? `${fmtFecha(fechaLocal(new Date(iso)))} ${hm(iso)}` : '');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = traslados.map((x) => [folioDe(x), x.estado, fmtFecha(x.fecha), x.movil, x.motivo, x.destino, x.solicitadoPor, x.autorizadoPor,
    f(x.t.salidaHF), x.km.salidaHF, f(x.t.llegadaDest), x.km.llegadaDest, f(x.t.salidaDest), f(x.t.llegadaHF), x.km.llegadaHF, kmTotal(x), x.kmSinRegistro,
    x.conductor, x.tens, avanzadoTexto(x), x.nPacientes, x.episodios, x.obs, x.anulacion].map(esc).join(';'));
  return '﻿' + [cols.join(';'), ...rows].join('\r\n');
}

/* ==================================================================
   TRASLADOS DEL DÍA DE TODOS LOS EQUIPOS (se leen de la planilla; requiere señal)
   Permite anular un traslado registrado en otra tablet. La anulación es un evento más.
   ================================================================== */
/* ==================================================================
   MÓVILES: ¿está la ambulancia en base o fuera? (vista para la Urgencia; solo lee)
   ================================================================== */
/* Etapa de un traslado en curso según las horas marcadas */
function etapaMovil(tr) {
  if (!tr || !tr.salida) return { texto: 'Traslado creado, aún sin salida', desde: null };
  if (tr.salidaDest) return { texto: 'Volviendo a HF', desde: tr.salidaDest };
  if (tr.llegadaDest) return { texto: `En destino${tr.destino ? ' · ' + tr.destino : ''}`, desde: tr.llegadaDest };
  return { texto: `En camino${tr.destino ? ' a ' + tr.destino : ''}`, desde: tr.salida };
}
const haceTexto = (iso, ahora) => { const m = minEntre(iso, ahora); return m == null ? '' : m < 1 ? 'recién' : `hace ${fmtMin(m)}`; };

/* Sin señal: lo que sabe esta tablet */
function estadoLocal(movil, traslados) {
  const del = traslados.filter((x) => x.movil === movil && x.estado !== 'anulado');
  const abiertos = del.filter((x) => x.estado === 'en_curso').sort((a, b) => String(b.t.salidaHF || '').localeCompare(String(a.t.salidaHF || '')));
  const fuera = abiertos.filter((x) => x.t.salidaHF && !x.t.llegadaHF);
  const t = fuera[0] || abiertos[0] || null;
  const regresos = del.map((x) => x.t.llegadaHF).filter(Boolean).sort();
  return {
    movil, situacion: fuera.length ? 'fuera' : abiertos.length ? 'preparando' : 'base',
    traslado: t ? { folio: t.folio, motivo: t.motivo, destino: t.destino, chofer: t.conductor, tens: t.tens, avanzado: avanzadoTexto(t),
      salida: t.t.salidaHF || '', llegadaDest: t.t.llegadaDest || '', salidaDest: t.t.salidaDest || '' } : null,
    ultimoRegreso: regresos.length ? regresos[regresos.length - 1] : '', ultimoDato: '',
    salidasHoy: del.filter((x) => x.t.salidaHF && fechaLocal(new Date(x.t.salidaHF)) === fechaLocal()).length,
  };
}

function Moviles({ cfg, todos, online }) {
  const t = useT();
  const [datos, setDatos] = useState(null);
  const [origen, setOrigen] = useState('');
  const [cargando, setCargando] = useState(false);
  const [ahora, setAhora] = useState(new Date().toISOString());
  const cargar = async () => {
    setAhora(new Date().toISOString());
    if (!hayServidor() || !online) {
      setDatos({ moviles: cfg.moviles.map((m) => estadoLocal(m, todos)), inhabil: null });
      setOrigen(hayServidor() ? 'Sin señal: se muestra solo lo registrado en esta tablet.' : 'Vista previa con los datos de esta tablet.');
      return;
    }
    setCargando(true);
    try { setDatos(await gas('getEstadoMoviles')); setOrigen(''); }
    catch (e) { setDatos({ moviles: cfg.moviles.map((m) => estadoLocal(m, todos)), inhabil: null }); setOrigen('No se pudo leer la planilla: se muestra solo lo registrado en esta tablet.'); }
    setCargando(false);
  };
  useEffect(() => { cargar(); const i = setInterval(cargar, 60000); return () => clearInterval(i); }, [online]);
  useEffect(() => { const i = setInterval(() => setAhora(new Date().toISOString()), 30000); return () => clearInterval(i); }, []);

  const lista = datos ? datos.moviles : [];
  const enBase = lista.filter((m) => m.situacion !== 'fuera').length;
  return (
    <>
      <Card title="Móviles" icon={Ambulance} right={<Btn className="!min-h-[48px]" icon={RefreshCw} disabled={cargando} onClick={cargar}>{cargando ? 'Leyendo…' : 'Actualizar'}</Btn>}>
        {datos && (
          <p className="text-xl font-black mb-1">{enBase} de {lista.length} {lista.length === 1 ? 'móvil' : 'móviles'} en base</p>
        )}
        {datos && datos.inhabil != null && (
          <p className={`text-sm font-bold ${datos.inhabil ? t.warn : t.muted}`}>{datos.inhabil ? 'Ahora es horario inhábil: una sola ambulancia para la comuna.' : 'Ahora es horario hábil.'}</p>
        )}
        {origen && <p className={`text-sm mt-1 ${t.warn}`}>{origen}</p>}
        {!datos && <p className={t.muted}>Leyendo el estado de los móviles…</p>}
      </Card>
      {lista.map((m) => {
        const fuera = m.situacion === 'fuera';
        const et = fuera || m.situacion === 'preparando' ? etapaMovil(m.traslado) : null;
        return (
          <section key={m.movil} className={`${t.card} rounded-lg p-4 mb-3 border-l-8 ${fuera ? 'border-l-[#D6A94A]' : 'border-l-[#4F9468]'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className={`text-sm font-bold ${t.muted}`}>{m.movil}</div>
                <div className="text-3xl font-black">{fuera ? 'FUERA' : 'EN BASE'}</div>
              </div>
              <span className={`shrink-0 rounded-md px-3 py-2 font-bold ${fuera ? t.warnBox : t.ok + ' border-2'}`}>{fuera ? 'No disponible' : 'Disponible'}</span>
            </div>
            {fuera && et && (
              <div className="mt-2">
                <div className="text-lg font-bold">{et.texto}</div>
                <div className={t.muted}>Salió {m.traslado.salida ? hm(m.traslado.salida) : '--:--'} ({haceTexto(m.traslado.salida, ahora)}){et.desde && et.desde !== m.traslado.salida ? ` · ${et.texto.split(' ·')[0].toLowerCase()} desde ${hm(et.desde)}` : ''}</div>
                <div className={`text-sm mt-1 ${t.muted}`}>{m.traslado.folio || 'Folio pendiente'} · {m.traslado.motivo || 'Sin motivo'} · {m.traslado.chofer || 'sin chofer'} · {m.traslado.tens || 'sin TENS'}{m.traslado.avanzado ? ` · ${m.traslado.avanzado}` : ''}</div>
              </div>
            )}
            {!fuera && (
              <div className="mt-2">
                <div className={t.muted}>{m.ultimoRegreso ? `Volvió a HF a las ${hm(m.ultimoRegreso)} (${haceTexto(m.ultimoRegreso, ahora)})` : 'Sin regresos registrados'}</div>
                {m.situacion === 'preparando' && et && <div className={`text-sm font-bold mt-1 ${t.warn}`}>{et.texto}: {m.traslado.folio || 'folio pendiente'}</div>}
              </div>
            )}
            <div className={`text-xs mt-2 ${t.muted}`}>Salidas hoy: {m.salidasHoy}{m.ultimoDato ? ` · último dato recibido de la tablet: ${hm(m.ultimoDato)}` : ''}</div>
          </section>
        );
      })}
      <p className={`text-xs ${t.muted}`}>Se actualiza sola cada minuto. El estado depende de que la tablet del móvil tenga señal al marcar cada etapa.</p>
    </>
  );
}

function TodosDelDia({ fecha, todos, registrar, usuario, dispositivo, online, toast, aplicarAnulados, turno }) {
  const t = useT();
  const [lista, setLista] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [anulando, setAnulando] = useState(null);
  const locales = (f) => todos.filter((x) => x.fecha === f || (x.t.salidaHF && fechaLocal(new Date(x.t.salidaHF)) === f)).map((x) => ({
    id: x.id, folio: x.folio, estado: x.estado, movil: x.movil, motivo: x.motivo, destino: x.destino,
    salida: x.t.salidaHF || '', llegada: x.t.llegadaHF || '', chofer: x.conductor, registradoPor: x.registradoPor, anulacion: x.anulacion }));
  const cargar = async () => {
    setError('');
    if (!hayServidor()) { setLista(locales(fecha)); return; }
    if (!online) { setError('Sin señal: se muestran solo los traslados de esta tablet.'); setLista(locales(fecha)); return; }
    setCargando(true);
    try {
      const r = await gas('getTrasladosDia', fecha);
      setLista(r.traslados || []);
      aplicarAnulados(r.anulados || {});
    } catch (e) { setError('No se pudo leer la planilla. Se muestran solo los de esta tablet.'); setLista(locales(fecha)); }
    setCargando(false);
  };
  useEffect(() => { cargar(); }, [fecha, online]);

  const anular = async (motivo) => {
    const x = anulando; setAnulando(null);
    const local = todos.find((y) => y.id === x.id);
    if (local) {
      if (local.estado === 'anulado') return;
      registrar(local.id, 'ANULAR', 'estado', local.estado, 'anulado', motivo, (y) => ({ ...y, estado: 'anulado', anulacion: motivo }));
      setLista((l) => (l || []).map((y) => (y.id === x.id ? { ...y, estado: 'anulado', anulacion: motivo } : y)));
      toast('Traslado anulado (queda en el registro)');
      return;
    }
    try {
      await gas('anularTraslado', { trasladoId: x.id, motivo, usuario, dispositivo, turno });
      toast('Traslado anulado (queda en el registro)');
      cargar();
    } catch (e) { toast('No se pudo anular: ' + String(e && e.message || e).slice(0, 80)); }
  };

  const ordenados = (lista || []).slice().sort((a, b) => String(b.salida).localeCompare(String(a.salida)));
  return (
    <Card title="Traslados del día (todos los equipos)" icon={Route}
      right={<Btn className="!min-h-[48px]" icon={RefreshCw} disabled={cargando} onClick={cargar}>{cargando ? 'Leyendo…' : 'Actualizar'}</Btn>}>
      {error && <p className={`text-sm mb-2 ${t.warn}`}>{error}</p>}
      {lista && !ordenados.length && <p className={t.muted}>No hay traslados registrados el {fmtFecha(fecha)}.</p>}
      <div className="space-y-2">
        {ordenados.map((x) => {
          const esLocal = todos.some((y) => y.id === x.id);
          const puede = x.estado !== 'anulado' && (esLocal || (online && hayServidor()));
          return (
            <div key={x.id} className={`border ${t.line} rounded-md p-3 ${x.estado === 'anulado' ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-extrabold">{x.folio || 'Folio pendiente'} · {x.movil} · {x.motivo || 'Sin motivo'}</div>
                  <div className={`text-sm ${t.muted}`}>{x.destino || 'Sin destino'} · sale {x.salida ? hm(x.salida) : '--:--'} · vuelve {x.llegada ? hm(x.llegada) : '--:--'}</div>
                  <div className={`text-sm ${t.muted}`}>{x.estado === 'anulado' ? `Anulado: ${x.anulacion}` : x.estado === 'cerrado' ? 'Cerrado' : 'En curso'} · registró {x.registradoPor || '—'}{esLocal ? ' (esta tablet)' : ''}</div>
                </div>
                {x.estado !== 'anulado' && <Btn icon={Ban} className="!min-h-[48px] shrink-0" disabled={!puede}
                  onClick={() => { if (!turno) { toast(AVISO_TURNO); return; } setAnulando(x); }}>Anular</Btn>}
              </div>
            </div>
          );
        })}
      </div>
      {!online && <p className={`text-xs mt-2 ${t.muted}`}>Anular un traslado de otra tablet requiere señal.</p>}
      {anulando && <Anular tr={anulando} onClose={() => setAnulando(null)} onSave={anular} />}
    </Card>
  );
}

function Resumen({ st, toast, setModal, todos, registrar, dispositivo, online, aplicarAnulados, turno }) {
  const t = useT();
  const [fecha, setFecha] = useState(fechaLocal());
  const r = useMemo(() => calcularDia(st.traslados, fecha), [st.traslados, fecha]);
  const maxMin = Math.max(1, ...Object.values(r.porConductor).map((c) => c.min));
  const texto = [
    `🚑 *Traslados ${st.movil} – ${HOSPITAL}*`, `📅 ${fmtFecha(fecha)}`,
    `📋 Salidas: ${r.delDia.length} (Urgencia ${r.porMotivo['Urgencia']} · Programado ${r.porMotivo['Programado']} · Rescate ${r.porMotivo['Rescate comunal']})`,
    `🛣️ Km: ${fmtKm(r.km)} · ⏱️ Móvil fuera de HF: ${fmtMin(r.fuera)}`,
    ...Object.entries(r.porConductor).map(([n, c]) => `👤 ${n}: ${c.salidas} sal. · ${fmtKm(c.km)} km · ${fmtMin(c.min)} en ruta · racha máx ${fmtMin(c.racha)}`),
    ...(r.kmSin > 0 ? [`⚠️ Km sin registro entre traslados: ${fmtKm(r.kmSin)}`] : []),
    ...(r.rapidos.length ? [`⚠️ Tramos con vel. prom. >100 km/h: ${r.rapidos.map(folioDe).join(', ')}`] : []),
  ].join('\n');

  return (
    <>
      <Card title="Resumen de gestión" icon={FileText} right={<Input type="date" className="!w-auto !min-h-[48px] !text-base" value={fecha} onChange={(e) => setFecha(e.target.value)} />}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {[['Salidas', r.delDia.length], ['Km', fmtKm(r.km)], ['Móvil fuera de HF', fmtMin(r.fuera)]].map(([l, v]) => (
            <div key={l} className={`${t.soft} rounded-md p-3`}><div className={`text-xs font-bold ${t.muted}`}>{l}</div><div className="text-2xl font-black tabular-nums">{v}</div></div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2 mt-2">
          {MOTIVOS.map((m) => <div key={m.k} className={`${t.soft} rounded-md p-2 text-center`}><div className={`text-xs font-bold ${t.muted}`}>{m.n} · {m.k}</div><div className="text-xl font-black">{r.porMotivo[m.k]}</div></div>)}
        </div>
        {(r.kmSin > 0 || r.rapidos.length > 0) && (
          <div className={`mt-3 p-3 rounded-md ${t.warnBox} font-bold space-y-1`}>
            {r.kmSin > 0 && <p>⚠ {fmtKm(r.kmSin)} km recorridos sin traslado registrado.</p>}
            {r.rapidos.length > 0 && <p>⚠ Velocidad promedio &gt;100 km/h en: {r.rapidos.map(folioDe).join(', ')}.</p>}
          </div>
        )}
      </Card>

      <Card title="Carga por conductor" icon={Users}>
        {Object.keys(r.porConductor).length === 0 && <p className={t.muted}>Sin salidas este día.</p>}
        {Object.entries(r.porConductor).map(([n, c]) => (
          <div key={n} className="mb-4">
            <div className="flex justify-between font-bold gap-2 flex-wrap"><span>{n}</span><span className="tabular-nums">{c.salidas} sal. · {fmtKm(c.km)} km · {fmtMin(c.min)}</span></div>
            <div className={`${t.soft} h-4 rounded-full overflow-hidden mt-1`}><div className="h-full bg-[#4A78AE]" style={{ width: `${(c.min / maxMin) * 100}%` }} /></div>
            <div className={`text-sm mt-1 ${c.racha >= 240 ? `${t.alert} font-bold` : t.muted}`}>Conducción continua máx.: {fmtMin(c.racha)}{c.racha >= 240 ? ' — revisar descanso' : ''}</div>
          </div>
        ))}
        <p className={`text-xs ${t.muted}`}>Conducción continua: traslados separados por menos de 30 min se suman como un solo bloque.</p>
      </Card>

      <TodosDelDia fecha={fecha} todos={todos} registrar={registrar} usuario={st.usuario} dispositivo={dispositivo} online={online} toast={toast} aplicarAnulados={aplicarAnulados} turno={turno} />

      <Card title="Exportar" icon={Download}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Btn icon={Copy} className="!bg-[#2F7A4D] !text-white !border-[#24603C]" onClick={async () => toast((await copiarTexto(texto)) ? 'Resumen copiado para WhatsApp' : 'No se pudo copiar')}>Copiar para WhatsApp</Btn>
          <Btn icon={Download} onClick={async () => { const c = csv(st.traslados.filter((x) => x.fecha === fecha || (x.t.salidaHF && fechaLocal(new Date(x.t.salidaHF)) === fecha))); const ok = await descargar(`traslados_${fecha}.csv`, c); setModal({ tipo: 'csv', csv: c, ok }); }}>Exportar CSV del día</Btn>
        </div>
        <details className="mt-3"><summary className="font-bold cursor-pointer min-h-[48px] flex items-center">Vista previa</summary>
          <pre className={`${t.soft} rounded-md p-3 text-sm whitespace-pre-wrap`}>{texto}</pre></details>
      </Card>
    </>
  );
}

/* Lista de personas con "+ Agregar otro nombre…" al final */
function SelectPersona({ value, onChange, options, placeholder, onAgregar }) {
  const t = useT();
  const [agregando, setAgregando] = useState(false);
  const [texto, setTexto] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const cancelar = () => { setAgregando(false); setTexto(''); setError(''); };
  const guardar = async () => {
    if (texto.trim().length < 3) { setError('Escribe al menos 3 letras'); return; }
    setGuardando(true); setError('');
    try { const r = await onAgregar(texto); onChange(r.nombre); cancelar(); }
    catch (e) { setError(String((e && e.message) || e).replace(/^Error:\s*/, '').slice(0, 140)); }
    setGuardando(false);
  };
  if (agregando) {
    return (
      <div className={`border-2 ${t.line} rounded-md p-2`}>
        <Input autoFocus value={texto} maxLength={60} placeholder="Nombre y apellido" disabled={guardando}
          onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); guardar(); } }} />
        {error && <p className={`text-sm mt-1 font-bold ${t.alert}`}>{error}</p>}
        <div className="flex gap-2 mt-2">
          <Btn kind="primary" icon={Check} className="flex-1" disabled={guardando || texto.trim().length < 3} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar'}</Btn>
          <Btn icon={X} className="flex-1" disabled={guardando} onClick={cancelar}>Cancelar</Btn>
        </div>
      </div>
    );
  }
  return (
    <select value={value || ''} onChange={(e) => { if (e.target.value === AGREGAR) { setAgregando(true); return; } onChange(e.target.value); }}
      className={`${t.input} w-full min-h-[52px] rounded-md px-3 text-lg font-semibold`}>
      <option value="">{placeholder || 'Seleccionar…'}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
      <option value={AGREGAR}>+ Agregar otro nombre…</option>
    </select>
  );
}

/* Paso obligatorio: turno en este equipo. Abierto hasta confirmar; luego una línea de resumen con "Cambiar". */
function TurnoEquipo({ turno, draft, setDraft, onConfirmar, onCambiar, cfg, ultimoKmDe, onAgregar }) {
  const t = useT();
  const personas = (rol) => cfg.personal.filter((p) => p.rol === rol).map((p) => p.nombre);
  if (turno) {
    return (
      <section className={`${t.card} rounded-lg p-3 mb-4 flex items-center gap-3`}>
        <Users size={22} className={`shrink-0 ${t.title}`} />
        <p className="flex-1 min-w-0 font-bold leading-snug">
          {turno.movil} · Chofer: {turno.chofer} · TENS: {turno.tens} · Registra: {turno.usuario} · Último km: {fmtKm(ultimoKmDe(turno.movil))}
        </p>
        <Btn icon={Pencil} className="shrink-0 !min-h-[52px]" onClick={onCambiar}>Cambiar</Btn>
      </section>
    );
  }
  const completo = turnoCompleto(draft);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  return (
    <Card title="Turno en este equipo" icon={Users} className="ring-2 ring-[#0F69C4]">
      <p className={`text-sm mb-3 ${t.muted}`}>Paso obligatorio: completa los 4 datos y confirma el turno para empezar a registrar.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Móvil"><Seg options={cfg.moviles} value={draft.movil} onChange={set('movil')} /></Field>
        <Field label="Quién registra en esta tablet"><SelectPersona value={draft.usuario} onChange={set('usuario')} options={cfg.personal.map((p) => p.nombre)} onAgregar={(n) => onAgregar(n, 'Conductor')} /></Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Chofer de turno"><SelectPersona value={draft.chofer} onChange={set('chofer')} options={personas('Conductor')} onAgregar={(n) => onAgregar(n, 'Conductor')} /></Field>
        <Field label="TENS de turno"><SelectPersona value={draft.tens} onChange={set('tens')} options={personas('TENS')} onAgregar={(n) => onAgregar(n, 'TENS')} /></Field>
      </div>
      <p className={`text-sm ${t.muted}`}><Gauge size={14} className="inline" /> Último km registrado de {draft.movil || 'móvil'}: <b>{draft.movil ? fmtKm(ultimoKmDe(draft.movil)) : '—'}</b></p>
      {completo
        ? <Btn kind="primary" icon={Check} className="w-full mt-3 !min-h-[64px] !text-xl" onClick={onConfirmar}>Confirmar turno</Btn>
        : <p className={`text-sm mt-3 font-bold ${t.warn}`}>Faltan: {[['movil', 'móvil'], ['usuario', 'quién registra'], ['chofer', 'chofer'], ['tens', 'TENS']].filter(([k]) => !String(draft[k] || '').trim()).map(([, l]) => l).join(', ')}.</p>}
    </Card>
  );
}

/* ==================================================================
   APP
   ================================================================== */
function App() {
  const [st, setSt] = useState(() => cargarLS(STORE, null) || (hayServidor() ? { ...demo(), traslados: [], abierto: null, usuario: '', tripulacion: { conductor: '', tens: '', medico: '' } } : demo()));
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  const [sync, setSync] = useState({ estado: hayServidor() ? 'listo' : 'demo', msg: '' });
  const [modal, setModal] = useState(null);
  const [msg, setMsg] = useState(null);
  const dev = useRef(dispositivoId());
  const enviando = useRef(false);
  const t = THEMES[st.theme];
  const cfg = st.config || DEFAULT_CONFIG;

  /* Turno confirmado (vigente ≤ 12 h) y borrador mientras se completa */
  const [turno, setTurno] = useState(() => leerTurno());
  const [draft, setDraft] = useState(() => leerTurno() || { movil: '', usuario: '', chofer: '', tens: '' });
  const turnoRef = useRef(turno);
  turnoRef.current = turno;
  const bloqueado = !turno;
  const restoRef = useRef(null);
  useEffect(() => {   // el turno confirmado manda sobre móvil, quién registra y tripulación
    if (turno) setSt((s) => ({ ...s, movil: turno.movil, usuario: turno.usuario, tripulacion: { ...s.tripulacion, conductor: turno.chofer, tens: turno.tens } }));
  }, [turno]);
  useEffect(() => {   // vence a las 12 h: vuelve a ser obligatorio
    const i = setInterval(() => {
      const x = turnoRef.current;
      if (x && !turnoVigente(x)) { borrarTurno(); setTurno(null); setDraft({ movil: x.movil, usuario: '', chofer: '', tens: '' }); setMsg(`El turno venció (${TURNO_HORAS} h). Confírmalo de nuevo.`); }
    }, 60000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {   // contenido bloqueado: visible pero sin foco ni teclado
    const el = restoRef.current; if (!el) return;
    if (bloqueado) el.setAttribute('inert', ''); else el.removeAttribute('inert');
  }, [bloqueado, st.tab]);
  const confirmarTurno = () => {
    if (!turnoCompleto(draft)) { setMsg(AVISO_TURNO); return; }
    const x = { movil: draft.movil, usuario: draft.usuario, chofer: draft.chofer, tens: draft.tens, confirmadoEn: Date.now() };
    guardarTurno(x); setTurno(x); setMsg('Turno confirmado');
  };
  const cambiarTurno = () => { borrarTurno(); if (turno) setDraft({ movil: turno.movil, usuario: turno.usuario, chofer: turno.chofer, tens: turno.tens }); setTurno(null); };
  const turnoEvento = () => { const x = turnoRef.current; return x ? { movil: x.movil, usuario: x.usuario, chofer: x.chofer, tens: x.tens } : null; };

  /* "+ Agregar otro nombre…": lo escribe en la hoja Personal (servidor) y queda en la lista de todos los equipos */
  const agregarPersona = async (nombre, rol) => {
    if (!hayServidor()) {   // vista previa: solo en este equipo
      const n = normalizarNombre(nombre);
      if ((n.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length < 3) throw new Error('El nombre debe tener al menos 3 letras');
      const ya = cfg.personal.find((p) => p.rol === rol && claveNombre(p.nombre) === claveNombre(n));
      if (ya) { setMsg(`Ya estaba en la lista: ${ya.nombre}`); return { nombre: ya.nombre }; }
      setSt((s) => ({ ...s, config: { ...(s.config || DEFAULT_CONFIG), personal: [...(s.config || DEFAULT_CONFIG).personal, { nombre: n, rol }] } }));
      return { nombre: n };
    }
    if (!online) throw new Error('Se necesita señal para agregar un nombre a la planilla.');
    const r = await gas('agregarPersona', { nombre, rol });
    setSt((s) => ({ ...s, config: { ...(s.config || DEFAULT_CONFIG), personal: r.personal } }));
    setMsg(r.existente ? `Ya estaba en la lista: se seleccionó ${r.nombre}` : `${r.nombre} agregado a la lista`);
    return r;
  };

  useEffect(() => { guardarLS(STORE, st); }, [st]);
  useEffect(() => { const on = () => setOnline(true), off = () => setOnline(false); window.addEventListener('online', on); window.addEventListener('offline', off); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); }; }, []);
  useEffect(() => { if (!msg) return; const i = setTimeout(() => setMsg(null), 3500); return () => clearTimeout(i); }, [msg]);

  /* Cargar personal, destinos y último km desde la planilla */
  useEffect(() => {
    if (!hayServidor()) return;
    gas('getConfig').then((c) => { setSt((s) => ({ ...s, config: { ...DEFAULT_CONFIG, ...c.config }, ultimoKmServidor: c.ultimoKm || {} })); aplicarAnulados(c.anulados); })
      .catch(() => setSync({ estado: 'error', msg: 'No se pudo leer la configuración' }));
  }, []);

  /* Envío de la cola de eventos */
  const enviar = async () => {
    if (!hayServidor() || enviando.current) return;
    const lote = cargarLS(STORE, st).cola.slice(0, 40);
    if (!lote.length) return;
    enviando.current = true; setSync({ estado: 'enviando', msg: '' });
    try {
      const r = await gas('syncEventos', lote);
      const rech = (r.rechazados || []).map((x) => x.id);
      if (rech.length) setMsg(`${rech.length} registro(s) no se guardaron: faltaba el turno en este equipo`);
      setSt((s) => ({
        ...s, ultimoSync: new Date().toISOString(),
        cola: s.cola.filter((e) => !r.ok.includes(e.id) && !rech.includes(e.id)),
        rechazados: rech.length ? [...(s.rechazados || []), ...s.cola.filter((e) => rech.includes(e.id))] : s.rechazados,
        traslados: s.traslados.map((x) => {
          let y = r.folios[x.id] && !x.folio ? { ...x, folio: r.folios[x.id] } : x;
          if (r.anulados && r.anulados[x.id] && y.estado !== 'anulado') y = { ...y, estado: 'anulado', anulacion: r.anulados[x.id] };
          return y;
        }),
      }));
      setSync({ estado: 'listo', msg: '' });
    } catch (e) { setSync({ estado: 'error', msg: String(e && e.message || e).slice(0, 120) }); }
    enviando.current = false;
  };
  useEffect(() => { if (st.cola.length && online) enviar(); }, [st.cola.length, online]);
  useEffect(() => { const i = setInterval(() => { if (navigator.onLine !== false) enviar(); }, 30000); return () => clearInterval(i); }, []);

  /* Anulaciones registradas desde otra tablet: { trasladoId: motivo } */
  const aplicarAnulados = (mapa) => {
    if (!mapa || !Object.keys(mapa).length) return;
    setSt((s) => ({ ...s, traslados: s.traslados.map((x) => (mapa[x.id] && x.estado !== 'anulado' ? { ...x, estado: 'anulado', anulacion: mapa[x.id] } : x)) }));
  };

  /* Registrar un evento: aplica el cambio y lo deja en cola (append-only) */
  const registrar = (trasladoId, tipo, campo, anterior, nuevo, motivo, mutar) => {
    const tv = turnoEvento();
    if (!tv) { setMsg(AVISO_TURNO); return; }
    setSt((s) => {
      let snap = null;
      const traslados = s.traslados.map((x) => { if (x.id !== trasladoId) return x; snap = mutar(x); return snap; });
      const ev = { id: uid(), tsDispositivo: new Date().toISOString(), dispositivo: dev.current, usuario: s.usuario, movil: snap.movil,
        trasladoId, tipo, campo, anterior: anterior ?? '', nuevo: nuevo ?? '', motivo: motivo || '', snapshot: snap, turno: tv };
      return { ...s, traslados, cola: [...s.cola, ev] };
    });
  };

  const ultimoKmDe = (movil) => {
    const locales = st.traslados.filter((x) => x.movil === movil && x.estado !== 'anulado' && num(x.km.llegadaHF) != null).map((x) => x.km.llegadaHF);
    const srv = num((st.ultimoKmServidor || {})[movil]);
    const todos = [...locales, ...(srv != null ? [srv] : [])];
    return todos.length ? Math.max(...todos) : null;
  };
  const ultimoKm = useMemo(() => ultimoKmDe(st.movil), [st.traslados, st.movil, st.ultimoKmServidor]);

  const nuevo = () => {
    const tv = turnoEvento();
    if (!tv) { setMsg(AVISO_TURNO); return; }
    const tr = trasladoBase({ movil: tv.movil, conductor: tv.chofer, tens: tv.tens, registradoPor: tv.usuario });
    const ev = { id: uid(), tsDispositivo: new Date().toISOString(), dispositivo: dev.current, usuario: tv.usuario, movil: tv.movil,
      trasladoId: tr.id, tipo: 'CREAR', campo: '', anterior: '', nuevo: '', motivo: '', snapshot: tr, turno: tv };
    setSt((s) => ({ ...s, tab: 'traslados', abierto: tr.id, traslados: [tr, ...s.traslados], cola: [...s.cola, ev] }));
  };

  const personas = (rol) => cfg.personal.filter((p) => p.rol === rol).map((p) => p.nombre);
  const visibles = st.traslados.filter((x) => x.movil === st.movil);
  const enCurso = visibles.filter((x) => x.estado === 'en_curso');
  const recientes = visibles.filter((x) => x.estado !== 'en_curso').slice(0, 30);

  const pill = sync.estado === 'demo' ? { c: 'bg-[#6B7684] text-white', i: CloudOff, l: 'Modo demo · solo este equipo' }
    : !online ? { c: 'bg-[#B02E3A] text-white', i: CloudOff, l: `Sin señal · ${st.cola.length} en cola` }
    : sync.estado === 'error' ? { c: 'bg-[#B02E3A] text-white', i: AlertTriangle, l: `Error de envío · ${st.cola.length} en cola` }
    : st.cola.length ? { c: 'bg-[#E2C15E] text-[#2B2200]', i: RefreshCw, l: `${st.cola.length} por enviar` }
    : { c: 'bg-[#2F7A4D] text-white', i: Cloud, l: `Sincronizado ${st.ultimoSync ? hm(st.ultimoSync) : ''}` };

  return (
    <Th.Provider value={t}>
      <div className={`${t.page} min-h-screen pb-28`} style={{ fontFamily: "gobCL, Roboto, 'Helvetica Neue', Arial, sans-serif" }}>
        <header className={`${t.head} sticky top-0 z-20`}>
          <div className="flex h-2" aria-hidden="true"><div className="w-1/3 bg-[#0F69C4]" /><div className="flex-1 bg-[#EB3C46]" /></div>
          <div className="max-w-3xl mx-auto flex items-center gap-3 px-3 py-2">
            <div className="shrink-0 border-r-2 border-[#9DB4D2] pr-3 leading-tight">
              <div className="text-[11px] font-bold opacity-80">Servicio de Salud<br />del Reloncaví</div>
              <div className="text-sm font-black">Hospital de Frutillar</div>
            </div>
            <div className="flex-1 min-w-0"><div className="font-black text-lg leading-tight">Bitácora de Ambulancia</div><div className="text-xs opacity-80">Registro de traslados · piloto</div></div>
            <button type="button" onClick={() => { if (hayServidor()) enviar(); }} className={`${pill.c} text-xs font-bold px-2 py-2 rounded-md flex items-center gap-1 min-h-[44px]`}><pill.i size={14} /><span className="hidden sm:inline">{pill.l}</span><span className="sm:hidden">{sync.estado === 'demo' ? 'Demo' : st.cola.length || '✓'}</span></button>
            <button type="button" onClick={() => setSt((s) => ({ ...s, theme: s.theme === 'day' ? 'night' : 'day' }))} aria-label="Cambiar modo día / noche"
              className={`min-h-[52px] px-3 rounded-md font-black flex items-center gap-1 border-2 ${st.theme === 'day' ? 'bg-white text-[#1B2B44] border-[#7E9BC0]' : 'bg-[#1A2D47] text-[#E3C47E] border-[#5D86BA]'}`}>
              {st.theme === 'day' ? <Sun size={22} /> : <Moon size={22} />}<span className="hidden sm:inline">{st.theme === 'day' ? 'Día' : 'Noche'}</span></button>
          </div>
          {sync.msg && <div className={`max-w-3xl mx-auto text-xs ${t.alert} px-3 pb-1`}>{sync.msg}</div>}
        </header>

        <main className="max-w-3xl mx-auto p-3">
          {st.tab === 'traslados' && (
            <>
              <TurnoEquipo turno={turno} draft={draft} setDraft={setDraft} onConfirmar={confirmarTurno} onCambiar={cambiarTurno}
                cfg={cfg} ultimoKmDe={ultimoKmDe} onAgregar={agregarPersona} />

              <div className="relative">
              {bloqueado && <button type="button" aria-label={AVISO_TURNO} onClick={() => setMsg(AVISO_TURNO)}
                className="absolute inset-0 z-10 w-full h-full bg-transparent cursor-not-allowed" />}
              <div ref={restoRef} aria-hidden={bloqueado} className={bloqueado ? 'opacity-40 pointer-events-none select-none' : ''}>
              <button type="button" onClick={nuevo} className={`${t.primary} w-full min-h-[88px] rounded-lg text-2xl font-black flex items-center justify-center gap-3 mb-4 active:scale-95 transition`}>
                <Plus size={34} /> Nuevo traslado
              </button>

              {enCurso.length > 0 && <h3 className="font-black text-lg mb-2 flex items-center gap-2"><Clock size={20} /> En curso ({enCurso.length})</h3>}
              {enCurso.map((tr) => <Traslado key={tr.id} tr={tr} abierto={st.abierto === tr.id} setAbierto={(id) => setSt((s) => ({ ...s, abierto: id }))} cfg={cfg} ultimoKm={ultimoKm} registrar={registrar} setModal={setModal} />)}
              <h3 className="font-black text-lg mb-2 mt-4 flex items-center gap-2"><Route size={20} /> Registrados</h3>
              {recientes.length === 0 && <p className={t.muted}>Aún no hay traslados cerrados en {st.movil}.</p>}
              {recientes.map((tr) => <Traslado key={tr.id} tr={tr} abierto={st.abierto === tr.id} setAbierto={(id) => setSt((s) => ({ ...s, abierto: id }))} cfg={cfg} ultimoKm={ultimoKm} registrar={registrar} setModal={setModal} />)}
              </div>
              </div>
            </>
          )}
          {st.tab === 'moviles' && <Moviles cfg={cfg} todos={st.traslados} online={online} />}
          {st.tab === 'resumen' && <Resumen st={{ ...st, traslados: visibles }} toast={setMsg} setModal={setModal} todos={st.traslados} registrar={registrar}
            dispositivo={dev.current} online={online} aplicarAnulados={aplicarAnulados} turno={turno ? turnoEvento() : null} />}
          {sync.estado === 'demo' && (
            <p className={`text-center text-xs mt-6 ${t.muted}`}>Vista previa con datos de ejemplo. Instalada desde la planilla institucional, los eventos se envían a Google Sheets.
              <button type="button" className="underline ml-1 min-h-[44px]" onClick={() => { setSt(demo()); setMsg('Datos de ejemplo restablecidos'); }}>Restablecer ejemplo</button></p>
          )}
          <p className={`text-center text-xs mt-6 ${t.muted}`}>Hospital de Frutillar · Servicio de Salud del Reloncaví · Ministerio de Salud</p>
        </main>

        <nav className={`${t.nav} fixed bottom-0 inset-x-0 z-20`}>
          <div className="max-w-3xl mx-auto grid grid-cols-3">
            {[['traslados', 'Traslados', Route], ['moviles', 'Móviles', Ambulance], ['resumen', 'Resumen', FileText]].map(([k, l, I]) => (
              <button key={k} type="button" onClick={() => setSt((s) => ({ ...s, tab: k }))} className={`${st.tab === k ? t.on : t.btn} !border-0 min-h-[72px] flex flex-col items-center justify-center font-extrabold gap-1`}>
                <I size={26} />{l}{k === 'traslados' && enCurso.length > 0 ? ` (${enCurso.length})` : ''}</button>
            ))}
          </div>
        </nav>

        {msg && <div className="fixed bottom-24 inset-x-3 z-40 mx-auto max-w-md bg-black text-white font-bold rounded-md p-4 text-center shadow-2xl border-2 border-white">{msg}</div>}

        {modal?.tipo === 'corregir' && (
          <Correccion c={{ label: modal.label, actual: modal.actual, tipo: modal.kind, tr: modal.tr, campo: modal.campo }} onClose={() => setModal(null)}
            onSave={(valor, motivo) => {
              const [grupo, k] = modal.campo.split('.');
              registrar(modal.tr.id, 'CORREGIR', modal.campo, modal.actual, valor, motivo, (x) => ({ ...x, [grupo]: { ...x[grupo], [k]: valor } }));
              setModal(null); setMsg('Corrección registrada con motivo');
            }} />
        )}
        {modal?.tipo === 'cerrar' && <CerrarTraslado tr={st.traslados.find((x) => x.id === modal.tr.id) || modal.tr} usuario={st.usuario} onClose={() => setModal(null)}
          onSave={() => {
            const ahora = new Date().toISOString();
            registrar(modal.tr.id, 'CERRAR', 'estado', 'en_curso', 'cerrado', '', (x) => ({ ...x, estado: 'cerrado', cerradoPor: st.usuario, cerradoEn: ahora }));
            modal.alCerrar(); setModal(null); setMsg('Traslado cerrado');
          }} />}
        {modal?.tipo === 'anular' && <Anular tr={modal.tr} onClose={() => setModal(null)} onSave={(motivo) => {
          registrar(modal.tr.id, 'ANULAR', 'estado', modal.tr.estado, 'anulado', motivo, (x) => ({ ...x, estado: 'anulado', anulacion: motivo }));
          setModal(null); setMsg('Traslado anulado (queda en el registro)');
        }} />}
        {modal?.tipo === 'dato-cerrado' && (
          <Modal titulo="Traslado cerrado" onClose={() => setModal(null)}>
            <p className="mb-3">Los datos de un traslado cerrado no se editan. Si hay un error, anule el traslado con motivo y registre uno nuevo, o corrija horas y km con «Corregir».</p>
            <Btn className="w-full" onClick={() => setModal(null)}>Entendido</Btn>
          </Modal>
        )}
        {modal?.tipo === 'csv' && (
          <Modal titulo="CSV del día" onClose={() => setModal(null)}>
            <p className="text-sm mb-2">Si la descarga no comenzó, copie el contenido y péguelo en Excel (separador punto y coma).</p>
            <textarea readOnly rows={7} value={modal.csv} className={`${t.input} w-full rounded-md p-2 text-xs font-mono`} />
            <Btn icon={Copy} kind="primary" className="w-full mt-2" onClick={async () => setMsg((await copiarTexto(modal.csv)) ? 'CSV copiado' : 'No se pudo copiar')}>Copiar CSV</Btn>
          </Modal>
        )}
      </div>
    </Th.Provider>
  );
}

function Anular({ tr, onClose, onSave }) {
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo={`Anular ${folioDe(tr)}`} onClose={onClose}>
      <p className="mb-3">El traslado no se borra: queda marcado como anulado en la planilla, con su motivo y quién lo anuló.</p>
      <Field label="Motivo de anulación (obligatorio)"><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej: traslado suspendido, duplicado" /></Field>
      <Btn kind="primary" icon={Ban} className="w-full" disabled={motivo.trim().length < 5} onClick={() => onSave(motivo.trim())}>Anular traslado</Btn>
    </Modal>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
