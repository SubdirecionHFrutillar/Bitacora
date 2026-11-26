/**
 * BITÁCORA DIGITAL DE TRASLADOS — HOSPITAL DE FRUTILLAR (PILOTO)
 * Backend en Google Apps Script sobre una planilla institucional.
 *
 * Hojas:
 *  - Bitácora    : espejo de Traslados con el formato del talonario de papel (protegida; la rehace el script).
 *  - Eventos     : libro append-only. Cada toque/corrección/anulación es una fila. Nunca se edita.
 *  - Traslados   : vista consolidada (1 fila por traslado), la reescribe el script con el último estado.
 *  - Personal    : nombre | rol (Conductor / TENS / Médico) | activo (SI/NO)  ← la edita el administrador
 *  - Config      : tipo (movil / destino / solicitante) | valor                ← la edita el administrador
 *  - Integridad  : respaldo diario de Eventos en Drive + huella SHA-256
 *  - Panel       : fuente para Looker Studio (1 fila por traslado cerrado, conductores con seudónimo).
 *                  La reescribe actualizarPanel() cada hora. Config tipo "feriado" (aaaa-mm-dd) = día inhábil.
 *
 * Instalación: ejecutar setup() una vez, luego Implementar > Nueva implementación > Aplicación web
 * (Ejecutar como: Yo · Acceso: Cualquier usuario).
 *
 * La app de las tablets es una PWA en GitHub Pages (ver CLAUDE.md). Habla con este script SOLO por doPost(),
 * con un token por tablet. Las funciones que tocan la planilla terminan en "_" (privadas): google.script.run
 * no puede llamarlas y el editor no las muestra para ejecutar. NO quitar el guion bajo final.
 * Para publicar un cambio: Implementar > Gestionar implementaciones > (lápiz) > Versión: Nueva versión.
 * NUNCA "Nueva implementación": cambia la URL /exec y las tablets quedan sin servidor.
 */

const PREFIJO_FOLIO = 'D-';
/* Destinos (categorías que usa el panel). Los anteriores quedan en Config como tipo "destino_anterior". */
const DESTINOS = ['HPM', 'Clínica Puerto Varas (TAC RIU)', 'Diálisis', 'Policlínico en otra comuna', 'Rescate comunal', 'Alta a domicilio', 'Otro'];
const CARPETA_RESPALDO = 'Respaldo Bitácora Ambulancia HF';

const HOJAS = {
  Eventos: ['ts_servidor', 'ts_dispositivo', 'desfase_min', 'evento_id', 'dispositivo', 'usuario', 'movil', 'traslado_id', 'folio',
    'tipo', 'campo', 'valor_anterior', 'valor_nuevo', 'motivo', 'cuenta_google'],
  Traslados: ['folio', 'estado', 'fecha', 'movil', 'motivo_salida', 'destino', 'solicitado_por', 'autorizado_por', 'hora_solicitud',
    'salida_hf', 'km_salida_hf', 'llegada_destino', 'km_llegada_destino', 'salida_destino', 'llegada_hf', 'km_llegada_hf', 'km_recorridos',
    'km_sin_registro_previo', 'min_espera_solicitud_salida', 'min_movil_fuera', 'chofer', 'tens', 'medico', 'n_pacientes', 'episodios',
    'observaciones', 'motivo_anulacion', 'registrado_por', 'actualizado_servidor', 'traslado_id'],
  Personal: ['nombre', 'rol', 'activo'],
  Config: ['tipo', 'valor'],
  Integridad: ['fecha', 'filas_eventos', 'sha256_eventos', 'archivo_respaldo'],
  Panel: ['folio', 'fecha', 'inicio_semana', 'dia', 'turno', 'motivo', 'destino', 'hora_solicitud', 'min_espera_solicitud_salida',
    'min_movil_fuera', 'min_comuna_sin_ambulancia', 'horas_comuna_sin_ambulancia', 'conductor', 'km_recorridos', 'n_pacientes'],
};

/* Columnas con fecha y hora: sin este formato la planilla muestra solo la fecha */
const FORMATO_HORA = 'dd/MM/yyyy HH:mm:ss';
const COLUMNAS_HORA = {
  Eventos: ['ts_servidor', 'ts_dispositivo'],
  Traslados: ['hora_solicitud', 'salida_hf', 'llegada_destino', 'salida_destino', 'llegada_hf', 'actualizado_servidor'],
  Integridad: ['fecha'],
  Panel: ['hora_solicitud'],
};

/* Horario hábil por día (1 = lunes … 5 = viernes): [hora inicio, hora término). Sábado, domingo y feriados: inhábil,
   con una sola ambulancia para la comuna. */
const HORARIO_HABIL = { 1: [8, 17], 2: [8, 17], 3: [8, 17], 4: [8, 17], 5: [8, 16] };
/* Feriados legales de Chile 2026–2027 (con los traslados a lunes de la Ley 19.668). setup() agrega a Config los que
   falten; la lista editable es la de Config (tipo "feriado", aaaa-mm-dd). Verificar cada año con el calendario oficial
   y agregar feriados electorales o regionales. */
const FERIADOS = [
  '2026-01-01', '2026-04-03', '2026-04-04', '2026-05-01', '2026-05-21', '2026-06-21', '2026-06-29', '2026-07-16',
  '2026-08-15', '2026-09-18', '2026-09-19', '2026-10-12', '2026-10-31', '2026-11-01', '2026-12-08', '2026-12-25',
  '2027-01-01', '2027-03-26', '2027-03-27', '2027-05-01', '2027-05-21', '2027-06-21', '2027-06-28', '2027-07-16',
  '2027-08-15', '2027-09-18', '2027-09-19', '2027-10-11', '2027-10-31', '2027-11-01', '2027-12-08', '2027-12-25'];

/* ------------------------------------------------------------------ */
/* Dirección de la app (PWA). La página antigua de Apps Script ya no sirve la bitácora: solo muestra este enlace. */
const APP_URL = 'https://subdirecionhfrutillar.github.io/Bitacora/bitacora/';

function doGet() {
  const html = '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Bitácora de Ambulancia HF</title></head><body style="margin:0;font:18px/1.5 Roboto,Arial,sans-serif;background:#F2F5F9;color:#001C41">' +
    '<div style="display:flex;height:8px"><div style="width:33%;background:#0F69C4"></div><div style="flex:1;background:#EB3C46"></div></div>' +
    '<main style="max-width:520px;margin:10vh auto;padding:0 20px;text-align:center"><p>Servicio de Salud del Reloncaví · Hospital de Frutillar</p>' +
    '<h1 style="font-size:26px">La Bitácora de Ambulancia cambió de dirección</h1>' +
    '<p>La bitácora ahora se instala en la tablet y abre aunque no haya señal.</p>' +
    '<p><a href="' + APP_URL + '" target="_top" style="display:inline-block;padding:16px 28px;background:#0F69C4;color:#fff;border-radius:6px;font-weight:700;text-decoration:none">Abrir la nueva bitácora</a></p>' +
    '<p style="font-size:15px;color:#4A5A70">Antes de cambiar, envíe los registros pendientes de la app anterior. La tablet necesita su token: pídalo a Subdirección.</p>' +
    '</main></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('Bitácora de Ambulancia HF')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ------------------------------------------------------------------
 * API para la app de las tablets. ÚNICA puerta de entrada.
 * Pedido (text/plain con JSON): { fn, args, token, dispositivo, version }
 * Respuesta (JSON): { data } o { error, codigo }   codigo: PEDIDO · TOKEN_INVALIDO · FN_NO_PERMITIDA · ERROR
 * - El token se valida ANTES de cualquier lock o lectura de la planilla (un pedido sin token no gasta nada).
 * - Siempre responde JSON: una excepción nunca sale como página de error de Google.
 * ------------------------------------------------------------------ */
const API = {
  getConfig: function () { return getConfig_(); },
  syncEventos: function (a, origen) { return syncEventos_(a[0], origen); },
  agregarPersona: function (a) { return agregarPersona_(a[0]); },
  anularTraslado: function (a, origen) { return anularTraslado_(a[0], origen); },
  getEstadoMoviles: function () { return getEstadoMoviles_(); },
  getTrasladosDia: function (a) { return getTrasladosDia_(a[0]); },
};

function doPost(e) {
  let pedido;
  try {
    pedido = JSON.parse((e && e.postData && e.postData.contents) || '');
    if (!pedido || typeof pedido !== 'object') throw new Error('vacío');
  } catch (err) {
    return json_({ error: 'Pedido no válido', codigo: 'PEDIDO' });
  }
  try {
    const tok = validarToken_(pedido.token);
    if (!tok) {
      contarRechazo_();
      return json_({ error: 'El token de esta tablet no es válido o fue revocado. Pida uno nuevo a Subdirección.', codigo: 'TOKEN_INVALIDO' });
    }
    const fn = String(pedido.fn || '');
    if (!Object.prototype.hasOwnProperty.call(API, fn)) return json_({ error: 'Función no permitida: ' + fn.slice(0, 40), codigo: 'FN_NO_PERMITIDA' });
    const origen = { token: tok.nombre, dispositivo: String(pedido.dispositivo || '').slice(0, 40) };
    const data = API[fn](Array.isArray(pedido.args) ? pedido.args : [], origen);
    marcarContacto_(tok.clave, origen.dispositivo, pedido.version);
    return json_({ data: data === undefined ? null : data });
  } catch (err) {
    console.error('doPost ' + (pedido && pedido.fn) + ': ' + (err && err.stack || err));
    return json_({ error: String((err && err.message) || err), codigo: 'ERROR' });
  }
}

function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

/* ---------------- tokens por tablet ----------------
 * Propiedades del script, clave "tokens": { token: { nombre, activo, creado, revocado?, ultimo?, dispositivo?, version? } }
 * Se crean y revocan desde el editor con ADMIN_crearToken / ADMIN_revocarToken / ADMIN_listarTokens (más abajo). */
function leerTokens_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('tokens') || '{}'); } catch (err) { return {}; }
}
function guardarTokens_(t) { PropertiesService.getScriptProperties().setProperty('tokens', JSON.stringify(t)); }

function validarToken_(token) {
  token = String(token || '');
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  const t = leerTokens_()[token];
  return t && t.activo === true ? { clave: token, nombre: String(t.nombre || 'tablet') } : null;
}

/* Devuelve el token UNA sola vez (no se puede volver a ver: si se pierde, se crea otro y se revoca el anterior) */
function crearTokenTablet_(nombre) {
  nombre = String(nombre || '').trim();
  if (!nombre) throw new Error('Indique un nombre para la tablet (ej. "Tablet Móvil 01")');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = leerTokens_();
    const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    t[token] = { nombre: nombre, activo: true, creado: new Date().toISOString() };
    guardarTokens_(t);
    return token;
  } finally { lock.releaseLock(); }
}

/* Acepta el token completo o su comienzo (mín. 8 caracteres, como lo muestra ADMIN_listarTokens) */
function revocarTokenTablet_(token) {
  token = String(token || '').trim();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = leerTokens_();
    const claves = Object.keys(t).filter(function (k) { return k === token || (token.length >= 8 && k.indexOf(token) === 0); });
    if (claves.length !== 1) throw new Error(claves.length ? 'Hay más de un token que empieza así: escriba más caracteres' : 'No existe ese token');
    t[claves[0]].activo = false;
    t[claves[0]].revocado = new Date().toISOString();
    guardarTokens_(t);
    return t[claves[0]].nombre;
  } finally { lock.releaseLock(); }
}

/* Último contacto de cada tablet (como mucho una escritura cada 10 min por token) */
function marcarContacto_(clave, dispositivo, version) {
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get('contacto_' + clave)) return;
    cache.put('contacto_' + clave, '1', 600);
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(2000)) return;
    try {
      const t = leerTokens_();
      if (!t[clave]) return;
      t[clave].ultimo = new Date().toISOString();
      t[clave].dispositivo = dispositivo || t[clave].dispositivo || '';
      t[clave].version = String(version || '').slice(0, 30);
      guardarTokens_(t);
    } finally { lock.releaseLock(); }
  } catch (err) { console.warn('marcarContacto_: ' + err); }
}

/* Pedidos rechazados por token (para detectar abuso). Solo caché: no escribe en la planilla ni en propiedades. */
function contarRechazo_() {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get('rechazos') || 0) + 1;
    cache.put('rechazos', String(n), 21600);
    if (n % 50 === 0) console.warn('Bitácora: ' + n + ' pedidos con token inválido en las últimas horas');
  } catch (err) { /* sin caché: no se cuenta */ }
}

/* ===== ADMINISTRACIÓN DE TABLETS — ejecutar desde el editor (menú "Ejecutar") =====
 * 1) Escriba el nombre o el token en la constante de abajo, 2) guarde, 3) elija la función y pulse Ejecutar,
 * 4) lea el resultado en "Registro de ejecución". */
const ADMIN_NOMBRE_TABLET = 'Tablet Móvil 01';
const ADMIN_TOKEN_A_REVOCAR = '';

function ADMIN_crearToken() {
  soloEditor_();
  const token = crearTokenTablet_(ADMIN_NOMBRE_TABLET);
  const enlace = APP_URL + '#t=' + token;
  console.log('Token para "' + ADMIN_NOMBRE_TABLET + '" (se muestra UNA sola vez):\n' + token +
    '\n\nEnlace de alta (ábralo en la tablet):\n' + enlace +
    '\n\nCódigo QR para escanear con la tablet (se genera en su navegador, el token no sale a internet):\n' +
    APP_URL + 'qr.html#t=' + token);
  return token;
}

function ADMIN_revocarToken() {
  soloEditor_();
  const nombre = revocarTokenTablet_(ADMIN_TOKEN_A_REVOCAR);
  console.log('Revocado: "' + nombre + '". Desde ahora esa tablet no puede enviar ni leer nada.');
  return nombre;
}

function ADMIN_listarTokens() {
  soloEditor_();
  const t = leerTokens_();
  const filas = Object.keys(t).map(function (k) {
    const x = t[k];
    return (x.activo ? 'ACTIVO   ' : 'REVOCADO ') + k.slice(0, 8) + '…  ' + x.nombre + '  · creado ' + x.creado +
      (x.ultimo ? '  · último contacto ' + x.ultimo + ' (' + (x.dispositivo || '') + ', v' + (x.version || '?') + ')' : '  · sin contacto aún') +
      (x.revocado ? '  · revocado ' + x.revocado : '');
  });
  console.log(filas.length ? filas.join('\n') : 'No hay tokens. Cree uno con ADMIN_crearToken.');
  return filas.length;
}

/* Las funciones ADMIN_ solo corren desde el editor por el dueño (no desde la web) */
function soloEditor_() {
  let activo = '', efectivo = '';
  try { activo = Session.getActiveUser().getEmail(); efectivo = Session.getEffectiveUser().getEmail(); } catch (err) { /* */ }
  if (!activo || activo !== efectivo) throw new Error('Ejecute esta función desde el editor de Apps Script con la cuenta dueña.');
}

/* Ejecutar UNA vez desde el editor */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HOJAS).forEach(function (nombre) {
    let sh = ss.getSheetByName(nombre);
    if (!sh) sh = ss.insertSheet(nombre);
    if (sh.getLastRow() === 0) {
      sh.appendRow(HOJAS[nombre]);
      sh.getRange(1, 1, 1, HOJAS[nombre].length).setFontWeight('bold').setBackground('#000000').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
    formatearHoras_(sh, nombre, 2, sh.getMaxRows() - 1);
  });
  const personal = ss.getSheetByName('Personal');
  if (personal.getLastRow() === 1) {
    personal.getRange(2, 1, 3, 3).setValues([
      ['(Nombre conductor)', 'Conductor', 'SI'], ['(Nombre TENS)', 'TENS', 'SI'], ['(Nombre médico)', 'Médico', 'SI'],
    ]);
  }
  const config = ss.getSheetByName('Config');
  if (config.getLastRow() === 1) {
    const filas = [['movil', 'Móvil 01'], ['movil', 'Móvil 02']]
      .concat(DESTINOS.map(function (d) { return ['destino', d]; }))
      .concat(['Urgencia', 'Hospitalizados', 'HODOM', 'Regulación SAMU', 'CESFAM / APS', 'Otro hospital'].map(function (d) { return ['solicitante', d]; }));
    config.getRange(2, 1, filas.length, 2).setValues(filas);
    PropertiesService.getScriptProperties().setProperty('destinos_v2', '1');
  }
  // Migración única a los destinos nuevos: los antiguos pasan a "destino_anterior" (no se borran)
  if (!PropertiesService.getScriptProperties().getProperty('destinos_v2')) {
    filas_(config).forEach(function (r, i) { if (String(r[0]).trim() === 'destino') config.getRange(i + 2, 1).setValue('destino_anterior'); });
    config.getRange(config.getLastRow() + 1, 1, DESTINOS.length, 2).setValues(DESTINOS.map(function (d) { return ['destino', d]; }));
    PropertiesService.getScriptProperties().setProperty('destinos_v2', '1');
  }
  // Feriados: agrega los de FERIADOS que no estén (no borra ni cambia los que el administrador ya editó)
  const yaFeriados = feriados_(ss, ss.getSpreadsheetTimeZone());
  const fer = FERIADOS.filter(function (f) { return !yaFeriados[f]; }).map(function (f) { return ['feriado', f]; });
  if (fer.length) {
    const rango = config.getRange(config.getLastRow() + 1, 1, fer.length, 2);
    rango.offset(0, 1, fer.length, 1).setNumberFormat('@');   // texto: que la planilla no lo convierta en fecha
    rango.setValues(fer);
  }
  // Valores de referencia del panel (editables): julio 2026 con dos ambulancias
  const tiposConfig = filas_(config).map(function (r) { return String(r[0]).trim(); });
  const refs = [['ref_ocasiones_ambas', REFERENCIA_DEFECTO.ocasionesAmbas], ['ref_horas_inhabil', REFERENCIA_DEFECTO.horasInhabil],
    ['ref_etiqueta', REFERENCIA_DEFECTO.etiqueta]].filter(function (x) { return tiposConfig.indexOf(x[0]) < 0; });
  if (refs.length) config.getRange(config.getLastRow() + 1, 1, refs.length, 2).setValues(refs);
  // Quién puede abrir el panel de gestión: parte con el dueño; el administrador agrega Dirección/Subdirección
  if (!filas_(config).some(function (r) { return String(r[0]).trim() === 'panel_autorizado'; })) {
    const yo = Session.getEffectiveUser().getEmail();
    if (yo) config.getRange(config.getLastRow() + 1, 1, 1, 2).setValues([['panel_autorizado', yo]]);
  }
  // Hoja "Bitácora" con formato de talonario (primera pestaña)
  if (!ss.getSheetByName(BITACORA)) formatoBitacora_(ss.insertSheet(BITACORA, 0));
  actualizarBitacora();
  // Solo el dueño puede editar los registros (las tablets escriben vía la aplicación web, que corre como el dueño)
  ['Eventos', 'Traslados', 'Integridad', 'Panel', BITACORA].forEach(function (nombre) {
    const sh = ss.getSheetByName(nombre);
    sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
    const p = sh.protect().setDescription('Registro de bitácora: solo escritura por la aplicación');
    p.removeEditors(p.getEditors());
    p.addEditor(Session.getEffectiveUser());
    if (p.canDomainEdit()) p.setDomainEdit(false);
  });
  // Respaldo diario a las 23:50
  const existe = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'respaldoDiario'; });
  if (!existe) ScriptApp.newTrigger('respaldoDiario').timeBased().everyDays(1).atHour(23).nearMinute(50).create();
  // Panel para Looker Studio: se recalcula cada hora
  const existePanel = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'actualizarPanel'; });
  if (!existePanel) ScriptApp.newTrigger('actualizarPanel').timeBased().everyHours(1).create();
  if (!PropertiesService.getScriptProperties().getProperty('folio_seq')) PropertiesService.getScriptProperties().setProperty('folio_seq', '0');
  actualizarPanel();
  return 'Listo';
}

/* ------------------------------------------------------------------
 * Panel semanal (fuente de Looker Studio). Solo traslados cerrados.
 * - turno: según la hora de solicitud (Hábil / Inhábil).
 * - min_comuna_sin_ambulancia: minutos con el móvil fuera de HF en horario inhábil (una sola ambulancia).
 * - conductor: seudónimo estable (Conductor A, B…). La tabla nombre→seudónimo queda en las propiedades del
 *   script, visible solo para el dueño, hasta que exista acuerdo con los gremios para mostrar nombres.
 * ------------------------------------------------------------------ */
function actualizarPanel() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const h = HOJAS.Traslados;
    const c = function (r, col) { return r[h.indexOf(col)]; };
    const feriados = feriados_(ss, tz);
    const props = PropertiesService.getScriptProperties();
    const seud = JSON.parse(props.getProperty('seudonimos') || '{}');
    const DIAS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

    const filas = filas_(ss.getSheetByName('Traslados'))
      .filter(function (r) { return c(r, 'estado') === 'cerrado'; })
      .map(function (r) {
        const sol = c(r, 'hora_solicitud'), salida = c(r, 'salida_hf'), llegada = c(r, 'llegada_hf');
        const ref = sol instanceof Date ? sol : (salida instanceof Date ? salida : null);
        const dow = ref ? Number(Utilities.formatDate(ref, tz, 'u')) : 0;
        const fecha = ref ? diaDe_(ref, tz) : '';
        const inicioSemana = ref ? lunesDe_(ref, tz) : '';
        const v = ref ? ventanaHabil_(ref, feriados, tz) : null;
        const turno = !ref ? '' : (v && ref >= v[0] && ref < v[1] ? 'Hábil' : 'Inhábil');
        const minSin = minutosInhabiles_(salida, llegada, feriados, tz);
        const nombre = String(c(r, 'chofer') || '').trim();
        let conductor = '(sin registrar)';
        if (nombre) {
          if (!seud[nombre]) seud[nombre] = 'Conductor ' + letra_(Object.keys(seud).length);
          conductor = seud[nombre];
        }
        return [c(r, 'folio'), fecha, inicioSemana, ref ? DIAS[dow] : '', turno, c(r, 'motivo_salida'), c(r, 'destino'), ref || '',
          val_(c(r, 'min_espera_solicitud_salida')), val_(c(r, 'min_movil_fuera')), minSin, Math.round(minSin / 6) / 10,
          conductor, val_(c(r, 'km_recorridos')), val_(c(r, 'n_pacientes'))];
      });
    props.setProperty('seudonimos', JSON.stringify(seud));
    props.setProperty('panel_actualizado', new Date().toISOString());

    const sh = ss.getSheetByName('Panel');
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, HOJAS.Panel.length).clearContent();
    if (filas.length) {
      sh.getRange(2, 1, filas.length, HOJAS.Panel.length).setValues(filas);
      sh.getRange(2, 2, filas.length, 2).setNumberFormat('dd/MM/yyyy');
      formatearHoras_(sh, 'Panel', 2, filas.length);
    }
    return filas.length;
  } finally {
    lock.releaseLock();
  }
}

/* Valores de referencia que setup() deja en Config para el panel de gestión (proyecto aparte, carpeta panel/) */
const REFERENCIA_DEFECTO = { ocasionesAmbas: 24, horasInhabil: 184, etiqueta: 'julio 2026, con dos ambulancias' };

/* Lunes (medianoche) de la semana de d; se parte del mediodía para no saltar de día con el cambio de hora */
function lunesDe_(d, tz) {
  const dow = Number(Utilities.formatDate(d, tz, 'u'));
  return diaDe_(new Date(diaDe_(d, tz).getTime() + 12 * 3600000 - (dow - 1) * 86400000), tz);
}

/* Feriados desde Config (tipo "feriado"), como {'aaaa-mm-dd': true} */
function feriados_(ss, tz) {
  const out = {};
  filas_(ss.getSheetByName('Config')).forEach(function (r) {
    if (String(r[0]).trim() !== 'feriado' || !r[1]) return;
    out[r[1] instanceof Date ? Utilities.formatDate(r[1], tz, 'yyyy-MM-dd') : String(r[1]).trim()] = true;
  });
  return out;
}

/* Medianoche del día de d, en la zona de la planilla */
function diaDe_(d, tz) { return Utilities.parseDate(Utilities.formatDate(d, tz, 'yyyy-MM-dd'), tz, 'yyyy-MM-dd'); }

/* Ventana hábil [inicio, término) del día de d, o null si ese día es inhábil completo */
function ventanaHabil_(d, feriados, tz) {
  const clave = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  const horas = HORARIO_HABIL[Number(Utilities.formatDate(d, tz, 'u'))];
  if (!horas || feriados[clave]) return null;
  return [Utilities.parseDate(clave + ' ' + horas[0] + ':00', tz, 'yyyy-MM-dd H:mm'),
    Utilities.parseDate(clave + ' ' + horas[1] + ':00', tz, 'yyyy-MM-dd H:mm')];
}

/* Minutos del intervalo [ini, fin] que caen fuera del horario hábil */
function minutosInhabiles_(ini, fin, feriados, tz) {
  if (!(ini instanceof Date) || !(fin instanceof Date) || fin <= ini) return 0;
  let habil = 0;
  let dia = diaDe_(ini, tz);
  while (dia < fin) {
    const v = ventanaHabil_(dia, feriados, tz);
    if (v) habil += Math.max(0, Math.min(fin, v[1]) - Math.max(ini, v[0]));
    dia = diaDe_(new Date(dia.getTime() + 26 * 3600000), tz);   // día siguiente, robusto al cambio de hora
  }
  return Math.round(((fin - ini) - habil) / 60000);
}

/* 0 → A, 25 → Z, 26 → AA… */
function letra_(i) { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

/* ------------------------------------------------------------------ */
function getConfig_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const personal = personalActivo_(ss);
  const cfg = filas_(ss.getSheetByName('Config'));
  const de = function (tipo) { return cfg.filter(function (r) { return String(r[0]).trim() === tipo && r[1]; }).map(function (r) { return String(r[1]).trim(); }); };

  // Último km de llegada a HF por móvil (traslados no anulados)
  const h = HOJAS.Traslados;
  const ultimoKm = {};
  const anulados = {};
  filas_(ss.getSheetByName('Traslados')).forEach(function (r) {
    const movil = r[h.indexOf('movil')], km = Number(r[h.indexOf('km_llegada_hf')]);
    if (r[h.indexOf('estado')] === 'anulado') anulados[r[h.indexOf('traslado_id')]] = String(r[h.indexOf('motivo_anulacion')] || 'Anulado');
    if (r[h.indexOf('estado')] === 'anulado' || !movil || !km) return;
    if (!ultimoKm[movil] || km > ultimoKm[movil]) ultimoKm[movil] = km;
  });
  const config = {};
  if (personal.length) config.personal = personal;
  if (de('movil').length) config.moviles = de('movil');
  if (de('destino').length) config.destinos = de('destino');
  if (de('solicitante').length) config.solicitantes = de('solicitante');
  return { config: config, ultimoKm: ultimoKm, anulados: anulados, serverTime: new Date().toISOString() };
}

/* ------------------------------------------------------------------
 * Recibe un lote de eventos desde la tablet.
 * - Idempotente: si un evento_id ya existe, solo lo confirma.
 * - Asigna folio correlativo central al crear el traslado.
 * - Guarda hora del dispositivo y hora del servidor.
 * ------------------------------------------------------------------ */
function syncEventos_(lote, origen) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const shE = ss.getSheetByName('Eventos');
    const shT = ss.getSheetByName('Traslados');
    const hT = HOJAS.Traslados;

    const idsExistentes = new Set(columna_(shE, HOJAS.Eventos.indexOf('evento_id') + 1));
    const tIds = columna_(shT, hT.indexOf('traslado_id') + 1);
    const tFolios = columna_(shT, hT.indexOf('folio') + 1);
    const tEstados = columna_(shT, hT.indexOf('estado') + 1);
    const tMotAnul = columna_(shT, hT.indexOf('motivo_anulacion') + 1);
    const filaDe = {}, folioDe = {}, anuladoDe = {};
    tIds.forEach(function (id, i) {
      if (!id) return;
      filaDe[id] = i + 2; folioDe[id] = tFolios[i];
      if (tEstados[i] === 'anulado') anuladoDe[id] = String(tMotAnul[i] || 'Anulado');
    });

    const props = PropertiesService.getScriptProperties();
    const ahora = new Date();
    let cuenta = '';
    try { cuenta = Session.getActiveUser().getEmail(); } catch (err) { cuenta = ''; }
    if (!cuenta) cuenta = cuentaOrigen_(origen);
    const ok = [], folios = {}, nuevasFilasE = [], rechazados = [];

    (lote || []).forEach(function (e) {
      if (!e || !e.id) return;
      if (idsExistentes.has(e.id)) { ok.push(e.id); if (folioDe[e.trasladoId]) folios[e.trasladoId] = folioDe[e.trasladoId]; return; }
      // Turno obligatorio: sin móvil, quién registra, chofer y TENS no se guarda nada
      if (!turnoCompleto_(e.turno)) { rechazados.push({ id: e.id, motivo: 'Falta el turno en este equipo (móvil, quién registra, chofer y TENS)' }); return; }

      if (!folioDe[e.trasladoId]) {
        const n = Number(props.getProperty('folio_seq') || 0) + 1;
        props.setProperty('folio_seq', String(n));
        folioDe[e.trasladoId] = PREFIJO_FOLIO + ('000000' + n).slice(-6);
      }
      const folio = folioDe[e.trasladoId];
      const tsDisp = e.tsDispositivo ? new Date(e.tsDispositivo) : null;
      nuevasFilasE.push([ahora, tsDisp, tsDisp ? Math.round((ahora - tsDisp) / 60000) : '', e.id, e.dispositivo || '', e.usuario || '', e.movil || '',
        e.trasladoId, folio, e.tipo || '', e.campo || '', valorTexto_(e.anterior), valorTexto_(e.nuevo), e.motivo || '', cuenta]);

      // Vista consolidada con el último estado
      if (e.snapshot) {
        const fila = filaTraslado_(e.snapshot, folio, ahora);
        if (anuladoDe[e.trasladoId]) {   // anulado antes (p. ej. desde otra tablet): se mantiene anulado
          fila[hT.indexOf('estado')] = 'anulado';
          fila[hT.indexOf('motivo_anulacion')] = anuladoDe[e.trasladoId];
        } else if (e.snapshot.estado === 'anulado') anuladoDe[e.trasladoId] = e.snapshot.anulacion || 'Anulado';
        if (filaDe[e.trasladoId]) shT.getRange(filaDe[e.trasladoId], 1, 1, fila.length).setValues([fila]);
        else { shT.appendRow(fila); filaDe[e.trasladoId] = shT.getLastRow(); }
        formatearHoras_(shT, 'Traslados', filaDe[e.trasladoId], 1);
      }
      idsExistentes.add(e.id);
      ok.push(e.id);
      folios[e.trasladoId] = folio;
    });

    if (nuevasFilasE.length) {
      const desde = shE.getLastRow() + 1;
      shE.getRange(desde, 1, nuevasFilasE.length, nuevasFilasE[0].length).setValues(nuevasFilasE);
      formatearHoras_(shE, 'Eventos', desde, nuevasFilasE.length);
    }
    if (nuevasFilasE.length) { try { actualizarBitacora(); } catch (err) { console.error('Bitácora: ' + err); } }
    const anulados = {};
    (lote || []).forEach(function (e) { if (e && anuladoDe[e.trasladoId]) anulados[e.trasladoId] = anuladoDe[e.trasladoId]; });
    return { ok: ok, folios: folios, anulados: anulados, rechazados: rechazados, serverTime: ahora.toISOString() };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------
 * Hoja "Bitácora": espejo de Traslados con el formato del talonario de papel (protegida, solo la escribe el sistema).
 * Se rehace completa en cada envío de eventos y en cada anulación. No es una fuente de datos: la fuente es Eventos.
 * ------------------------------------------------------------------ */
const BITACORA = 'Bitácora';
const BIT_COLS = 15, BIT_INI = 4;
const BIT_TINTA = '#1B2B44', BIT_GRIS = '#8A94A3', BIT_LINEA = '#9AA5B1', BIT_FONDO = '#E8EDF3';

function formatoBitacora_(sh) {
  sh.clear();
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, 1, BIT_COLS).merge().setValue('BITÁCORA DE AMBULANCIA FRUTILLAR')
    .setFontSize(16).setFontWeight('bold').setFontColor(BIT_TINTA).setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setBorder(null, null, true, null, null, null, '#0F69C4', SpreadsheetApp.BorderStyle.SOLID_THICK);
  sh.setRowHeight(1, 42);
  const unir = function (a1, texto) { sh.getRange(a1).merge().setValue(texto); };
  unir('A2:A3', 'N° folio'); unir('B2:B3', 'Fecha');
  unir('C2:D2', 'Salida HF'); unir('E2:F2', 'Llegada HPM u otro lugar');
  unir('G2:H2', 'Motivo de salida\n1 Urgencia · 2 Programado · 3 Rescate comunal');
  unir('I2:I3', 'Salida destino\nHora'); unir('J2:K2', 'Llegada HF');
  unir('L2:N2', 'Nombre del personal de turno'); unir('O2:O3', 'Estado');
  sh.getRange('C3:H3').setValues([['Hora', 'Km', 'Hora', 'Km', 'Motivo', 'Destino · pacientes · N° DAU · observaciones']]);
  sh.getRange('J3:N3').setValues([['Hora', 'Km', 'Chofer', 'TENS', 'Traslado avanzado']]);
  sh.getRange(2, 1, 2, BIT_COLS).setBackground(BIT_FONDO).setFontWeight('bold').setFontColor(BIT_TINTA).setFontSize(10)
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true)
    .setBorder(true, true, true, true, true, true, BIT_LINEA, SpreadsheetApp.BorderStyle.SOLID);
  sh.setRowHeights(2, 2, 30);
  [80, 70, 55, 70, 55, 70, 100, 320, 70, 55, 70, 140, 140, 150, 170].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setFrozenRows(3);
}

function actualizarBitacora() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  let sh = ss.getSheetByName(BITACORA);
  if (!sh) { sh = ss.insertSheet(BITACORA, 0); formatoBitacora_(sh); }
  const h = HOJAS.Traslados;
  const c = function (r, col) { return r[h.indexOf(col)]; };
  const hora = function (v) { return v instanceof Date ? v : ''; };
  const MOT = { 'Urgencia': '1 Urgencia', 'Programado': '2 Programado', 'Rescate comunal': '3 Rescate' };
  const orden = function (r) { const v = c(r, 'salida_hf') instanceof Date ? c(r, 'salida_hf') : c(r, 'actualizado_servidor'); return v instanceof Date ? v.getTime() : 0; };
  const filas = filas_(ss.getSheetByName('Traslados')).filter(function (r) { return c(r, 'traslado_id'); })
    .sort(function (a, b) { return orden(a) - orden(b); });
  const datos = filas.map(function (r) {
    const estado = c(r, 'estado');
    const np = Number(c(r, 'n_pacientes')) || 0;
    const detalle = [c(r, 'destino') || 'Sin destino', np ? np + (np === 1 ? ' paciente' : ' pacientes') : '', c(r, 'episodios'), c(r, 'observaciones')]
      .map(function (x) { return String(x || '').trim(); }).filter(String).join(' · ');
    let fecha = c(r, 'salida_hf') instanceof Date ? c(r, 'salida_hf') : c(r, 'fecha');
    if (!(fecha instanceof Date) && /^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) fecha = Utilities.parseDate(String(fecha), tz, 'yyyy-MM-dd');
    return [c(r, 'folio'), fecha || '', hora(c(r, 'salida_hf')), val_(c(r, 'km_salida_hf')), hora(c(r, 'llegada_destino')), val_(c(r, 'km_llegada_destino')),
      MOT[c(r, 'motivo_salida')] || c(r, 'motivo_salida') || '', detalle, hora(c(r, 'salida_destino')), hora(c(r, 'llegada_hf')), val_(c(r, 'km_llegada_hf')),
      c(r, 'chofer') || '', c(r, 'tens') || '', c(r, 'medico') || '',
      estado === 'anulado' ? 'ANULADO: ' + (c(r, 'motivo_anulacion') || '') : estado === 'cerrado' ? 'Cerrado' : 'En curso'];
  });
  if (sh.getLastRow() >= BIT_INI) sh.getRange(BIT_INI, 1, sh.getLastRow() - BIT_INI + 1, BIT_COLS).clearContent();
  if (!datos.length) return 0;
  const rg = sh.getRange(BIT_INI, 1, datos.length, BIT_COLS);
  rg.setValues(datos).setFontSize(10).setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true, BIT_LINEA, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(BIT_INI, 2, datos.length, 1).setNumberFormat('dd/MM/yy');
  [3, 5, 9, 10].forEach(function (col) { sh.getRange(BIT_INI, col, datos.length, 1).setNumberFormat('HH:mm').setHorizontalAlignment('center'); });
  [4, 6, 11].forEach(function (col) { sh.getRange(BIT_INI, col, datos.length, 1).setNumberFormat('#,##0'); });
  sh.getRange(BIT_INI, 8, datos.length, 1).setWrap(true);
  // Anulados: tachados y en gris (no se borran); la columna Estado queda legible con el motivo
  const anul = datos.map(function (d) { return d[14].indexOf('ANULADO') === 0; });
  rg.setFontLines(anul.map(function (a) { return Array.from({ length: BIT_COLS }, function (_, j) { return a && j < BIT_COLS - 1 ? 'line-through' : 'none'; }); }));
  rg.setFontColors(anul.map(function (a) { return Array.from({ length: BIT_COLS }, function () { return a ? BIT_GRIS : BIT_TINTA; }); }));
  sh.setRowHeights(BIT_INI, datos.length, 34);
  return datos.length;
}

/* ------------------------------------------------------------------
 * Estado de cada móvil para la pestaña "Móviles" (Urgencia): en base o fuera, con la etapa del traslado en curso.
 * Solo lee. El dato es el último recibido de la tablet del móvil (columna actualizado_servidor).
 * ------------------------------------------------------------------ */
function getEstadoMoviles_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const h = HOJAS.Traslados;
  const c = function (r, col) { return r[h.indexOf(col)]; };
  const ms = function (v) { return v instanceof Date ? v.getTime() : null; };
  const iso = function (v) { return v instanceof Date ? v.toISOString() : ''; };
  const ahora = new Date();
  const hoy = Utilities.formatDate(ahora, tz, 'yyyy-MM-dd');
  const moviles = filas_(ss.getSheetByName('Config')).filter(function (r) { return String(r[0]).trim() === 'movil' && r[1]; })
    .map(function (r) { return String(r[1]).trim(); });
  const filas = filas_(ss.getSheetByName('Traslados')).filter(function (r) { return c(r, 'estado') !== 'anulado'; });
  const estado = moviles.map(function (m) {
    const del = filas.filter(function (r) { return String(c(r, 'movil')) === m; });
    const abiertos = del.filter(function (r) { return c(r, 'estado') === 'en_curso'; })
      .sort(function (a, b) { return (ms(c(b, 'salida_hf')) || ms(c(b, 'actualizado_servidor')) || 0) - (ms(c(a, 'salida_hf')) || ms(c(a, 'actualizado_servidor')) || 0); });
    const fuera = abiertos.filter(function (r) { return c(r, 'salida_hf') instanceof Date && !(c(r, 'llegada_hf') instanceof Date); });
    const t = fuera[0] || abiertos[0] || null;
    const regresos = del.map(function (r) { return ms(c(r, 'llegada_hf')); }).filter(function (x) { return x; });
    const ultimoDato = del.map(function (r) { return ms(c(r, 'actualizado_servidor')); }).filter(function (x) { return x; });
    return {
      movil: m,
      situacion: fuera.length ? 'fuera' : (abiertos.length ? 'preparando' : 'base'),
      traslado: t ? { folio: String(c(t, 'folio') || ''), motivo: String(c(t, 'motivo_salida') || ''), destino: String(c(t, 'destino') || ''),
        chofer: String(c(t, 'chofer') || ''), tens: String(c(t, 'tens') || ''), avanzado: String(c(t, 'medico') || ''),
        salida: iso(c(t, 'salida_hf')), llegadaDest: iso(c(t, 'llegada_destino')), salidaDest: iso(c(t, 'salida_destino')) } : null,
      ultimoRegreso: regresos.length ? new Date(Math.max.apply(null, regresos)).toISOString() : '',
      ultimoDato: ultimoDato.length ? new Date(Math.max.apply(null, ultimoDato)).toISOString() : '',
      salidasHoy: del.filter(function (r) { return c(r, 'salida_hf') instanceof Date && Utilities.formatDate(c(r, 'salida_hf'), tz, 'yyyy-MM-dd') === hoy; }).length,
    };
  });
  const v = ventanaHabil_(ahora, feriados_(ss, tz), tz);
  return { moviles: estado, inhabil: !(v && ahora >= v[0] && ahora < v[1]), serverTime: ahora.toISOString() };
}

/* ------------------------------------------------------------------
 * Traslados de un día (aaaa-mm-dd), de todos los equipos, para la lista de la app.
 * ------------------------------------------------------------------ */
function getTrasladosDia_(fecha) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const h = HOJAS.Traslados;
  const c = function (r, col) { return r[h.indexOf(col)]; };
  const dia = function (v) { return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v || '').slice(0, 10); };
  const iso = function (v) { return v instanceof Date ? v.toISOString() : ''; };
  const anulados = {};
  const traslados = filas_(ss.getSheetByName('Traslados')).filter(function (r) {
    if (c(r, 'estado') === 'anulado') anulados[c(r, 'traslado_id')] = String(c(r, 'motivo_anulacion') || 'Anulado');
    return dia(c(r, 'fecha')) === fecha || dia(c(r, 'salida_hf')) === fecha;
  }).map(function (r) {
    return { id: String(c(r, 'traslado_id')), folio: String(c(r, 'folio') || ''), estado: String(c(r, 'estado') || ''), movil: String(c(r, 'movil') || ''),
      motivo: String(c(r, 'motivo_salida') || ''), destino: String(c(r, 'destino') || ''), salida: iso(c(r, 'salida_hf')), llegada: iso(c(r, 'llegada_hf')),
      chofer: String(c(r, 'chofer') || ''), registradoPor: String(c(r, 'registrado_por') || ''), anulacion: String(c(r, 'motivo_anulacion') || '') };
  });
  return { traslados: traslados, anulados: anulados };
}

/* ------------------------------------------------------------------
 * Anular un traslado desde cualquier tablet (con señal). Queda como evento ANULAR en Eventos,
 * con quién, desde qué equipo y con qué cuenta. Un traslado anulado no vuelve a otro estado.
 * ------------------------------------------------------------------ */
function anularTraslado_(p, origen) {
  const motivo = String((p && p.motivo) || '').trim();
  if (!p || !p.trasladoId) throw new Error('Falta el traslado');
  if (motivo.length < 5) throw new Error('El motivo debe tener al menos 5 caracteres');
  if (!turnoCompleto_(p.turno)) throw new Error('Primero completa el turno en este equipo');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const shE = ss.getSheetByName('Eventos'), shT = ss.getSheetByName('Traslados');
    const h = HOJAS.Traslados;
    const ids = columna_(shT, h.indexOf('traslado_id') + 1);
    const i = ids.indexOf(p.trasladoId);
    if (i < 0) throw new Error('El traslado aún no llega a la planilla');
    const fila = i + 2;
    const r = shT.getRange(fila, 1, 1, h.length).getValues()[0];
    const anterior = r[h.indexOf('estado')];
    if (anterior === 'anulado') return { ok: true, yaAnulado: true };
    const ahora = new Date();
    let cuenta = '';
    try { cuenta = Session.getActiveUser().getEmail(); } catch (err) { cuenta = ''; }
    if (!cuenta) cuenta = cuentaOrigen_(origen);
    const desde = shE.getLastRow() + 1;
    shE.getRange(desde, 1, 1, HOJAS.Eventos.length).setValues([[ahora, ahora, 0, 'srv-' + Utilities.getUuid(), String(p.dispositivo || ''), String(p.usuario || ''),
      r[h.indexOf('movil')], p.trasladoId, r[h.indexOf('folio')], 'ANULAR', 'estado', anterior, 'anulado', motivo, cuenta]]);
    formatearHoras_(shE, 'Eventos', desde, 1);
    shT.getRange(fila, h.indexOf('estado') + 1).setValue('anulado');
    shT.getRange(fila, h.indexOf('motivo_anulacion') + 1).setValue(motivo);
    shT.getRange(fila, h.indexOf('actualizado_servidor') + 1).setValue(ahora);
    formatearHoras_(shT, 'Traslados', fila, 1);
    try { actualizarBitacora(); } catch (err) { console.error('Bitácora: ' + err); }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------
 * Agregar un nombre a la hoja Personal desde la tablet ("+ Agregar otro nombre…").
 * - rol: "Conductor" (desde Quién registra o Chofer) o "TENS".
 * - Normaliza: sin espacios sobrantes, Nombre Apellido con mayúsculas iniciales, mínimo 3 letras.
 * - No duplica: compara sin mayúsculas ni tildes dentro del mismo rol. Si ya existe, devuelve el existente
 *   (y si estaba inactivo lo vuelve a activar para que aparezca en las listas).
 * - LockService: dos tablets agregando a la vez no generan duplicados.
 * Devuelve { nombre, rol, existente, personal } con la lista actualizada para todos los equipos.
 * ------------------------------------------------------------------ */
function agregarPersona_(p) {
  const rol = String((p && p.rol) || '').trim();
  if (rol !== 'Conductor' && rol !== 'TENS') throw new Error('Rol no válido');
  const nombre = normalizarNombre_((p && p.nombre) || '');
  const letras = (nombre.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
  if (!nombre) throw new Error('Escribe un nombre');
  if (letras < 3) throw new Error('El nombre debe tener al menos 3 letras');
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]+$/.test(nombre)) throw new Error('Usa solo letras, espacios, guion o apóstrofo');
  if (nombre.length > 60) throw new Error('El nombre es demasiado largo');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName('Personal');
    const clave = claveNombre_(nombre);
    const filas = filas_(sh);
    for (let i = 0; i < filas.length; i++) {
      const r = filas[i];
      if (String(r[1]).trim() === rol && claveNombre_(r[0]) === clave) {
        if (String(r[2]).toUpperCase().indexOf('S') !== 0) sh.getRange(i + 2, 3).setValue('SI');
        return { nombre: String(r[0]).trim(), rol: rol, existente: true, personal: personalActivo_(ss) };
      }
    }
    sh.appendRow([nombre, rol, 'SI']);
    return { nombre: nombre, rol: rol, existente: false, personal: personalActivo_(ss) };
  } finally {
    lock.releaseLock();
  }
}

/* Personal activo (columna activo empieza con S), como lo lee la app */
function personalActivo_(ss) {
  return filas_(ss.getSheetByName('Personal'))
    .filter(function (r) { return r[0] && String(r[2]).toUpperCase().indexOf('S') === 0; })
    .map(function (r) { return { nombre: String(r[0]).trim(), rol: String(r[1]).trim() }; });
}

/* "  juan   PÉREZ-soto " → "Juan Pérez-Soto" */
function normalizarNombre_(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/(^|[\s'-])([a-záéíóúüñ])/g, function (m, sep, letra) { return sep + letra.toUpperCase(); });
}

/* Clave para comparar nombres: sin tildes, sin mayúsculas, espacios simples */
function claveNombre_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/* Sin cuenta Google (pedido desde la PWA): queda el nombre del token y el ID de la tablet en la columna cuenta_google */
function cuentaOrigen_(origen) {
  if (!origen) return '';
  return ('token:' + String(origen.token || '') + (origen.dispositivo ? ' · ' + origen.dispositivo : '')).slice(0, 120);
}

/* Turno del equipo completo: móvil, quién registra, chofer y TENS */
function turnoCompleto_(t) {
  if (!t) return false;
  return ['movil', 'usuario', 'chofer', 'tens'].every(function (k) { return String(t[k] || '').trim() !== ''; });
}

function filaTraslado_(s, folio, ahora) {
  const t = s.t || {}, km = s.km || {};
  const f = function (iso) { return iso ? new Date(iso) : ''; };
  const min = function (a, b) { return a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : ''; };
  const kmRec = (km.salidaHF != null && km.llegadaHF != null) ? km.llegadaHF - km.salidaHF : '';
  return [folio, s.estado || '', s.fecha || '', s.movil || '', s.motivo || '', s.destino || '', s.solicitadoPor || '', s.autorizadoPor || '',
    f(t.solicitud), f(t.salidaHF), val_(km.salidaHF), f(t.llegadaDest), val_(km.llegadaDest), f(t.salidaDest), f(t.llegadaHF), val_(km.llegadaHF), kmRec,
    val_(s.kmSinRegistro), min(t.solicitud, t.salidaHF), min(t.salidaHF, t.llegadaHF), s.conductor || '', s.tens || '', (s.avanzado ? 'Avanzado' + ((s.apoyo || []).length ? ': ' + s.apoyo.join(', ') : '') : (s.medico || '')),
    val_(s.nPacientes), s.episodios || '', s.obs || '', s.anulacion || '', s.registradoPor || '', ahora, s.id];
}

/* ------------------------------------------------------------------
 * Respaldo diario: copia CSV de Eventos en Drive y registra su SHA-256.
 * Si alguien alterara filas antiguas, la huella del día no coincidiría.
 * ------------------------------------------------------------------ */
function respaldoDiario() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const datos = ss.getSheetByName('Eventos').getDataRange().getDisplayValues();
  const csv = datos.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';'); }).join('\r\n');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, csv, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  const carpetas = DriveApp.getFoldersByName(CARPETA_RESPALDO);
  const carpeta = carpetas.hasNext() ? carpetas.next() : DriveApp.createFolder(CARPETA_RESPALDO);
  const nombre = 'eventos_' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd_HHmm') + '.csv';
  const archivo = carpeta.createFile(nombre, csv, MimeType.CSV);
  const shI = ss.getSheetByName('Integridad');
  shI.appendRow([new Date(), datos.length - 1, hash, archivo.getUrl()]);
  formatearHoras_(shI, 'Integridad', shI.getLastRow(), 1);
}

/* ---------------- utilidades ---------------- */
function formatearHoras_(sh, nombre, fila, n) {
  if (!COLUMNAS_HORA[nombre] || n < 1) return;
  COLUMNAS_HORA[nombre].forEach(function (col) {
    sh.getRange(fila, HOJAS[nombre].indexOf(col) + 1, n, 1).setNumberFormat(FORMATO_HORA);
  });
}
function filas_(sh) { return sh && sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues() : []; }
function columna_(sh, col) { return sh.getLastRow() > 1 ? sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : []; }
function val_(v) { return v === null || v === undefined ? '' : v; }
function valorTexto_(v) { return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)); }
