'use strict';
/*
  Servidor local de la Calculadora 3D (sin dependencias, solo Node).
  - Sirve la página en http://localhost:3737
  - Lamina la pieza que arrastrás con tu OrcaSlicer (línea de comandos) y devuelve gramos y tiempo
  - Guarda el seguimiento de costos/ganancias en datos/datos.json
  Solo escucha en 127.0.0.1: nadie de afuera de tu PC puede entrar.
*/
const http = require('http'), fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');

const PORT = 3737;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'datos');
const DATA = path.join(DATA_DIR, 'datos.json');
const CONF_FILE = path.join(ROOT, 'config.json');
const MAX_BODY = 300 * 1024 * 1024;
const EXT_OK = ['.stl', '.3mf', '.obj', '.step', '.stp'];

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
  }
};
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONF_FILE)) fs.writeFileSync(CONF_FILE, JSON.stringify(DEFAULT_CONF, null, 2));
function conf() {
  try { return Object.assign({}, DEFAULT_CONF, JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'))); }
  catch (e) { return DEFAULT_CONF; }
}

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

/* ---------- laminado con Orca (de a uno por vez) ---------- */
function run(exe, args, ms) {
  return new Promise(resolve => {
    let out = '';
    const ch = cp.spawn(exe, args, { windowsHide: true });
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { out += d; });
    const to = setTimeout(() => { ch.kill(); resolve({ code: -1, out: out + '\n(tiempo agotado)' }); }, ms);
    ch.on('close', code => { clearTimeout(to); resolve({ code, out }); });
    ch.on('error', e => { clearTimeout(to); resolve({ code: -1, out: String(e) }); });
  });
}
async function laminarReal(buf, ext, q) {
  const c = conf();
  if (!fs.existsSync(c.orca)) throw new Error('No encuentro Orca en ' + c.orca + '. Corregí la ruta en config.json.');
  const P = presetIndex(c);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calc3d-'));
  try {
    const model = path.join(tmp, 'pieza' + ext);
    fs.writeFileSync(model, buf);
    const nombreProceso = q.proceso || c.procesoPorDefecto;
    const machine = P.resolve('machine', c.maquina);
    const proceso = P.resolve('process', nombreProceso);
    const filament = P.resolve('filament', c.filamentos[q.mat] || c.filamentos.PLA);
    if (q.soportes === 'si') proceso.enable_support = '1';
    else if (q.soportes === 'no') proceso.enable_support = '0';
    if (q.relleno > 0 && q.relleno <= 100) proceso.sparse_infill_density = q.relleno + '%';
    const fm = path.join(tmp, 'machine.json'), fp = path.join(tmp, 'process.json'), ff = path.join(tmp, 'filament.json');
    fs.writeFileSync(fm, JSON.stringify(machine));
    fs.writeFileSync(fp, JSON.stringify(proceso));
    fs.writeFileSync(ff, JSON.stringify(filament));
    const args = ['--slice', '0', '--arrange', '1'];
    if (q.orient) args.push('--orient', '1');
    args.push('--outputdir', tmp, '--load-settings', fm + ';' + fp, '--load-filaments', ff, model);
    const r = await run(c.orca, args, 5 * 60 * 1000);
    const gc = fs.readdirSync(tmp).find(f => /\.gcode$/i.test(f));
    if (!gc) {
      const e = new Error('Orca no pudo laminar la pieza. Puede que no entre en la cama (220 × 220 × 250 mm) o que el archivo esté dañado.');
      e.detalle = r.out.slice(-400);
      throw e;
    }
    const st = parseGcode(path.join(tmp, gc));
    if (!st) throw new Error('Orca laminó, pero no pude leer los gramos y el tiempo del gcode.');
    return Object.assign(st, { perfil: nombreProceso, filamento: c.filamentos[q.mat] || c.filamentos.PLA });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* queda en temp */ }
  }
}
let cola = Promise.resolve();
function laminar(buf, ext, q) {
  const p = cola.then(() => laminarReal(buf, ext, q));
  cola = p.catch(() => {});
  return p;
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

const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').toLowerCase();
    if (host !== 'localhost:' + PORT && host !== '127.0.0.1:' + PORT) { res.writeHead(403); return res.end('host no permitido'); }
    const origin = req.headers.origin;
    if (origin && origin !== 'http://localhost:' + PORT && origin !== 'http://127.0.0.1:' + PORT) { res.writeHead(403); return res.end('origen no permitido'); }
    const u = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
    }
    if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && u.pathname === '/api/estado') {
      const c = conf();
      let procesos = [];
      try { procesos = presetIndex(c).procesos(c.sufijoPerfiles); } catch (e) { /* sin lista */ }
      return json(res, 200, { orca: fs.existsSync(c.orca), maquina: c.maquina, procesos, procesoPorDefecto: c.procesoPorDefecto, filamentos: c.filamentos });
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

    if (req.method === 'POST' && u.pathname === '/api/laminar') {
      const ext = path.extname(u.searchParams.get('archivo') || '').toLowerCase();
      if (!EXT_OK.includes(ext)) return json(res, 400, { ok: false, error: 'Formato no soportado. Usá ' + EXT_OK.join(', ') });
      const buf = await body(req);
      if (!buf.length) return json(res, 400, { ok: false, error: 'Archivo vacío' });
      const q = {
        mat: u.searchParams.get('mat') || 'PLA',
        proceso: u.searchParams.get('proceso') || '',
        soportes: u.searchParams.get('soportes') || 'perfil',
        relleno: parseFloat(u.searchParams.get('relleno')) || 0,
        orient: u.searchParams.get('orient') === '1'
      };
      try {
        return json(res, 200, Object.assign({ ok: true }, await laminar(buf, ext, q)));
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
server.listen(PORT, '127.0.0.1', () => console.log('Calculadora 3D en http://localhost:' + PORT));
