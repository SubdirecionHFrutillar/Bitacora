#!/usr/bin/env python3
"""Arma la app de las tablets (PWA) en dist/bitacora/, lista para copiar a GitHub Pages.

Uso:
    npm install                         (solo la primera vez: baja esbuild, Tailwind, React…)
    python3 scripts/build.py            -> genera dist/bitacora/
    python3 scripts/build.py --publicar ../Bitacora
                                        -> además reemplaza la carpeta bitacora/ de ese repositorio

La URL del servidor (api_url, la /exec de Apps Script) va en bitacora.config.json.
El token de cada tablet NUNCA va aquí ni en el repositorio.
"""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
from datetime import datetime, timezone

RAIZ = pathlib.Path(__file__).resolve().parent.parent
SRC = RAIZ / 'src'
NM = RAIZ / 'node_modules'
DIST = RAIZ / 'dist' / 'bitacora'

VENDOR = {
    'vendor/react.production.min.js': NM / 'react/umd/react.production.min.js',
    'vendor/react-dom.production.min.js': NM / 'react-dom/umd/react-dom.production.min.js',
    'vendor/lucide-react.min.js': NM / 'lucide-react/dist/umd/lucide-react.min.js',
    'vendor/qrcode.js': NM / 'qrcode-generator/qrcode.js',
}
PESOS_ROBOTO = [400, 500, 700, 900]


def falla(msg):
    sys.exit('ERROR: ' + msg)


def binario(nombre):
    b = NM / '.bin' / nombre
    if not b.exists():
        falla(f'falta {nombre}. Ejecute primero: npm install')
    return str(b)


def main():
    cfg = json.loads((RAIZ / 'bitacora.config.json').read_text(encoding='utf-8'))
    api_url = str(cfg.get('api_url') or '').strip()
    if api_url and not (api_url.startswith('https://script.google.com/macros/s/') and api_url.endswith('/exec')):
        if '--prueba' not in sys.argv:
            falla('api_url debe ser la URL /exec de Apps Script (https://script.google.com/macros/s/…/exec)')
    if '--api-url' in sys.argv:   # solo para pruebas locales
        api_url = sys.argv[sys.argv.index('--api-url') + 1]

    app = (SRC / 'App.jsx').read_text(encoding='utf-8')
    for marca in ('%API_URL%', '%VERSION%'):
        if app.count(marca) != 1:
            falla(f'src/App.jsx debe tener exactamente una marca {marca}')

    # Versión: fecha + huella de todo lo que entra a la app (cambia solo si cambia algo)
    h = hashlib.sha256(api_url.encode())
    for p in sorted(list(SRC.rglob('*')) + [RAIZ / 'tailwind.config.js', RAIZ / 'package-lock.json']):
        if p.is_file():
            h.update(p.relative_to(RAIZ).as_posix().encode())
            h.update(p.read_bytes())
    version = datetime.now(timezone.utc).strftime('%Y.%m.%d') + '-' + h.hexdigest()[:6]

    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / 'vendor').mkdir(parents=True)
    (DIST / 'fonts').mkdir()
    (DIST / 'icons').mkdir()

    # 1) JSX -> JS (sin Babel en la tablet). React, ReactDOM y lucide quedan como scripts aparte (globales).
    tmp = RAIZ / 'dist' / 'App.build.jsx'
    tmp.write_text(app.replace('%API_URL%', api_url).replace('%VERSION%', version), encoding='utf-8')
    subprocess.run([binario('esbuild'), str(tmp), '--loader:.jsx=jsx', '--jsx=transform', '--target=es2018,chrome70,safari12',
                    '--minify', '--charset=utf8', '--log-level=warning', '--outfile=' + str(DIST / 'app.js')], check=True)
    tmp.unlink()

    # 2) Tailwind estático (solo las clases que usa App.jsx) + fuentes gobCL (embebida) y Roboto (local)
    roboto = ''.join(
        "@font-face{font-family:'Roboto';font-style:normal;font-weight:%d;font-display:swap;src:url(fonts/roboto-%d.woff2) format('woff2')}" % (w, w)
        for w in PESOS_ROBOTO)
    entrada = RAIZ / 'dist' / 'entrada.css'
    entrada.write_text('@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' + roboto + '\n' +
                       (SRC / 'pwa' / 'gobcl.css').read_text(encoding='utf-8'), encoding='utf-8')
    r = subprocess.run([binario('tailwindcss'), '-c', str(RAIZ / 'tailwind.config.js'), '-i', str(entrada),
                        '-o', str(DIST / 'app.css'), '--minify'], cwd=RAIZ, capture_output=True, text=True)
    if r.returncode != 0:
        falla('Tailwind: ' + r.stderr)
    entrada.unlink()
    for w in PESOS_ROBOTO:
        shutil.copy(NM / f'@fontsource/roboto/files/roboto-latin-{w}-normal.woff2', DIST / 'fonts' / f'roboto-{w}.woff2')

    # 3) Librerías, íconos, manifest, página de alta (QR)
    for destino, origen in VENDOR.items():
        if not origen.exists():
            falla(f'falta {origen.relative_to(RAIZ)}. Ejecute: npm install')
        shutil.copy(origen, DIST / destino)
    for p in (SRC / 'icons').iterdir():
        shutil.copy(p, DIST / 'icons' / p.name)
    manifest = {
        'name': 'Bitácora Ambulancia HF', 'short_name': 'Bitácora', 'description': 'Registro de traslados de ambulancia · Hospital de Frutillar',
        'lang': 'es', 'start_url': './', 'scope': './', 'display': 'standalone', 'orientation': 'any',
        'background_color': '#F2F5F9', 'theme_color': '#0F69C4',
        'icons': [
            {'src': 'icons/ambulancia-192.png', 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any'},
            {'src': 'icons/ambulancia-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'},
            {'src': 'icons/ambulancia-maskable-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
        ],
    }
    (DIST / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    shutil.copy(SRC / 'pwa' / 'qr.html', DIST / 'qr.html')
    (DIST / 'index.html').write_text((SRC / 'pwa' / 'index.html').read_text(encoding='utf-8').replace('%VERSION%', version), encoding='utf-8')

    # 4) Service worker: lista exacta de lo que se guarda para abrir sin señal
    v = '?v=' + version
    archivos = ['./', './index.html', './manifest.json', './app.js' + v, './app.css' + v,
                './vendor/react.production.min.js' + v, './vendor/react-dom.production.min.js' + v, './vendor/lucide-react.min.js' + v] + \
               [f'./fonts/roboto-{w}.woff2' for w in PESOS_ROBOTO] + \
               ['./icons/' + p.name for p in sorted((SRC / 'icons').iterdir())]
    sw = (SRC / 'pwa' / 'sw.js').read_text(encoding='utf-8').replace('%VERSION%', version).replace('%ARCHIVOS%', json.dumps(archivos, indent=2))
    (DIST / 'sw.js').write_text(sw, encoding='utf-8')

    kb = sum(p.stat().st_size for p in DIST.rglob('*') if p.is_file()) // 1024
    print(f'Listo: dist/bitacora/  ·  versión {version}  ·  {kb} KB')
    if not api_url:
        print('AVISO: api_url está vacío en bitacora.config.json -> la app queda en MODO DEMO (no envía a la planilla).')

    if '--publicar' in sys.argv:
        i = sys.argv.index('--publicar')
        if i + 1 >= len(sys.argv):
            falla('indique la carpeta del repositorio: --publicar ../Bitacora')
        repo = pathlib.Path(sys.argv[i + 1]).resolve()
        if not (repo / '.git').exists():
            falla(f'{repo} no es un repositorio git')
        destino = repo / 'bitacora'
        if destino.exists():
            shutil.rmtree(destino)
        shutil.copytree(DIST, destino)
        print(f'Copiado a {destino}. Revise con "git status", luego commit y push a main.')


if __name__ == '__main__':
    main()
