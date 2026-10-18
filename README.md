# Calculadora 3D · Artillery Genius Pro

Calculadora de costos para impresión 3D, en pesos argentinos, con seguimiento de costos y ganancias.

- Arrastrás el archivo de la pieza (`.stl`, `.3mf`, `.obj`, `.step`, `.zip`) o el `.gcode` y calcula gramos, tiempo y costo.
- O pegás el enlace de una publicación de **MakerWorld** y calcula con los datos de la publicación.
- Marcás cada pieza como **para venta** o **para mí**.
- El seguimiento suma lo gastado, lo cobrado y la ganancia, por mes y por pieza. Exporta a Excel (`.csv`) y hace respaldo (`.json`).

## Dos formas de usarla

**En tu PC (completa).** Abrí `Calculadora 3D.vbs`. Arranca un servidor local (`server.js`, solo Node, sin instalar nada más) en `http://localhost:3737`:

- Lamina la pieza con tu OrcaSlicer por línea de comandos y usa tus perfiles y tu filamento. El gramaje y el tiempo son los de Orca. Si subís un `.zip`, lo descomprime y calcula todas las piezas juntas (si trae `.3mf`, usa solo esos).
- **Guardar en tu carpeta de impresión:** tildando «Guardarla también en mi carpeta de impresión», la pieza queda en esa carpeta (`carpetaImprimir` en `config.json`), con el zip ya descomprimido en una subcarpeta con su nombre.
- **Enlace de MakerWorld:** lee la publicación por la API pública del propio sitio (título, perfiles, gramos y tiempo de la publicación). El tiempo publicado es de una Bambu, así que se multiplica por el factor «Tu impresora vs una Bambu». MakerWorld pide iniciar sesión para bajar el archivo: por eso el archivo lo bajás vos (en el celular o en la PC) y lo elegís en la calculadora para el cálculo exacto y para guardarlo.
- **Imprimirla:** con una publicación leída, el botón abre la página en el navegador de tu PC (donde ya estás logueado en MakerWorld) y espera. En el botón verde grande «Abrir en Bambu Studio» tocás la flechita ▾ de la derecha y elegís descargar el archivo (3MF o STL). Cuando llega a tu carpeta de Descargas (la real de Windows, o las de `carpetasDescarga` en `config.json`) la calculadora lo guarda en tu carpeta de impresión ya descomprimido, calcula el costo exacto con Orca, reemplaza el aproximado y manda el original a la Papelera (como tu vigilante de zips). Si baja un zip sin piezas (fotos), avisa y sigue esperando; si Orca no puede laminar el archivo, igual queda guardado; si pasan 30 minutos, vence. Con «¿Necesita soportes?» podés sumar tiempo y peso al cálculo aproximado (pocos: +20 % de tiempo y +10 % de peso; muchos: +50 % y +25 %). **No baja el archivo sola:** MakerWorld pide iniciar sesión y frena a los programas con una verificación anti-robots (la API contesta 418), así que la descarga la hacés vos con un toque y la calculadora no guarda ni usa tu sesión.
- Guarda el seguimiento en `datos/datos.json`.
- Las rutas están en `config.json` (se crea solo la primera vez): dónde está Orca, el perfil por defecto, los filamentos por material y la carpeta de impresión.

**Desde el celular.** Con el servidor andando en la PC, en la pantalla de la PC tocá «Usar desde el celular»: aparece un enlace con una clave. Mandátelo al celular y abrilo con el celular en el WiFi de tu casa; la primera vez guarda la clave y después abre directo. Desde el celular podés pegar enlaces de MakerWorld, elegir un archivo bajado (por ejemplo desde Archivos) y guardarlo en la carpeta de la PC.

- Una sola vez, ejecutá **`Permitir celular.bat`** (clic derecho → Ejecutar como administrador): crea una regla del firewall solo para el puerto 3737 y solo desde la red local, pone `"celular": true` en `config.json`, cierra el servidor y vuelve a abrir la calculadora sola (sin permisos de administrador). Ahí tocás «Usar desde el celular». Mientras no lo hagas, el servidor escucha solo en la PC.
- Seguridad: desde otro aparato el servidor exige la clave (cookie), acepta solo direcciones de red local y chequea el origen. Quien tenga el enlace con la clave puede usar la calculadora y guardar archivos en tu carpeta de impresión: no lo compartas. Para cambiar la clave, borrá la línea `token` de `config.json` y reiniciá. Para apagar el acceso desde el celular, poné `"celular": false` en `config.json`.

**En internet (sin Orca).** La página estática estima gramos y tiempo desde la forma del STL u OBJ con un modelo calibrado contra Orca (±5 % en peso, ±8 % de promedio en tiempo, sin soportes). No lee enlaces ni guarda en la PC. El seguimiento queda en el navegador: usá «Respaldo» para moverlo.

## Archivos

| Archivo | Para qué |
| --- | --- |
| `index.html` | La página (todo el cálculo y el seguimiento) |
| `server.js` | Servidor local: lamina con Orca, lee MakerWorld, guarda la pieza y los datos |
| `iniciar.ps1` / `Calculadora 3D.vbs` | Lanzador sin ventana negra |
| `Permitir celular.bat` / `.ps1` | Abre el puerto 3737 del firewall a la red local (una vez) |
| `datos/`, `config.json` | Tus datos y tu configuración, con la clave del celular (no se suben a git) |
