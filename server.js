'use strict';
/*
  Servidor local de la Calculadora 3D (sin dependencias, solo Node).
  - Sirve la página en http://localhost:3737 (y, con "celular": true, en la red de tu casa con una clave)
  - Lamina la pieza que subís con tu OrcaSlicer (línea de comandos) y devuelve gramos y tiempo
  - Lee una publicación de MakerWorld a partir de su enlace (datos públicos: título, perfiles, gramos)
  - Guarda la pieza en tu carpeta de impresión, descomprimida si viene en zip
  - Guarda el seguimiento de costos/ganancias en datos/datos.json
  Desde la PC no pide clave. Desde otro aparato pide la clave (cookie) y solo acepta direcciones de red local.
*/
const http = require('http'), fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os'), crypto = require('crypto');

const PORT = parseInt(process.env.CALC3D_PORT || '3737', 10);
const ROOT = __dirname;
const DATA_DIR = process.env.CALC3D_DATOS || path.join(ROOT, 'datos');
const DATA = path.join(DATA_DIR, 'datos.json');
const CONF_FILE = process.env.CALC3D_CONFIG || path.join(ROOT, 'config.json');
const MAX_BODY = 300 * 1024 * 1024;
const MAX_EXTRAIDO = 2 * 1024 * 1024 * 1024;
const MODELOS = ['.stl', '.3mf', '.obj', '.step', '.stp'];
const COMPRIMIDOS = ['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz'];
const EXT_OK = MODELOS.concat(COMPRIMIDOS);
const TEST_COMO_LAN = !!process.env.CALC3D_TRATAR_COMO_LAN; // solo para pruebas: trata a la PC como si fuera otro aparato

const DEFAULT_CONF = {
  orca: 'F:\\OrcaSlicer\\orca-slicer.exe',
  datosOrca: path.join(process.env.APPDATA || '', 'OrcaSlicer'),
  maquina: 'Artillery Genius 0.4 nozzle',
  sufijoPerfiles: '@Artillery Genius',
  procesoPorDefecto: '0.20mm Standard @Artillery Genius',
  filamentos: {
    PLA: 'Artillery PLA Pablo',
    PETG: 'Artillery Generic PETG',
    ABS: 'Artillery Generic ABS',
    TPU: 'Artillery Generic TPU'
  },
  carpetaImprimir: path.join('F:\\Desktop', '\u3164'),
  celular: false, // lo activa «Permitir celular.bat» (abre el firewall solo a la red local y pone esto en true)
  token: ''
};
fs.mkdirSync(DATA_DIR, { recursive: true });
function conf() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8').replace(/^﻿/, '')); } catch (e) { /* sin config: se usan los valores de fábrica */ }
  return Object.assign({}, DEFAULT_CONF, c, process.env.CALC3D_CARPETA ? { carpetaImprimir: process.env.CALC3D_CARPETA } : {});
}
// config.json se crea la primera vez, con una clave nueva para el celular
(function iniciarConfig() {
  let c = {}; let existe = fs.existsSync(CONF_FILE);
  if (existe) { try { c = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8').replace(/^﻿/, '')); } catch (e) { return; } }
  let cambio = !existe;
  for (const k of Object.keys(DEFAULT_CONF)) if (c[k] === undefined) { c[k] = DEFAULT_CONF[k]; cambio = true; }
  if (!c.token) { c.token = crypto.randomBytes(12).toString('hex'); cambio = true; }
  if (cambio) fs.writeFileSync(CONF_FILE, JSON.stringify(c, null, 2));
})();

/* ---------- perfiles de Orca (se resuelve la herencia "inherits") ---------- */
function walk(dir, out) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out;
}
function presetIndex(c) {
  const index = {};
  const roots = [{ r: path.join(c.datosOrca, 'system'), user: false }, { r: path.join(c.datosOrca, 'user', 'default'), user: true }];
  for (const { r, user } of roots) {
    for (const f of walk(r, [])) {
      const type = path.basename(path.dirname(f));
      if (!['machine', 'process', 'filament'].includes(type)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
        if (j.name) index[type + '|' + j.name] = { file: f, user };
      } catch (e) { /* perfil roto: se ignora */ }
    }
  }
  function resolve(type, name, depth) {
    depth = depth || 0;
    const it = index[type + '|' + name];
    if (!it) throw new Error('No encuentro el perfil de Orca (' + type + '): ' + name);
    const j = JSON.parse(fs.readFileSync(it.file, 'utf8').replace(/^\uFEFF/, ''));
    let base = {};
    if (j.inherits && j.inherits !== name && depth < 10) base = resolve(type, j.inherits, depth + 1);
    const m = Object.assign({}, base, j);
    delete m.inherits;
    return m;
  }
  function procesos(sufijo) {
    return Object.keys(index).filter(k => k.startsWith('process|') && k.endsWith(sufijo))
      .map(k => ({ name: k.slice(8), usuario: index[k].user }))
      .sort((a, b) => (b.usuario - a.usuario) || a.name.localeCompare(b.name));
  }
  return { index, resolve, procesos };
}

/* ---------- lectura del gcode ---------- */
function parseDur(s) {
  let t = 0, m; const re = /(\d+(?:\.\d+)?)\s*([dhms])/g;
  while ((m = re.exec(s))) t += parseFloat(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2]];
  return t;
}
function parseGcode(file) {
  const st = fs.statSync(file), N = 400000;
  const fd = fs.openSync(file, 'r');
  const read = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.toString('latin1', 0, n); };
  let txt = read(0, Math.min(N, st.size));
  if (st.size > N) txt += '\n' + read(Math.max(N, st.size - N), Math.min(N, st.size - N));
  fs.closeSync(fd);
  const get = (re) => { const m = txt.match(re); return m ? m[1].trim() : null; };
  let g = get(/;\s*total filament used \[g\]\s*=\s*([\d.]+)/i);
  if (g == null) g = get(/;\s*total filament weight \[g\]\s*:\s*([\d.]+)/i);
  let t = get(/;\s*estimated printing time \(normal mode\)\s*=\s*([^\r\n]+)/i);
  if (t == null) t = get(/;\s*total estimated time:\s*([^\r\n]+)/i);
  if (g == null || t == null) return null;
  return {
    g: parseFloat(g),
    secs: Math.round(parseDur(t)),
    capas: parseInt(get(/;\s*total layers count\s*=\s*(\d+)/i) || get(/;\s*total layer number:\s*(\d+)/i) || '0', 10),
    soportes: get(/;\s*enable_support\s*=\s*(\d)/i) === '1',
    relleno: get(/;\s*sparse_infill_density\s*=\s*([^\r\n]+)/i),
    altura: parseFloat(get(/;\s*layer_height\s*=\s*([\d.]+)/i) || '0')
  };
}

/* ---------- procesos externos ---------- */
function run(exe, args, ms, opts) {
  return new Promise(resolve => {
    let out = '';
    const ch = cp.spawn(exe, args, Object.assign({ windowsHide: true }, opts || {}));
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { out += d; });
    const to = setTimeout(() => { ch.kill(); resolve({ code: -1, out: out + '\n(tiempo agotado)' }); }, ms);
    ch.on('close', code => { clearTimeout(to); resolve({ code, out }); });
    ch.on('error', e => { clearTimeout(to); resolve({ code: -1, out: String(e) }); });
    if (opts && opts.vigilar) { const iv = setInterval(() => { if (opts.vigilar()) { ch.kill(); } }, 500); ch.on('close', () => clearInterval(iv)); }
  });
}

/* ---------- carpetas y archivos ---------- */
function tamanoCarpeta(dir) {
  let n = 0;
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    try { n += e.isDirectory() ? tamanoCarpeta(p) : fs.statSync(p).size; } catch (x) { /* archivo que desapareció */ }
  }
  return n;
}
function listarArchivos(dir, base, out) {
  base = base || dir; out = out || [];
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of list) {
    if (e.name === '__MACOSX' || e.name.startsWith('._')) continue;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) listarArchivos(p, base, out);
    else out.push(p);
  }
  return out;
}
function limpiarNombre(s) {
  s = String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+|[. ]+$/g, '');
  return (s || 'pieza').slice(0, 120);
}
function destinoLibre(base, ext) {
  ext = ext || '';
  let d = base, i = 2;
  while (fs.existsSync(d + ext)) { d = base + ' (' + i + ')'; i++; }
  return d + ext;
}
function carpetaImprimirOk(c) {
  if (!c.carpetaImprimir || !fs.existsSync(c.carpetaImprimir)) {
    throw new Error('No encuentro tu carpeta de impresión (' + (c.carpetaImprimir || 'sin configurar') + '). Corregí «carpetaImprimir» en config.json.');
  }
  return c.carpetaImprimir;
}
// copia lo extraído a tu carpeta de impresión: una subcarpeta con el nombre del zip (si el zip trae una sola carpeta adentro, no se duplica)
function guardarExtraido(exDir, baseNombre, c) {
  const raiz = carpetaImprimirOk(c);
  let src = exDir;
  const top = fs.readdirSync(exDir).filter(n => n !== '__MACOSX');
  if (top.length === 1 && fs.statSync(path.join(exDir, top[0])).isDirectory()) src = path.join(exDir, top[0]);
  const dest = destinoLibre(path.join(raiz, limpiarNombre(baseNombre)));
  fs.cpSync(src, dest, { recursive: true, dereference: false, filter: s => { try { return !fs.lstatSync(s).isSymbolicLink() && path.basename(s) !== '__MACOSX'; } catch (e) { return false; } } });
  return { ruta: dest, archivos: listarArchivos(dest).length };
}
function guardarSuelto(buf, nombre, c) {
  const raiz = carpetaImprimirOk(c);
  const ext = path.extname(nombre), base = limpiarNombre(path.basename(nombre, ext));
  const dest = destinoLibre(path.join(raiz, base), ext.toLowerCase());
  fs.writeFileSync(dest, buf);
  return { ruta: dest, archivos: 1 };
}
// .zip: con .NET (respeta nombres Unicode: acentos, chino, emojis) y salteando entradas que quieran salir de la carpeta
const SCRIPT_ZIP = [
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem",
  "$dest=[IO.Path]::GetFullPath($env:ZDEST).TrimEnd('\\')+'\\'; $z=[IO.Compression.ZipFile]::OpenRead($env:ZSRC); $total=0",
  "try { foreach($e in $z.Entries){ $total+=$e.Length }; if($total -gt [long]$env:ZMAX){ throw 'EXPANDE_DEMASIADO' }",
  "foreach($e in $z.Entries){ if($e.FullName.EndsWith('/') -or $e.FullName.EndsWith('\\')){ continue }",
  "$t=[IO.Path]::GetFullPath([IO.Path]::Combine($dest,$e.FullName)); if(-not $t.StartsWith($dest,[StringComparison]::OrdinalIgnoreCase)){ continue }",
  "[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($t)); [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$t,$true) } } finally { $z.Dispose() }"
].join('\n');
async function extraerZip(archivo, exDir) {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT_ZIP], 10 * 60 * 1000,
    { env: Object.assign({}, process.env, { ZSRC: archivo, ZDEST: exDir, ZMAX: String(MAX_EXTRAIDO) }) });
  if (/EXPANDE_DEMASIADO/.test(r.out)) throw new Error('El comprimido se expande a más de 2 GB: lo descarté por seguridad.');
  if (r.code !== 0) throw new Error('No pude descomprimir el zip (' + r.out.trim().slice(-160) + ').');
}
async function extraer(archivoComprimido, exDir) {
  fs.mkdirSync(exDir, { recursive: true });
  if (path.extname(archivoComprimido).toLowerCase() === '.zip') return extraerZip(archivoComprimido, exDir);
  const cwd = path.dirname(archivoComprimido);
  // rutas relativas y ASCII: tar.exe de Windows se confunde con caracteres raros en la ruta
  const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); // bsdtar de Windows (el tar de Git no lee zip)
  const r = await run(fs.existsSync(tarExe) ? tarExe : 'tar.exe', ['-xf', path.basename(archivoComprimido), '-C', path.relative(cwd, exDir)], 10 * 60 * 1000,
    { cwd, vigilar: () => tamanoCarpeta(exDir) > MAX_EXTRAIDO });
  if (tamanoCarpeta(exDir) > MAX_EXTRAIDO) throw new Error('El comprimido se expande a más de 2 GB: lo descarté por seguridad.');
  if (r.code !== 0 && !listarArchivos(exDir).length) throw new Error('No pude descomprimir el archivo (' + r.out.trim().slice(-160) + ').');
}

/* ---------- laminado con Orca (de a uno por vez) ---------- */
async function laminarModelos(modelos, q, c, tmp) {
  const P = presetIndex(c);
  const nombreProceso = q.proceso || c.procesoPorDefecto;
  const machine = P.resolve('machine', c.maquina);
  const proceso = P.resolve('process', nombreProceso);
  const filament = P.resolve('filament', c.filamentos[q.mat] || c.filamentos.PLA);
  if (q.soportes === 'si') proceso.enable_support = '1';
  else if (q.soportes === 'no') proceso.enable_support = '0';
  if (q.relleno > 0 && q.relleno <= 100) proceso.sparse_infill_density = q.relleno + '%';
  const out = fs.mkdtempSync(path.join(tmp, 'lam-'));
  const fm = path.join(out, 'machine.json'), fp = path.join(out, 'process.json'), ff = path.join(out, 'filament.json');
  fs.writeFileSync(fm, JSON.stringify(machine));
  fs.writeFileSync(fp, JSON.stringify(proceso));
  fs.writeFileSync(ff, JSON.stringify(filament));
  const args = ['--slice', '0', '--arrange', '1'];
  if (q.orient) args.push('--orient', '1');
  args.push('--outputdir', out, '--load-settings', fm + ';' + fp, '--load-filaments', ff);
  modelos.forEach(m => args.push(m));
  const r = await run(c.orca, args, 8 * 60 * 1000);
  const gcs = fs.readdirSync(out).filter(f => /\.gcode$/i.test(f)).sort();
  if (!gcs.length) {
    const e = new Error('Orca no pudo laminar la pieza. Puede que no entre en la cama (220 × 220 × 250 mm) o que el archivo esté dañado.');
    e.detalle = r.out.slice(-400);
    throw e;
  }
  // un .gcode por placa: se suman
  let g = 0, secs = 0, capas = 0, base = null;
  for (const f of gcs) {
    const st = parseGcode(path.join(out, f));
    if (!st) throw new Error('Orca laminó, pero no pude leer los gramos y el tiempo del gcode.');
    g += st.g; secs += st.secs; capas = Math.max(capas, st.capas); base = base || st;
  }
  return Object.assign({}, base, { g: Math.round(g * 100) / 100, secs, capas, placas: gcs.length, perfil: nombreProceso, filamento: c.filamentos[q.mat] || c.filamentos.PLA });
}
async function procesarPieza(buf, nombreOrig, q) {
  const c = conf();
  const ext = path.extname(nombreOrig).toLowerCase();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calc3d-'));
  try {
    let modelos = [], guardado = null, avisos = [];
    if (COMPRIMIDOS.includes(ext)) {
      const arch = path.join(tmp, 'entrada' + ext);
      fs.writeFileSync(arch, buf);
      const ex = path.join(tmp, 'ex');
      await extraer(arch, ex);
      const todos = listarArchivos(ex);
      modelos = todos.filter(f => MODELOS.includes(path.extname(f).toLowerCase()));
      const tres = modelos.filter(f => path.extname(f).toLowerCase() === '.3mf');
      if (tres.length) modelos = tres; // un proyecto .3mf ya trae las piezas listas: no se cuentan también los STL
      if (!modelos.length) throw new Error('El comprimido no trae piezas (.stl, .3mf, .obj ni .step).');
      if (q.guardar) guardado = guardarExtraido(ex, path.basename(nombreOrig, ext), c);
      if (modelos.length > 12) { avisos.push('Trae ' + modelos.length + ' piezas: calculé solo las primeras 12.'); modelos = modelos.slice(0, 12); }
    } else if (MODELOS.includes(ext)) {
      const m = path.join(tmp, 'pieza' + ext);
      fs.writeFileSync(m, buf);
      modelos = [m];
      if (q.guardar) guardado = guardarSuelto(buf, nombreOrig, c);
    } else throw new Error('Formato no soportado.');

    if (!fs.existsSync(c.orca)) throw new Error('No encuentro Orca en ' + c.orca + '. Corregí la ruta en config.json.');
    let res;
    try {
      res = await laminarModelos(modelos, q, c, tmp);
    } catch (e) {
      if (modelos.length < 2) throw e;
      // todas juntas no entran en una cama: se laminan de a una y se suman (varias tandas)
      let g = 0, secs = 0, base = null;
      for (const m of modelos) { const r1 = await laminarModelos([m], q, c, tmp); g += r1.g; secs += r1.secs; base = base || r1; }
      res = Object.assign({}, base, { g: Math.round(g * 100) / 100, secs, placas: modelos.length });
      avisos.push('No entran todas juntas en la cama: sumé ' + modelos.length + ' tandas.');
    }
    return Object.assign(res, { archivos: modelos.map(m => path.basename(m)), guardado, avisos });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* queda en temp */ }
  }
}
let cola = Promise.resolve();
function encolar(fn) {
  const p = cola.then(fn);
  cola = p.catch(() => {});
  return p;
}

/* ---------- MakerWorld: datos públicos de una publicación ---------- */
const cacheMW = new Map();
function idMakerWorld(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (e) { return null; }
  const h = u.hostname.toLowerCase();
  if (!(h === 'makerworld.com' || h.endsWith('.makerworld.com'))) return null;
  const m = u.pathname.match(/\/models\/(\d{1,12})/);
  if (!m) return null;
  const p = u.hash.match(/profileId-(\d{1,12})/);
  return { id: m[1], perfil: p ? p[1] : null };
}
function materialDe(tipo) {
  const t = String(tipo || '').toUpperCase();
  if (t.startsWith('PETG') || t === 'PET') return 'PETG';
  if (t.startsWith('ABS') || t === 'ASA') return 'ABS';
  if (t.startsWith('TPU')) return 'TPU';
  return 'PLA';
}
async function leerMakerWorld(raw) {
  const k = idMakerWorld(raw);
  if (!k) throw new Error('No reconozco ese enlace. Tiene que ser una publicación de MakerWorld (makerworld.com/…/models/NÚMERO-nombre). Los enlaces cortos (/s/…) no los puedo abrir: copiá el enlace largo.');
  let j = cacheMW.get(k.id);
  if (!j || Date.now() - j.t > 10 * 60 * 1000) {
    // la API pública que usa el propio sitio (la página web está detrás de Cloudflare y no se puede leer desde acá)
    const r = await fetch('https://api.bambulab.com/v1/design-service/design/' + k.id, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
      redirect: 'error', signal: AbortSignal.timeout(20000)
    });
    if (r.status === 404) throw new Error('No encuentro esa publicación en MakerWorld.');
    if (!r.ok) throw new Error('MakerWorld no respondió (código ' + r.status + '). Probá de nuevo en un rato.');
    j = { t: Date.now(), d: await r.json() };
    cacheMW.set(k.id, j);
  }
  const d = j.d;
  const perfiles = (d.instances || []).map(i => {
    const fil = i.instanceFilaments || [];
    return {
      id: i.id, perfilId: i.profileId, titulo: i.title || ('Perfil ' + i.id),
      g: Number(i.weight) || 0, secs: Number(i.prediction) || 0,
      ams: !!i.needAms, colores: Number(i.materialCnt) || fil.length || 1,
      mat: materialDe(fil[0] && fil[0].type),
      tipos: [...new Set(fil.map(f => String(f.type || '').toUpperCase()).filter(Boolean))],
      maquina: i.extention && i.extention.modelInfo && i.extention.modelInfo.compatibility && i.extention.modelInfo.compatibility.devModelName || ''
    };
  }).filter(p => p.g > 0);
  if (!perfiles.length) throw new Error('Esa publicación no trae perfiles de impresión con gramos.');
  return {
    ok: true, id: String(d.id || k.id), titulo: d.title || 'Pieza de MakerWorld', autor: d.designCreator && d.designCreator.name || '',
    portada: d.coverUrl || '', licencia: d.license || '', url: 'https://makerworld.com/models/' + k.id,
    perfilPedido: k.perfil, perfilPorDefecto: d.defaultInstanceId || null, perfiles
  };
}

/* ---------- acceso: la PC entra libre, el celular con clave ---------- */
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const fallos = new Map();
function esLocal(req) { return !TEST_COMO_LAN && LOCAL.has(req.socket.remoteAddress); }
function ipPrivada(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip) || LOCAL.has(ip);
}
function hostOk(host) {
  host = String(host || '').toLowerCase();
  if (host === 'localhost:' + PORT || host === '127.0.0.1:' + PORT) return true;
  if (new RegExp('^(10|192\\.168|172\\.(1[6-9]|2\\d|3[01]))(\\.\\d{1,3}){2,3}:' + PORT + '$').test(host)) return true;
  const hn = os.hostname().toLowerCase();
  return host === hn + ':' + PORT || host === hn + '.local:' + PORT;
}
function mismaClave(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function cookieClave(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)c3d=([0-9a-f]+)/);
  return m ? m[1] : '';
}
function direccionesCelular(c) {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const nombre of Object.keys(ifs)) for (const a of ifs[nombre]) {
    if (a.family === 'IPv4' && !a.internal && ipPrivada(a.address) && !a.address.startsWith('169.254.')) out.push({ interfaz: nombre, url: 'http://' + a.address + ':' + PORT + '/?t=' + c.token });
  }
  return out;
}

/* ---------- http ---------- */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > MAX_BODY) { reject(new Error('Archivo demasiado grande')); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
const PAGINA_CLAVE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calculadora 3D</title>'
  + '<body style="font:16px system-ui;background:#0a0d12;color:#eef2f8;padding:28px;line-height:1.5"><h1 style="font-size:22px">Falta la clave</h1>'
  + '<p>Abrí la calculadora en la PC, tocá «Usar desde el celular» y mandate ese enlace al celular (por WhatsApp, por ejemplo).</p>';

const server = http.createServer(async (req, res) => {
  try {
    const c = conf();
    if (!hostOk(req.headers.host)) { res.writeHead(403); return res.end('host no permitido'); }
    const origin = req.headers.origin;
    if (origin && origin !== 'http://' + req.headers.host) { res.writeHead(403); return res.end('origen no permitido'); }
    const u = new URL(req.url, 'http://localhost');
    const ip = String(req.socket.remoteAddress || '');

    if (!esLocal(req)) {
      // otro aparato: solo red local y con clave
      if (!c.celular || !ipPrivada(ip)) { res.writeHead(403); return res.end('acceso no permitido'); }
      const bloqueo = fallos.get(ip);
      if (bloqueo && bloqueo.n >= 20 && Date.now() - bloqueo.t < 10 * 60 * 1000) { res.writeHead(429); return res.end('demasiados intentos'); }
      const q = u.searchParams.get('t');
      if (q && mismaClave(q, c.token)) {
        u.searchParams.delete('t');
        res.writeHead(302, { 'Set-Cookie': 'c3d=' + c.token + '; Max-Age=31536000; Path=/; HttpOnly; SameSite=Strict', 'Location': u.pathname + (u.search || ''), 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (!mismaClave(cookieClave(req), c.token)) {
        const f = fallos.get(ip) || { n: 0, t: 0 }; f.n++; f.t = Date.now(); fallos.set(ip, f);
        if (u.pathname.startsWith('/api/')) return json(res, 401, { ok: false, error: 'Falta la clave' });
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGINA_CLAVE);
      }
    }

    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
    }
    if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && u.pathname === '/api/estado') {
      let procesos = [];
      try { procesos = presetIndex(c).procesos(c.sufijoPerfiles); } catch (e) { /* sin lista */ }
      const est = { orca: fs.existsSync(c.orca), maquina: c.maquina, procesos, procesoPorDefecto: c.procesoPorDefecto, filamentos: c.filamentos,
        carpeta: { ruta: c.carpetaImprimir, existe: !!(c.carpetaImprimir && fs.existsSync(c.carpetaImprimir)) }, local: esLocal(req) };
      if (esLocal(req)) est.celular = { activo: !!c.celular, direcciones: c.celular ? direccionesCelular(c) : [] };
      return json(res, 200, est);
    }

    if (u.pathname === '/api/datos') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.existsSync(DATA) ? fs.readFileSync(DATA) : '{}');
      }
      if (req.method === 'PUT') {
        const obj = JSON.parse((await body(req)).toString('utf8'));
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return json(res, 400, { ok: false, error: 'datos inválidos' });
        if (fs.existsSync(DATA)) fs.copyFileSync(DATA, path.join(DATA_DIR, 'datos.bak.json'));
        const tmp = DATA + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
        fs.renameSync(tmp, DATA);
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET' && u.pathname === '/api/enlace') {
      try { return json(res, 200, await leerMakerWorld(u.searchParams.get('url'))); }
      catch (e) { return json(res, 200, { ok: false, error: e.name === 'TimeoutError' ? 'MakerWorld tardó demasiado en responder.' : e.message }); }
    }

    if (req.method === 'POST' && u.pathname === '/api/abrir') {
      const k = idMakerWorld(u.searchParams.get('url'));
      if (!k) return json(res, 400, { ok: false, error: 'Enlace no válido' });
      cp.spawn('explorer.exe', ['https://makerworld.com/models/' + k.id], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && u.pathname === '/api/guardar') {
      const nombre = u.searchParams.get('archivo') || '';
      const ext = path.extname(nombre).toLowerCase();
      const buf = await body(req);
      if (!buf.length) return json(res, 400, { ok: false, error: 'Archivo vacío' });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calc3d-'));
      try {
        if (COMPRIMIDOS.includes(ext)) {
          const arch = path.join(tmp, 'entrada' + ext); fs.writeFileSync(arch, buf);
          await extraer(arch, path.join(tmp, 'ex'));
          return json(res, 200, { ok: true, guardado: guardarExtraido(path.join(tmp, 'ex'), path.basename(nombre, ext), conf()) });
        }
        return json(res, 200, { ok: true, guardado: guardarSuelto(buf, nombre, conf()) });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message });
      } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* queda en temp */ } }
    }

    if (req.method === 'POST' && u.pathname === '/api/laminar') {
      const nombre = u.searchParams.get('archivo') || '';
      const ext = path.extname(nombre).toLowerCase();
      if (!EXT_OK.includes(ext)) return json(res, 400, { ok: false, error: 'Formato no soportado. Usá ' + EXT_OK.join(', ') });
      const buf = await body(req);
      if (!buf.length) return json(res, 400, { ok: false, error: 'Archivo vacío' });
      const q = {
        mat: u.searchParams.get('mat') || 'PLA',
        proceso: u.searchParams.get('proceso') || '',
        soportes: u.searchParams.get('soportes') || 'perfil',
        relleno: parseFloat(u.searchParams.get('relleno')) || 0,
        orient: u.searchParams.get('orient') === '1',
        guardar: u.searchParams.get('guardar') === '1'
      };
      try {
        return json(res, 200, Object.assign({ ok: true }, await encolar(() => procesarPieza(buf, nombre, q))));
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message, detalle: e.detalle || '' });
      }
    }

    res.writeHead(404); res.end('no encontrado');
  } catch (e) {
    try { json(res, 500, { ok: false, error: e.message }); } catch (_) { /* respuesta ya cerrada */ }
  }
});
server.on('error', e => { if (e.code === 'EADDRINUSE') process.exit(0); else { console.error(e); process.exit(1); } });
const BIND = process.env.CALC3D_BIND || (conf().celular ? '0.0.0.0' : '127.0.0.1');
server.listen(PORT, BIND, () => console.log('Calculadora 3D en http://localhost:' + PORT + (BIND === '0.0.0.0' ? ' (y en la red de casa con clave)' : '')));
