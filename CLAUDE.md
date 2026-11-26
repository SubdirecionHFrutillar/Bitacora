# Bitácora de Ambulancia — Hospital de Frutillar

Registro digital de traslados de las ambulancias del Hospital de Frutillar. Reemplaza el talonario de papel y es el
**registro oficial**: nunca se borra nada (los errores se anulan o se corrigen con motivo).

## Arquitectura (desde nov-2026)

```
Tablet (PWA en GitHub Pages)                         Google (cuenta dueña)
  https://subdirecionhfrutillar.github.io/            Apps Script "Código.gs" ──► Planilla
         Bitacora/bitacora/                             doPost (única entrada)       Eventos (append-only)
  · React precompilado (sin Babel ni CDN)    POST       lista blanca + token         Traslados, Bitácora
  · service worker: abre SIN señal  ───────────────►   funciones privadas  *_        Personal, Config
  · cola offline de eventos (localStorage)  text/plain                               Panel, Integridad
  · token de la tablet (localStorage)       ◄──────── { data } | { error, codigo }
```

- **Frontend**: `src/App.jsx` (React 18 + lucide + Tailwind). `scripts/build.py` lo compila con esbuild a
  `dist/bitacora/` (JS, CSS estático, librerías locales, service worker, manifest, íconos). La tablet no descarga nada
  de internet salvo la propia app y la API.
- **Backend**: `apps-script/Código.gs`, pegado en el proyecto de Apps Script de la planilla.
  - `doPost(e)` es la ÚNICA puerta: recibe `{ fn, args, token, dispositivo, version }` (JSON enviado como
    `text/plain` para evitar el "preflight" CORS) y responde `{ data }` o `{ error, codigo }`.
    Códigos: `PEDIDO`, `TOKEN_INVALIDO`, `FN_NO_PERMITIDA`, `ERROR`. Siempre JSON, nunca una página de error.
  - El token se valida **antes** de tomar el `LockService` o leer la planilla.
  - Lista blanca: `getConfig`, `syncEventos`, `agregarPersona`, `anularTraslado`, `getEstadoMoviles`, `getTrasladosDia`.
    Cada una llama a su versión privada con guion bajo final (`getConfig_`, …).
  - **No quitar el guion bajo final**: con la implementación en "Cualquier usuario", `google.script.run` podría
    llamar cualquier función pública. Las privadas (`_`) no se pueden llamar desde la web ni ejecutar desde el menú.
  - `doGet` ya no sirve la app: muestra una página con el enlace a la PWA.
  - Sin cambios: `setup`, `respaldoDiario` (disparador diario 23:50), `actualizarPanel` (cada hora),
    `actualizarBitacora`, la lógica de traslados, km, turno, folios, Panel y Bitácora.
- **Panel de gestión**: proyecto de Apps Script aparte (no está aquí). No se migró ni se tocó.

## Identidad y trazabilidad (qué cambió en la seguridad)

| Antes (Apps Script con cuenta Google) | Ahora (PWA + token) |
|---|---|
| Cada evento guardaba el **correo** de la cuenta Google (`cuenta_google`) | `cuenta_google` = `token:<nombre del token> · <ID de la tablet>` (sin columnas nuevas) |
| Acceso: cuenta Google con sesión iniciada | Acceso: token por tablet, revocable al instante |
| La app no abría sin señal | Abre sin señal; la cola se envía al volver la señal |

- **La identidad legal de quién registra es el Turno** (móvil, quién registra, chofer, TENS), que va en cada evento y
  que el servidor exige. El token solo autentica el **equipo**. En la práctica la cuenta Google de las tablets ya era
  compartida, así que el correo tampoco identificaba a una persona.
- Trazabilidad de cada evento: turno + ID de la tablet (`dispositivo`) + nombre del token + hora de la tablet y hora
  del servidor (`desfase_min`). La app avisa si el reloj de la tablet difiere más de 5 min.
- Lo que se pierde: la autenticación individual por Google. Debe quedar aprobado por la Dirección.
- Riesgo aceptado: todas las páginas de `subdirecionhfrutillar.github.io` comparten el almacenamiento del navegador.
  **No agregar scripts de terceros (analytics, widgets) a ningún repositorio de esa organización.**
- La URL `/exec` es pública: un pedido sin token válido se rechaza sin tocar la planilla ni el lock; los rechazos se
  cuentan en caché (`console.warn` cada 50).

## Tokens de las tablets

Se guardan en **Propiedades del script** (clave `tokens`): `{ token: { nombre, activo, creado, revocado?, ultimo?, dispositivo?, version? } }`.
Se administran desde el editor de Apps Script (las funciones `ADMIN_*` se niegan a correr desde la web):

- **Crear**: escribir el nombre en `ADMIN_NOMBRE_TABLET` → guardar → ejecutar `ADMIN_crearToken`. El registro de
  ejecución muestra el token **una sola vez**, el enlace de alta (`…/bitacora/#t=TOKEN`) y el enlace al QR
  (`…/bitacora/qr.html#t=TOKEN`, el QR se dibuja en el navegador: el token no sale a internet).
- **Revocar**: poner el token (o sus primeros 8+ caracteres) en `ADMIN_TOKEN_A_REVOCAR` → ejecutar `ADMIN_revocarToken`.
  Efecto inmediato: la tablet recibe `TOKEN_INVALIDO`, borra su token y pide uno nuevo (sus registros pendientes se conservan
  y se envían cuando reciba un token válido).
- **Ver**: `ADMIN_listarTokens` (estado, primeros 8 caracteres, último contacto, ID de tablet, versión de la app).
- Por debajo: `crearTokenTablet_(nombre)` y `revocarTokenTablet_(token)`.

## Desarrollo

```bash
npm install                                   # una vez
python3 scripts/build.py                      # genera dist/bitacora/
npm test                                      # 8 pruebas: Código.gs real en un simulador + Chromium
python3 scripts/build.py --publicar ../Bitacora   # copia dist/bitacora/ a <repo Bitacora>/bitacora/
```

- `bitacora.config.json`: `api_url` (URL `/exec` de la implementación con acceso "Cualquier usuario"). Vacía = modo demo.
- La versión (`AAAA.MM.DD-huella`) se calcula sola; la tablet la muestra en la cabecera y en Resumen → Esta tablet.
- `scripts/test/gas-simulado.mjs` carga el `Código.gs` real con una planilla en memoria. Limitación: Node atiende un
  pedido a la vez, así que la concurrencia real (LockService) solo se prueba en Google.
- No editar `dist/` ni la carpeta publicada a mano: se regeneran.
- La versión anterior (Apps Script + `Index.html` con Babel en la tablet) es el commit `bcc0fa8` de la rama `app-fuente`
  ("Estado actual: Código.gs, Index.html…"): `git show bcc0fa8:apps-script/Index.html`.

## Publicar un cambio

1. **App** (`src/`): `python3 scripts/build.py --publicar ../Bitacora` → commit y push del repo Bitacora. Las tablets
   ven "Hay una versión nueva · Actualizar" (revisan cada 30 min y al abrir).
2. **Backend** (`Código.gs`): pegar en el editor → Implementar → **Gestionar implementaciones → lápiz → Versión:
   Nueva versión → Implementar**. NUNCA "Nueva implementación": cambia la URL `/exec` y todas las tablets quedan sin servidor.
3. Si cambia el formato de un pedido, el backend debe seguir aceptando el anterior: puede haber tablets con la versión
   vieja en caché. Nunca descartar eventos en silencio.

## Cambio de la app antigua a la PWA (orden, sin cortar el servicio)

1. Nueva implementación de este `Código.gs` con acceso **"Cualquier usuario"**, dejando intacta la implementación actual
   (sigue en su versión anterior y la app vieja sigue funcionando). Copiar su URL `/exec` a `bitacora.config.json`.
2. Publicar la PWA, crear un token por tablet y probar en una tablet real (incluido modo avión).
3. Por cada tablet: en la app vieja, con señal, esperar «Sincronizado» (0 en cola) → abrir el enlace o QR de alta →
   instalar ("Agregar a pantalla de inicio") → borrar el acceso directo viejo. La pantalla del token tiene un enlace a
   la app anterior para vaciar pendientes.
4. Recién con todas las tablets migradas: editar la implementación **antigua** a la versión nueva (su `doGet` mostrará
   el enlace). Desde ese momento la app vieja ya no puede enviar nada.
5. Mientras dure el cambio, el talonario de papel va en cada ambulancia. Volver atrás = usar la URL antigua (paso 1-3).

## Convenciones

- Español en código, comentarios y textos. Botones grandes (≥ 52 px), modo día/noche, sin nombres de pacientes.
- Todo acceso a `localStorage` va en try/catch.
- Un evento solo sale de la cola cuando el servidor confirma su `evento_id` (idempotente: reenviar no duplica).
