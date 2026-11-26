# Bitácora de Ambulancia · Hoja de administración (1 página)

**App:** https://subdirecionhfrutillar.github.io/Bitacora/bitacora/ · **Datos:** planilla de la bitácora (Google) ·
**Responsable:** Subdirección. Guardar una copia de esta hoja en la misma planilla.

## Dar de alta una tablet (5 minutos)
1. Abrir la planilla → **Extensiones → Apps Script**.
2. Arriba en el código, cambiar `ADMIN_NOMBRE_TABLET = '...'` por un nombre claro (ej. `Tablet Móvil 01 - 2026`). Guardar (💾).
3. En la barra superior elegir la función **ADMIN_crearToken** → **Ejecutar**.
4. Abajo, en "Registro de ejecución", copiar el **enlace del código QR** y abrirlo en el computador.
5. En la tablet: abrir la **cámara**, apuntar al QR y tocar el enlace. La bitácora queda configurada.
6. En la tablet: menú de Chrome (⋮) → **Agregar a pantalla de inicio** / **Instalar app**.
7. Cerrar la página del QR. El token no se vuelve a mostrar (si se pierde, se crea otro).

## Si se pierde o roban una tablet (hacerlo el mismo día)
1. Apps Script → ejecutar **ADMIN_listarTokens** → buscar la tablet y copiar sus primeros 8 caracteres.
2. Pegarlos en `ADMIN_TOKEN_A_REVOCAR = '...'` → Guardar → ejecutar **ADMIN_revocarToken**.
3. Desde ese momento esa tablet no puede enviar ni leer nada. Para la tablet de reemplazo: "Dar de alta".

## Publicar un cambio
- **En la app (pantallas):** lo hace quien mantiene el código con `python3 scripts/build.py --publicar ../Bitacora`
  y luego commit + push. Las tablets muestran "Hay una versión nueva · **Actualizar**".
- **En el Código.gs:** Implementar → **Gestionar implementaciones** → lápiz ✏️ → Versión: **Nueva versión** → Implementar.
  ⚠️ **Nunca "Nueva implementación"**: cambia la dirección y todas las tablets quedan sin servidor.
- ⚠️ No quitar el guion bajo final de los nombres de funciones (`getConfig_`, etc.): es una protección.

## Si la app no abre o no envía
| Qué se ve | Qué hacer |
|---|---|
| "Sin señal · N en cola" | Normal en ruta. Se envía sola al volver la señal. **No borrar datos del navegador ni desinstalar.** |
| "Configurar esta tablet" con aviso de token | El token fue revocado o se borraron los datos: dar de alta de nuevo. Los registros pendientes se conservan. |
| "Hay una versión nueva" | Tocar **Actualizar**. |
| La hora de la tablet difiere | Ajustes de Android → Fecha y hora → automática. |
| No abre nada | Abrir el enlace de la app con señal. Si sigue igual: usar el **talonario de papel** y avisar a Subdirección. |

## Reglas
- La identidad de quién registra es el **Turno** (móvil, quién registra, chofer, TENS). El token solo identifica la tablet.
- No enviar tokens ni QR por WhatsApp o correo. No agregar scripts de terceros a las páginas de `subdirecionhfrutillar.github.io`.
- Talonario de papel en cada ambulancia como respaldo.
