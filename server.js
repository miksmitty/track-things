const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3160;
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

// Data model
// ----------
// config.levels[0] is the main grid; levels[1], levels[2], … are nested sub-record grids.
// Every record at every level has an `id` primary key. A record at level N stores the
// `parent_id` of the level N-1 record it belongs to; that is the only join between levels.
// On disk each level is its own CSV: data/level1.csv, data/level2.csv, …  (id, parent_id, …columns).

const DEFAULT_CONFIG = {
  title: 'Track Things',
  levels: [
    {
      title: 'Rows',
      columns: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'status', label: 'Status', type: 'text' },
        { key: 'owner', label: 'Owner', type: 'text' },
        { key: 'due', label: 'Due', type: 'date' },
        { key: 'done', label: 'Done', type: 'checkbox' },
      ],
    },
    {
      title: 'Items',
      columns: [
        { key: 'item', label: 'Item', type: 'text' },
        { key: 'qty', label: 'Qty', type: 'number' },
        { key: 'done', label: 'Done', type: 'checkbox' },
      ],
    },
  ],
};

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const levelFile = i => path.join(DATA_DIR, `level${i + 1}.csv`);
// Files used before levels were introduced (one main grid + one sub grid).
const LEGACY_MAIN = path.join(DATA_DIR, 'main.csv');
const LEGACY_SUB = path.join(DATA_DIR, 'sub.csv');
const MINUTES_DIR = path.join(DATA_DIR, 'minutes');  // one <record id>.html per record that has meeting minutes (rich text)
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');   // automatic safety copies taken before an import or restore
const MAX_SNAPSHOTS = 30;

const newId = () => crypto.randomBytes(5).toString('hex');

function toCsv(header, records) {
  const esc = v => {
    const s = v === undefined || v === null ? '' : Array.isArray(v) ? v.join('|') : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...records.map(r => header.map(h => r[h]))].map(l => l.map(esc).join(',')).join('\n') + '\n';
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows.filter(r => r.length > 1 || r[0] !== '');
  return body.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function typed(rec, cols) {
  const out = { id: rec.id || newId() };
  for (const c of cols) {
    const v = rec[c.key] ?? '';
    out[c.key] = c.type === 'checkbox' ? v === 'true'
      : c.type === 'number' && v !== '' ? Number(v)
      : c.type === 'choice' && c.multi ? String(v).split('|').map(x => x.trim()).filter(Boolean)   // multi-choice: 'a|b' on disk, array in memory
      : v;
  }
  return out;
}

const readCsv = f => { try { return parseCsv(fs.readFileSync(f, 'utf8')); } catch { return []; } };

// Accept either the new {levels:[…]} shape or the old {columns, subColumns, subTitle} shape.
function normaliseConfig(raw) {
  const cfg = { title: raw.title || 'Track Things', people: Array.isArray(raw.people) ? raw.people : [], levels: [] };   // people: avatar colour / initials per name used in owner-style columns
  if (Array.isArray(raw.levels) && raw.levels.length) {
    cfg.levels = raw.levels.map((l, i) => ({ title: l.title || (i ? `Level ${i + 1}` : 'Rows'), columns: Array.isArray(l.columns) ? l.columns : [], rules: Array.isArray(l.rules) ? l.rules : undefined }));
  } else {
    cfg.levels.push({ title: 'Rows', columns: raw.columns || [] });
    if (raw.subColumns && raw.subColumns.length) cfg.levels.push({ title: raw.subTitle || 'Items', columns: raw.subColumns });
  }
  if (!cfg.levels.length) cfg.levels = DEFAULT_CONFIG.levels;
  // Presentation and rules are explicit settings. A level from an older config (no `rules` list yet) gets a one-off
  // conversion: its old name-based guesses, or its earlier deadline/done flags, become ordinary rules it can edit or delete.
  for (const lvl of cfg.levels) {
    const cols = lvl.columns;
    for (const c of cols) {
      const n = (c.key + ' ' + c.label).toLowerCase();
      if (c.type === 'text' && c.look === undefined) c.look = /status|state|stage|priority|phase/.test(n) ? 'status' : /owner|assignee|person|who|lead|user/.test(n) ? 'person' : 'plain';
    }
    if (!Array.isArray(lvl.rules)) {
      lvl.rules = [];
      let doneCol = cols.find(c => c.type === 'checkbox' && c.done === true);
      if (!doneCol && !cols.some(c => c.done !== undefined)) doneCol = cols.find(c => c.type === 'checkbox' && /done|complete|finished/.test((c.key + ' ' + c.label).toLowerCase()));
      if (doneCol) lvl.rules.push({ name: 'Done', when: [{ col: doneCol.key, op: 'checked' }], effect: { apply: 'row', tone: '', label: '', done: true } });
      for (const c of cols) {
        if (c.type !== 'date') continue;
        const flagged = c.deadline !== undefined ? c.deadline : /due|deadline|target|expir|end/.test((c.key + ' ' + c.label).toLowerCase());
        if (!flagged) continue;
        const unless = c.doneBy !== undefined ? c.doneBy : (doneCol ? doneCol.key : '');
        const guard = unless && cols.some(x => x.key === unless) ? [{ col: unless, op: 'unchecked' }] : [];
        lvl.rules.push({ name: c.label + ' overdue', when: [{ col: c.key, op: 'past' }, ...guard], effect: { apply: c.key, tone: 'red', label: 'OVERDUE', done: false } });
        lvl.rules.push({ name: c.label + ' soon', when: [{ col: c.key, op: 'within', value: '3' }, ...guard], effect: { apply: c.key, tone: 'amber', label: 'SOON', done: false } });
      }
    }
    for (const c of cols) { delete c.deadline; delete c.doneBy; delete c.done; }   // superseded by rules
  }
  return cfg;
}

function loadState() {
  let config;
  try { config = normaliseConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
  catch { return { config: normaliseConfig(DEFAULT_CONFIG), rows: [] }; }

  // Flat records per level, then stitch children onto parents by parent_id.
  const flat = config.levels.map((lvl, i) => {
    let recs = readCsv(levelFile(i));
    if (!recs.length && !fs.existsSync(levelFile(i))) recs = readCsv(i === 0 ? LEGACY_MAIN : i === 1 ? LEGACY_SUB : '');
    return recs.map(r => ({ ...typed(r, lvl.columns), parent_id: r.parent_id || '' }));
  });
  const minutes = loadMinutes();
  const attach = (level, parentId) => {
    if (level >= flat.length) return undefined;
    return flat[level]
      .filter(r => level === 0 || r.parent_id === parentId)
      .map(({ parent_id, ...rec }) => {
        const m = minutes.get(rec.id);
        if (m) { rec.minutes = m.html; rec.minutesUpdated = m.updated; }
        const kids = attach(level + 1, rec.id);
        return kids ? { ...rec, children: kids } : rec;
      });
  };
  return { config, rows: attach(0, null) };
}

// ---- meeting minutes: rich text (HTML) kept out of the CSVs, one file per record ----
const minutesFile = id => path.join(MINUTES_DIR, id + '.html');
const safeId = id => /^[\w-]+$/.test(id);
function loadMinutes() {
  const out = new Map();
  if (!fs.existsSync(MINUTES_DIR)) return out;
  for (const f of fs.readdirSync(MINUTES_DIR)) {
    if (!f.endsWith('.html')) continue;
    const id = f.slice(0, -5);
    if (!safeId(id)) continue;
    const st = fs.statSync(path.join(MINUTES_DIR, f));
    out.set(id, { html: fs.readFileSync(path.join(MINUTES_DIR, f), 'utf8'), updated: st.mtime.toISOString() });
  }
  return out;
}
// Minimal server-side sanitising: no scripts, no inline event handlers, no javascript: links.
const cleanHtml = html => String(html)
  .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/\s(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
function saveMinutes(records) {
  fs.mkdirSync(MINUTES_DIR, { recursive: true });
  const existing = loadMinutes();
  const keep = new Set();
  for (const r of records) {
    if (!safeId(r.id)) continue;
    const html = r.minutes ? cleanHtml(r.minutes).trim() : '';
    const empty = !html || /^(<p>(<br\s*\/?>|\s|&nbsp;)*<\/p>|\s)*$/i.test(html);
    if (empty) continue;
    keep.add(r.id);
    const cur = existing.get(r.id);
    if (!cur || cur.html !== html) writeAtomic(minutesFile(r.id), html);   // untouched minutes keep their file time
  }
  for (const id of existing.keys()) if (!keep.has(id)) fs.unlinkSync(minutesFile(id));
}

function writeAtomic(file, text) {
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

function saveState(state) {
  const config = normaliseConfig(state.config);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const flat = config.levels.map(() => []);
  const seen = new Set();
  const walk = (rows, level, parentId) => {
    if (level >= config.levels.length) return;
    for (const r of rows || []) {
      if (!r.id || seen.has(r.id)) r.id = newId();   // every record gets a unique primary key
      seen.add(r.id);
      flat[level].push({ ...r, parent_id: parentId });
      walk(r.children, level + 1, r.id);
    }
  };
  walk(state.rows, 0, '');
  writeAtomic(CONFIG_FILE, JSON.stringify(config, null, 2));
  saveMinutes(flat.flat());
  config.levels.forEach((lvl, i) => {
    const header = i === 0 ? ['id'] : ['id', 'parent_id'];
    writeAtomic(levelFile(i), toCsv([...header, ...lvl.columns.map(c => c.key)], flat[i]));
  });
  // Drop files for levels that no longer exist.
  for (let i = config.levels.length; fs.existsSync(levelFile(i)); i++) fs.unlinkSync(levelFile(i));
  // Legacy files are superseded by level files once we have written them; keep them aside, unread.
  for (const f of [LEGACY_MAIN, LEGACY_SUB]) if (fs.existsSync(f)) fs.renameSync(f, f + '.migrated');
  return loadState();
}

// ---- snapshots: whole-state JSON files written before anything bulk-replaces the data ----
const backupJson = () => JSON.stringify({ app: 'track-things', format: 1, exportedAt: new Date().toISOString(), ...loadState() }, null, 2);
const snapName = n => /^[\w.-]+\.json$/.test(n) && !n.includes('..');
function takeSnapshot(reason) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${stamp}-${(reason || 'manual').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
  writeAtomic(path.join(SNAP_DIR, name), backupJson());
  listSnapshots().slice(MAX_SNAPSHOTS).forEach(sn => fs.unlinkSync(path.join(SNAP_DIR, sn.name)));
  return name;
}
function listSnapshots() {
  if (!fs.existsSync(SNAP_DIR)) return [];
  return fs.readdirSync(SNAP_DIR).filter(snapName).map(name => {
    const st = fs.statSync(path.join(SNAP_DIR, name));
    return { name, size: st.size, time: st.mtime.toISOString() };
  }).sort((a, b) => b.name.localeCompare(a.name));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const sendJson = (res, obj, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state') {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(loadState()));
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        try {
          const s = JSON.parse(body);
          if (!s.config || !Array.isArray(s.rows)) throw new Error('bad state');
          const snapshot = url.searchParams.get('snapshot');          // import/restore asks for a safety copy first
          const snapshotName = snapshot ? takeSnapshot(snapshot) : null;
          const saved = saveState(s);
          if (snapshotName) saved.snapshot = snapshotName;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(saved));
        } catch (e) {
          res.statusCode = 400;
          res.end(e.message);
        }
      });
      return;
    }
  }
  if (url.pathname === '/api/backup') {
    const name = 'track-things-' + new Date().toISOString().slice(0, 10) + '.json';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return res.end(backupJson());
  }
  if (url.pathname === '/api/snapshots' && req.method === 'GET') return sendJson(res, listSnapshots());
  if (url.pathname === '/api/snapshots' && req.method === 'POST') return sendJson(res, { name: takeSnapshot(url.searchParams.get('reason') || 'manual') });
  const sm = url.pathname.match(/^\/api\/snapshots\/([^/]+)$/);
  if (sm) {
    const name = decodeURIComponent(sm[1]);
    const f = path.join(SNAP_DIR, name);
    if (!snapName(name) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('no such snapshot'); }
    if (req.method === 'DELETE') { fs.unlinkSync(f); return sendJson(res, { ok: true }); }
    res.setHeader('Content-Type', 'application/json');
    if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return res.end(fs.readFileSync(f));
  }
  const m = url.pathname.match(/^\/data\/level(\d+)\.csv$/);
  if (m || url.pathname === '/data/main.csv') {
    const f = m ? levelFile(Number(m[1]) - 1) : levelFile(0);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.end(fs.existsSync(f) ? fs.readFileSync(f) : '');
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(buf);
  });
}).listen(PORT, () => console.log(`track-things on http://localhost:${PORT}`));
