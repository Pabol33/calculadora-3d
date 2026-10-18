# Calculadora 3D · Artillery Genius Pro

Calculadora de costos para impresión 3D, en pesos argentinos, con seguimiento de costos y ganancias.

- Arrastrás el archivo de la pieza (`.stl`, `.3mf`, `.obj`, `.step`) o el `.gcode` y calcula gramos, tiempo y costo.
- Marcás cada pieza como **para venta** o **para mí**.
- El seguimiento suma lo gastado, lo cobrado y la ganancia, por mes y por pieza. Exporta a Excel (`.csv`) y hace respaldo (`.json`).

## Dos formas de usarla

**En tu PC (completa).** Abrí `Calculadora 3D.vbs`. Arranca un servidor local (`server.js`, solo Node, sin instalar nada más) en `http://localhost:3737`:

- Lamina la pieza con tu OrcaSlicer por línea de comandos y usa tus perfiles y tu filamento. El gramaje y el tiempo son los de Orca.
- Guarda el seguimiento en `datos/datos.json`.
- Las rutas están en `config.json` (se crea solo la primera vez; ahí se cambia dónde está Orca, el perfil por defecto y los filamentos por material).

**En internet (sin Orca).** La página estática estima gramos y tiempo desde la forma del STL u OBJ con un modelo calibrado contra Orca (±5 % en peso, ±8 % de promedio en tiempo, sin soportes). El seguimiento queda en el navegador: usá «Respaldo» para moverlo.

## Archivos

| Archivo | Para qué |
| --- | --- |
| `index.html` | La página (todo el cálculo y el seguimiento) |
| `server.js` | Servidor local: lamina con Orca y guarda los datos |
| `iniciar.ps1` / `Calculadora 3D.vbs` | Lanzador sin ventana negra |
| `datos/`, `config.json` | Tus datos y tu configuración (no se suben a git) |
