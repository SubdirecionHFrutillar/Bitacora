#!/usr/bin/env python3
"""Arma apps-script/Index.html a partir de src/shell.html + src/App.jsx.

Uso: python3 scripts/build.py           -> escribe apps-script/Index.html
     python3 scripts/build.py --check   -> solo verifica que Index.html está al día
"""
import pathlib, sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
MARCA = '%APP_JSX%'


def armar() -> str:
    shell = (RAIZ / 'src' / 'shell.html').read_text(encoding='utf-8')
    app = (RAIZ / 'src' / 'App.jsx').read_text(encoding='utf-8')
    if shell.count(MARCA) != 1:
        sys.exit('src/shell.html debe tener exactamente una marca ' + MARCA)
    return shell.replace(MARCA, app)


def main() -> None:
    destino = RAIZ / 'apps-script' / 'Index.html'
    nuevo = armar()
    if '--check' in sys.argv:
        actual = destino.read_text(encoding='utf-8') if destino.exists() else ''
        if actual != nuevo:
            sys.exit('apps-script/Index.html NO coincide con src/. Ejecuta: python3 scripts/build.py')
        print('OK: apps-script/Index.html coincide con src/')
        return
    destino.write_text(nuevo, encoding='utf-8')
    print('Escrito', destino.relative_to(RAIZ))


if __name__ == '__main__':
    main()
