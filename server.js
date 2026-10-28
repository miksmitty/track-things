const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3160;
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');   // one folder per project
const TRASH_DIR = path.join(DATA_DIR, 'trash');         // deleted projects are moved here, never erased

// Data model
// ----------
// data/projects/<project id>/ holds one project. Its id is the folder name (a slug of the name it was created
// with); its display name is config.title inside it. Every API call takes ?project=<id>; without it the first
// project is used. Data that predates projects (data/config.json, data/level*.csv, …) is moved into the first
// project folder on startup.
//
// Within a project: config.levels[0] is the main grid; levels[1], levels[2], … are nested sub-record grids.
// Every record at every level has an `id` primary key. A record at level N stores the `parent_id` of the
// level N-1 record it belongs to; that is the only join between levels. On disk each level is its own CSV:
// level1.csv, level2.csv, …  (id, parent_id, …columns).

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
const MAX_SNAPSHOTS = 30;

const newId = () => crypto.randomBytes(5).toString('hex');

// ---- projects: folders under data/projects ----
const safeProjectId = id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
const slugify = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
function projectPaths(id) {
  const dir = path.join(PROJECTS_DIR, id);
  return {
    id, dir,
    config: path.join(dir, 'config.json'),
    level: i => path.join(dir, `level${i + 1}.csv`),
    legacyMain: path.join(dir, 'main.csv'),   // files used before levels were introduced (one main grid + one sub grid)
    legacySub: path.join(dir, 'sub.csv'),
    minutes: path.join(dir, 'minutes'),       // one <record id>.html per record that has meeting minutes (rich text)
    snapshots: path.join(dir, 'snapshots'),   // automatic safety copies taken before an import or restore
  };
}
const projectIds = () => fs.existsSync(PROJECTS_DIR)
  ? fs.readdirSync(PROJECTS_DIR).filter(d => safeProjectId(d) && fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory())
  : [];
const projectExists = id => safeProjectId(id) && fs.existsSync(path.join(PROJECTS_DIR, id));
const readTitle = p => { try { return JSON.parse(fs.readFileSync(p.config, 'utf8')).title || p.id; } catch { return p.id; } };

// Move the single-project layout (data/config.json, data/level*.csv, data/minutes, …) into data/projects/<slug>/.
function migrateLegacyLayout() {
  if (fs.existsSync(PROJECTS_DIR)) return;
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const old = fs.readdirSync(DATA_DIR).filter(f => f === 'config.json' || /^level\d+\.csv$/.test(f) || f === 'main.csv' || f === 'sub.csv' || f.endsWith('.migrated') || f === 'minutes' || f === 'snapshots');
  if (!old.length) return;
  let title = 'Track Things';
  try { title = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')).title || title; } catch {}
  const dir = path.join(PROJECTS_DIR, slugify(title));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of old) fs.renameSync(path.join(DATA_DIR, f), path.join(dir, f));
  console.log(`moved existing data into ${path.relative(__dirname, dir)}/`);
}
function ensureProjects() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  migrateLegacyLayout();
  if (!projectIds().length) createProject('Track Things');
}
function listProjects() {
  ensureProjects();
  return projectIds().map(id => {
    const p = projectPaths(id);
    const st = fs.statSync(p.dir);
    return { id, name: readTitle(p), rows: readCsv(p.level(0)).length, created: (st.birthtime.getTime() ? st.birthtime : st.mtime).toISOString() };
  }).sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}
// A new project starts empty, with either the default columns or a copy of another project's configuration.
function createProject(name, templateId) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const base = slugify(name);
  let id = base, n = 2;
  while (fs.existsSync(path.join(PROJECTS_DIR, id))) id = `${base}-${n++}`;
  const p = projectPaths(id);
  fs.mkdirSync(p.dir, { recursive: true });
  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (templateId && projectExists(templateId)) { try { config = JSON.parse(fs.readFileSync(projectPaths(templateId).config, 'utf8')); } catch {} }
  config.title = String(name || '').trim() || 'Untitled project';
  saveState(p, { config, rows: [] });
  return id;
}
function renameProject(p, name) {
  const { config, rows } = loadState(p);
  config.title = String(name || '').trim() || config.title;
  return saveState(p, { config, rows });
}
// Deleting moves the folder to data/trash/<id>-<time>/ so a mistake can be undone by hand.
function deleteProject(p) {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.renameSync(p.dir, path.join(TRASH_DIR, `${p.id}-${stamp}`));
}

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
  if (!cfg.levels.length) cfg.levels = JSON.parse(JSON.stringify(DEFAULT_CONFIG.levels));
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

function loadState(p) {
  let config;
  try { config = normaliseConfig(JSON.parse(fs.readFileSync(p.config, 'utf8'))); }
  catch { return { project: p.id, config: normaliseConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG))), rows: [] }; }

  // Flat records per level, then stitch children onto parents by parent_id.
  const flat = config.levels.map((lvl, i) => {
    let recs = readCsv(p.level(i));
    if (!recs.length && !fs.existsSync(p.level(i))) recs = readCsv(i === 0 ? p.legacyMain : i === 1 ? p.legacySub : '');
    return recs.map(r => ({ ...typed(r, lvl.columns), parent_id: r.parent_id || '' }));
  });
  const minutes = loadMinutes(p);
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
  return { project: p.id, config, rows: attach(0, null) };
}

// ---- meeting minutes: rich text (HTML) kept out of the CSVs, one file per record ----
const minutesFile = (p, id) => path.join(p.minutes, id + '.html');
const safeId = id => /^[\w-]+$/.test(id);
function loadMinutes(p) {
  const out = new Map();
  if (!fs.existsSync(p.minutes)) return out;
  for (const f of fs.readdirSync(p.minutes)) {
    if (!f.endsWith('.html')) continue;
    const id = f.slice(0, -5);
    if (!safeId(id)) continue;
    const st = fs.statSync(path.join(p.minutes, f));
    out.set(id, { html: fs.readFileSync(path.join(p.minutes, f), 'utf8'), updated: st.mtime.toISOString() });
  }
  return out;
}
// Minimal server-side sanitising: no scripts, no inline event handlers, no javascript: links.
const cleanHtml = html => String(html)
  .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/\s(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
function saveMinutes(p, records) {
  fs.mkdirSync(p.minutes, { recursive: true });
  const existing = loadMinutes(p);
  const keep = new Set();
  for (const r of records) {
    if (!safeId(r.id)) continue;
    const html = r.minutes ? cleanHtml(r.minutes).trim() : '';
    const empty = !html || /^(<p>(<br\s*\/?>|\s|&nbsp;)*<\/p>|\s)*$/i.test(html);
    if (empty) continue;
    keep.add(r.id);
    const cur = existing.get(r.id);
    if (!cur || cur.html !== html) writeAtomic(minutesFile(p, r.id), html);   // untouched minutes keep their file time
  }
  for (const id of existing.keys()) if (!keep.has(id)) fs.unlinkSync(minutesFile(p, id));
}

function writeAtomic(file, text) {
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

function saveState(p, state) {
  const config = normaliseConfig(state.config);
  fs.mkdirSync(p.dir, { recursive: true });
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
  writeAtomic(p.config, JSON.stringify(config, null, 2));
  saveMinutes(p, flat.flat());
  config.levels.forEach((lvl, i) => {
    const header = i === 0 ? ['id'] : ['id', 'parent_id'];
    writeAtomic(p.level(i), toCsv([...header, ...lvl.columns.map(c => c.key)], flat[i]));
  });
  // Drop files for levels that no longer exist.
  for (let i = config.levels.length; fs.existsSync(p.level(i)); i++) fs.unlinkSync(p.level(i));
  // Legacy files are superseded by level files once we have written them; keep them aside, unread.
  for (const f of [p.legacyMain, p.legacySub]) if (fs.existsSync(f)) fs.renameSync(f, f + '.migrated');
  return loadState(p);
}

// ---- snapshots: whole-state JSON files written before anything bulk-replaces the data ----
const backupJson = p => JSON.stringify({ app: 'track-things', format: 1, exportedAt: new Date().toISOString(), ...loadState(p) }, null, 2);
const snapName = n => /^[\w.-]+\.json$/.test(n) && !n.includes('..');
function takeSnapshot(p, reason) {
  fs.mkdirSync(p.snapshots, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${stamp}-${(reason || 'manual').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
  writeAtomic(path.join(p.snapshots, name), backupJson(p));
  listSnapshots(p).slice(MAX_SNAPSHOTS).forEach(sn => fs.unlinkSync(path.join(p.snapshots, sn.name)));
  return name;
}
function listSnapshots(p) {
  if (!fs.existsSync(p.snapshots)) return [];
  return fs.readdirSync(p.snapshots).filter(snapName).map(name => {
    const st = fs.statSync(path.join(p.snapshots, name));
    return { name, size: st.size, time: st.mtime.toISOString() };
  }).sort((a, b) => b.name.localeCompare(a.name));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const sendJson = (res, obj, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
const fail = (res, code, msg) => { res.statusCode = code; res.end(msg); };
const readBody = req => new Promise((ok, no) => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => ok(b)); req.on('error', no); });

// ?project=<id> picks the project; no parameter means the first one. An unknown id is a 404, never a silent fallback.
function resolveProject(url, res) {
  const id = url.searchParams.get('project');
  if (!id) return projectPaths(listProjects()[0].id);
  if (!projectExists(id)) { fail(res, 404, 'no such project'); return null; }
  return projectPaths(id);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // ---- projects ----
    if (url.pathname === '/api/projects') {
      if (req.method === 'GET') return sendJson(res, listProjects());
      if (req.method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}');
        if (!b.name || !String(b.name).trim()) return fail(res, 400, 'name required');
        const id = createProject(b.name, b.template);
        return sendJson(res, listProjects().find(x => x.id === id), 201);
      }
    }
    const pm = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (pm) {
      const id = decodeURIComponent(pm[1]);
      if (!projectExists(id)) return fail(res, 404, 'no such project');
      const p = projectPaths(id);
      if (req.method === 'GET') return sendJson(res, listProjects().find(x => x.id === id));
      if (req.method === 'PATCH') {
        const b = JSON.parse(await readBody(req) || '{}');
        renameProject(p, b.name);
        return sendJson(res, listProjects().find(x => x.id === id));
      }
      if (req.method === 'DELETE') {
        if (projectIds().length <= 1) return fail(res, 400, 'cannot delete the only project');
        deleteProject(p);
        return sendJson(res, { ok: true });
      }
    }

    // ---- everything below is scoped to one project ----
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/data/')) return serveStatic(url, res);
    const p = resolveProject(url, res);
    if (!p) return;

    if (url.pathname === '/api/state') {
      if (req.method === 'GET') return sendJson(res, loadState(p));
      if (req.method === 'PUT') {
        const s = JSON.parse(await readBody(req));
        if (!s.config || !Array.isArray(s.rows)) return fail(res, 400, 'bad state');
        const snapshot = url.searchParams.get('snapshot');          // import/restore asks for a safety copy first
        const snapshotName = snapshot ? takeSnapshot(p, snapshot) : null;
        const saved = saveState(p, s);
        if (snapshotName) saved.snapshot = snapshotName;
        return sendJson(res, saved);
      }
    }
    if (url.pathname === '/api/backup') {
      const name = p.id + '-' + new Date().toISOString().slice(0, 10) + '.json';
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      return res.end(backupJson(p));
    }
    if (url.pathname === '/api/snapshots' && req.method === 'GET') return sendJson(res, listSnapshots(p));
    if (url.pathname === '/api/snapshots' && req.method === 'POST') return sendJson(res, { name: takeSnapshot(p, url.searchParams.get('reason') || 'manual') });
    const sm = url.pathname.match(/^\/api\/snapshots\/([^/]+)$/);
    if (sm) {
      const name = decodeURIComponent(sm[1]);
      const f = path.join(p.snapshots, name);
      if (!snapName(name) || !fs.existsSync(f)) return fail(res, 404, 'no such snapshot');
      if (req.method === 'DELETE') { fs.unlinkSync(f); return sendJson(res, { ok: true }); }
      res.setHeader('Content-Type', 'application/json');
      if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      return res.end(fs.readFileSync(f));
    }
    const m = url.pathname.match(/^\/data\/level(\d+)\.csv$/);
    if (m || url.pathname === '/data/main.csv') {
      const f = m ? p.level(Number(m[1]) - 1) : p.level(0);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.end(fs.existsSync(f) ? fs.readFileSync(f) : '');
    }
    fail(res, 404, 'not found');
  } catch (e) {
    fail(res, e instanceof SyntaxError ? 400 : 500, e.message);
  }
}).listen(PORT, () => { ensureProjects(); console.log(`track-things on http://localhost:${PORT}`); });

function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return fail(res, 403, '');
  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, 'not found');
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(buf);
  });
}
