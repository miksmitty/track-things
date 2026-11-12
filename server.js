const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3160;
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');   // one folder per project
const TRASH_DIR = path.join(DATA_DIR, 'trash');         // deleted projects and data sets are moved here, never erased

// Data model
// ----------
// A project holds people and one or more data sets:
//   data/projects/<project id>/project.json          { title, people, sets: [ids in display order] }
//   data/projects/<project id>/sets/<set id>/        config.json, level1.csv, level2.csv, …, snapshots/
// Ids are folder names (a slug of the name the thing was created with). Every API call takes
// ?project=<id>&set=<id>; a missing one means the first project / the project's first data set.
//
// Within a data set: config.levels[0] is the main grid; levels[1], levels[2], … are nested sub-record grids.
// Every record at every level has an `id` primary key. A record at level N stores the
// `parent_id` of the level N-1 record it belongs to; that is the only join between levels.
// On disk each level is its own CSV: level1.csv, level2.csv, …  (id, parent_id, …columns).
//
// A column of type 'lookup' ({ type: 'lookup', set: <set id>, multi? }) points at main-grid records of another
// data set in the same project. Its cells hold the target record's id ('3', or '3|7' when multi).

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

const safeId = id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(id || ''));
const slugify = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'untitled';
const uniqueIn = (dir, base) => { let id = base, n = 2; while (fs.existsSync(path.join(dir, id))) id = base + '-' + n++; return id; };
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const subdirs = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(d => safeId(d) && fs.statSync(path.join(dir, d)).isDirectory()) : [];
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const clone = o => JSON.parse(JSON.stringify(o));

const projectDir = pid => path.join(PROJECTS_DIR, pid);
const projectFile = pid => path.join(projectDir(pid), 'project.json');
const setsDir = pid => path.join(projectDir(pid), 'sets');
// Every file of one data set. `p` is passed to everything that reads or writes a data set.
function setPaths(pid, sid) {
  const dir = path.join(setsDir(pid), sid);
  return {
    project: pid, set: sid, dir,
    config: path.join(dir, 'config.json'),
    level: i => path.join(dir, 'level' + (i + 1) + '.csv'),
    legacyMain: path.join(dir, 'main.csv'),      // files used before levels were introduced (one main grid + one sub grid)
    legacySub: path.join(dir, 'sub.csv'),
    minutes: path.join(dir, 'minutes'),          // legacy: one <record id>.html per record, folded into a notes column on first start
    snapshots: path.join(dir, 'snapshots'),      // automatic safety copies taken before an import or restore
  };
}

// Record ids are plain integers, unique within a data set. The page allocates them; anything else is renumbered on save.
const isIntId = id => /^[1-9]\d*$/.test(String(id ?? ''));
const allIds = rows => (rows || []).flatMap(r => [r.id, ...allIds(r.children)]);

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
  const out = { id: rec.id || 'tmp-' + crypto.randomBytes(4).toString('hex') };   // ids are only (re)numbered on save, where parent links are nested and so survive
  for (const c of cols) {
    const v = rec[c.key] ?? '';
    out[c.key] = c.type === 'checkbox' ? v === 'true'
      : c.type === 'number' && v !== '' ? Number(v)
      : (c.type === 'choice' || c.type === 'lookup') && c.multi ? String(v).split('|').map(x => x.trim()).filter(Boolean)   // multi choice / lookup: 'a|b' on disk, array in memory
      : v;
  }
  return out;
}

// CSVs re-saved by Excel on Windows are often Windows-1252 rather than UTF-8 and may start with a byte order mark.
const utf8 = new TextDecoder('utf-8', { fatal: true });
const decodeCsv = buf => { let t; try { t = utf8.decode(buf); } catch { t = buf.toString('latin1'); } return t.replace(/^\ufeff/, ''); };
const readCsv = f => { try { return parseCsv(decodeCsv(fs.readFileSync(f))); } catch { return []; } };

// Accept either the new {levels:[…]} shape or the old {columns, subColumns, subTitle} shape.
function normaliseConfig(raw) {
  const cfg = { title: raw.title || 'Untitled', people: Array.isArray(raw.people) ? raw.people : [], levels: [] };   // people: avatar colour / initials per name used in owner-style columns
  if (Array.isArray(raw.levels) && raw.levels.length) {
    cfg.levels = raw.levels.map((l, i) => ({ title: l.title || (i ? `Level ${i + 1}` : 'Rows'), columns: Array.isArray(l.columns) ? l.columns : [], rules: Array.isArray(l.rules) ? l.rules : undefined }));
  } else {
    cfg.levels.push({ title: 'Rows', columns: raw.columns || [] });
    if (raw.subColumns && raw.subColumns.length) cfg.levels.push({ title: raw.subTitle || 'Items', columns: raw.subColumns });
  }
  if (!cfg.levels.length) cfg.levels = clone(DEFAULT_CONFIG.levels);
  // Presentation and rules are explicit settings. A level from an older config (no `rules` list yet) gets a one-off
  // conversion: its old name-based guesses, or its earlier deadline/done flags, become ordinary rules it can edit or delete.
  for (const lvl of cfg.levels) {
    const cols = lvl.columns;
    for (const c of cols) {
      const n = (c.key + ' ' + c.label).toLowerCase();
      if (c.type === 'text' && c.look === 'person') { c.type = 'person'; delete c.look; }   // person is a column type now
      if (c.type === 'text' && c.look === undefined) {
        if (/owner|assignee|person|who|lead|user/.test(n)) c.type = 'person';
        else c.look = /status|state|stage|priority|phase/.test(n) ? 'status' : 'plain';
      }
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

// ---- projects: title, shared people directory and the order of their data sets ----
function readProject(pid) {
  const j = readJson(projectFile(pid), {});
  const onDisk = subdirs(setsDir(pid));
  const order = (Array.isArray(j.sets) ? j.sets : []).filter(id => onDisk.includes(id));
  return { title: j.title || pid, people: Array.isArray(j.people) ? j.people : [], sets: [...order, ...onDisk.filter(id => !order.includes(id)).sort()] };
}
function writeProject(pid, proj) {
  fs.mkdirSync(projectDir(pid), { recursive: true });
  writeAtomic(projectFile(pid), JSON.stringify({ title: proj.title, people: proj.people || [], sets: proj.sets || [] }, null, 2));
}
const projectIds = () => subdirs(PROJECTS_DIR).filter(id => fs.existsSync(projectFile(id)));
const projectExists = id => safeId(id) && fs.existsSync(projectFile(id));
const setExists = (pid, sid) => safeId(sid) && fs.existsSync(path.join(setsDir(pid), sid));
const readSetConfig = p => normaliseConfig(readJson(p.config, null) || clone(DEFAULT_CONFIG));

function loadState(p) {
  const proj = readProject(p.project);
  const config = readSetConfig(p);
  config.people = proj.people;   // people belong to the project and are shared by its data sets

  // Flat records per level, then stitch children onto parents by parent_id.
  const flat = config.levels.map((lvl, i) => {
    let recs = readCsv(p.level(i));
    if (!recs.length && !fs.existsSync(p.level(i))) recs = readCsv(i === 0 ? p.legacyMain : i === 1 ? p.legacySub : '');
    return recs.map(r => ({ ...typed(r, lvl.columns), parent_id: r.parent_id || '' }));
  });
  const attach = (level, parentId) => {
    if (level >= flat.length) return undefined;
    return flat[level]
      .filter(r => level === 0 || r.parent_id === parentId)
      .map(({ parent_id, ...rec }) => {
        const kids = attach(level + 1, rec.id);
        return kids ? { ...rec, children: kids } : rec;
      });
  };
  return { project: p.project, set: p.set, projectName: proj.title, config, rows: attach(0, null) };
}

// ---- notes columns: rich text (HTML) stored in the CSV cell ----
// Minimal server-side sanitising: no scripts, no inline event handlers, no javascript: links.
const cleanHtml = html => String(html ?? '')
  .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/\s(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
const emptyHtml = html => !html || /^(<p>(<br\s*\/?>|\s|&nbsp;)*<\/p>|\s)*$/i.test(html);

// Legacy: notes used to live in a minutes/<id>.html file for every record. On first start after the change they
// move into a 'Notes' column on each level that had any, and the folder is set aside.
function migrateMinutes(p, state) {
  const MINUTES_DIR = p.minutes;
  if (!fs.existsSync(MINUTES_DIR)) return false;
  const files = new Map();
  for (const f of fs.readdirSync(MINUTES_DIR)) {
    if (!f.endsWith('.html') || !/^[\w-]+$/.test(f.slice(0, -5))) continue;
    const html = fs.readFileSync(path.join(MINUTES_DIR, f), 'utf8');
    if (!emptyHtml(html)) files.set(f.slice(0, -5), html);
  }
  const walk = (rows, level) => (rows || []).forEach(r => {
    if (files.has(String(r.id))) {
      const lvl = state.config.levels[level];
      let col = lvl.columns.find(c => c.type === 'notes');
      if (!col) { let key = 'notes'; while (lvl.columns.some(c => c.key === key)) key += '_'; col = { key, label: 'Notes', type: 'notes' }; lvl.columns.push(col); }
      r[col.key] = files.get(String(r.id));
    }
    walk(r.children, level + 1);
  });
  walk(state.rows, 0);
  const aside = MINUTES_DIR + '.migrated';
  if (fs.existsSync(aside)) fs.rmSync(aside, { recursive: true, force: true });
  fs.renameSync(MINUTES_DIR, aside);
  return true;
}

function writeAtomic(file, text) {
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

function saveState(p, state) {
  const config = normaliseConfig(state.config);
  fs.mkdirSync(p.dir, { recursive: true });
  // People are stored once, on the project; everything else in the config is this data set's own.
  const { people, ...setConfig } = config;
  const proj = readProject(p.project);
  if (Array.isArray(state.config.people) && JSON.stringify(people) !== JSON.stringify(proj.people)) writeProject(p.project, { ...proj, people });
  const flat = config.levels.map(() => []);
  const seen = new Set();
  let idCounter = allIds(state.rows).reduce((m, id) => isIntId(id) ? Math.max(m, Number(id)) : m, 0);
  const newId = () => String(++idCounter);
  const walk = (rows, level, parentId) => {
    if (level >= config.levels.length) return;
    for (const r of rows || []) {
      if (!isIntId(r.id) || seen.has(String(r.id))) r.id = newId();   // every record gets a unique integer primary key
      r.id = String(Number(r.id));
      seen.add(r.id);
      for (const c of config.levels[level].columns) if (c.type === 'notes') { const h = cleanHtml(r[c.key]).trim(); r[c.key] = emptyHtml(h) ? '' : h; }
      flat[level].push({ ...r, parent_id: parentId });
      walk(r.children, level + 1, r.id);
    }
  };
  walk(state.rows, 0, '');
  writeAtomic(p.config, JSON.stringify(setConfig, null, 2));
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

// ---- listings: what the sidebar shows, and what lookup columns pick from ----
// A record's label is its first text column (else its first plain column), falling back to '#<id>'.
function setSummary(pid, sid) {
  const p = setPaths(pid, sid);
  const config = readSetConfig(p);
  const cols = config.levels[0].columns;
  const labelCol = cols.find(c => c.type === 'text') || cols.find(c => !['notes', 'checkbox', 'lookup'].includes(c.type));
  const recs = readCsv(p.level(0));
  return {
    id: sid, name: config.title, record: config.levels[0].title, rows: recs.length,
    refs: [...new Set(config.levels.flatMap(l => l.columns).filter(c => c.type === 'lookup' && c.set).map(c => c.set))],   // data sets its lookup columns point at
    items: recs.map(r => ({ id: String(r.id), label: (labelCol && String(r[labelCol.key] || '').trim()) || '#' + r.id })),
  };
}
const listSets = pid => readProject(pid).sets.map(sid => setSummary(pid, sid));
function projectSummary(pid) {
  const proj = readProject(pid);
  const st = fs.statSync(projectDir(pid));
  return { id: pid, name: proj.title, sets: proj.sets.length, rows: proj.sets.reduce((n, sid) => n + readCsv(setPaths(pid, sid).level(0)).length, 0),
    created: (st.birthtime.getTime() ? st.birthtime : st.mtime).toISOString() };
}
const listProjects = () => projectIds().map(projectSummary).sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));

// A new data set starts empty, with the default columns or a copy of another data set's configuration.
function createSet(pid, name, template) {
  const proj = readProject(pid);
  fs.mkdirSync(setsDir(pid), { recursive: true });
  const sid = uniqueIn(setsDir(pid), slugify(name));
  const config = template && setExists(pid, template) ? readSetConfig(setPaths(pid, template)) : clone(DEFAULT_CONFIG);
  config.title = String(name || '').trim() || 'Untitled';
  writeProject(pid, { ...proj, sets: [...proj.sets, sid] });
  saveState(setPaths(pid, sid), { config: { title: config.title, levels: config.levels }, rows: [] });
  return sid;
}
function renameSet(p, name) {
  const config = { ...readSetConfig(p), title: String(name || '').trim() };
  if (!config.title) return;
  const { people, ...setConfig } = config;
  writeAtomic(p.config, JSON.stringify(setConfig, null, 2));
}
// A new project starts with one data set, or with empty copies of every data set of another project (and its people).
function createProject(name, template) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const pid = uniqueIn(PROJECTS_DIR, slugify(name));
  const title = String(name || '').trim() || 'Untitled project';
  if (template && projectExists(template)) {
    const src = readProject(template);
    writeProject(pid, { title, people: src.people, sets: [] });
    const map = new Map();   // template set id -> new set id, so lookups keep pointing at the matching copy
    src.sets.forEach(sid => map.set(sid, createSet(pid, readSetConfig(setPaths(template, sid)).title, null)));
    src.sets.forEach(sid => {
      const config = readSetConfig(setPaths(template, sid));
      config.levels.forEach(l => l.columns.forEach(c => { if (c.type === 'lookup' && map.has(c.set)) c.set = map.get(c.set); }));
      saveState(setPaths(pid, map.get(sid)), { config: { title: config.title, levels: config.levels }, rows: [] });
    });
  } else {
    writeProject(pid, { title, people: [], sets: [] });
    createSet(pid, 'Main', null);
  }
  return pid;
}
// Deleting moves the folder to data/trash/ so a mistake can be undone by hand.
function trash(dir, name) {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  fs.renameSync(dir, path.join(TRASH_DIR, name + '-' + stamp()));
}

// ---- layout migration, run once at startup ----
// 1. data/config.json + data/level*.csv (single tracker)      -> data/projects/<slug>/
// 2. data/projects/<id>/config.json (one data set per project) -> data/projects/<id>/project.json + sets/<slug>/
function migrateLayout() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const dataFile = f => f === 'config.json' || /^level\d+\.csv$/.test(f) || f === 'main.csv' || f === 'sub.csv' || f === 'minutes' || f === 'snapshots' || f.endsWith('.migrated');
  const flat = fs.readdirSync(DATA_DIR).filter(dataFile);
  if (flat.some(f => f === 'config.json' || f.endsWith('.csv'))) {
    const title = (readJson(path.join(DATA_DIR, 'config.json'), {}) || {}).title || 'Track Things';
    const dir = path.join(PROJECTS_DIR, uniqueIn(PROJECTS_DIR, slugify(title)));
    fs.mkdirSync(dir, { recursive: true });
    for (const f of flat) fs.renameSync(path.join(DATA_DIR, f), path.join(dir, f));
    console.log('moved existing data into ' + path.relative(DATA_DIR, dir) + '/');
  }
  for (const pid of subdirs(PROJECTS_DIR)) {
    if (fs.existsSync(projectFile(pid))) continue;
    const dir = projectDir(pid);
    const old = readJson(path.join(dir, 'config.json'), null) || {};
    const record = (Array.isArray(old.levels) && old.levels[0] && old.levels[0].title) || '';
    const name = record && record !== 'Rows' ? record : 'Main';
    const sid = slugify(name);
    const entries = fs.readdirSync(dir).filter(f => f !== 'sets');
    fs.mkdirSync(path.join(setsDir(pid), sid), { recursive: true });
    for (const f of entries) fs.renameSync(path.join(dir, f), path.join(setsDir(pid), sid, f));
    writeProject(pid, { title: old.title || pid, people: Array.isArray(old.people) ? old.people : [], sets: [sid] });
    const p = setPaths(pid, sid);
    if (fs.existsSync(p.config)) { const { people, ...rest } = old; writeAtomic(p.config, JSON.stringify({ ...rest, title: name }, null, 2)); }
    console.log('project ' + pid + ': data moved into the data set "' + name + '"');
  }
  if (!projectIds().length) createProject('Track Things');
  // Per data set: legacy minutes files become a notes column, and records saved before ids were integers are renumbered.
  for (const pid of projectIds()) for (const sid of readProject(pid).sets) {
    const p = setPaths(pid, sid);
    const st = loadState(p);
    const movedNotes = migrateMinutes(p, st);
    if (movedNotes || allIds(st.rows).some(id => !isIntId(id))) saveState(p, st);
  }
}

// ---- snapshots: whole-state JSON files written before anything bulk-replaces the data ----
const backupJson = p => JSON.stringify({ app: 'track-things', format: 1, exportedAt: new Date().toISOString(), ...loadState(p) }, null, 2);
const snapName = n => /^[\w.-]+\.json$/.test(n) && !n.includes('..');
function takeSnapshot(p, reason) {
  fs.mkdirSync(p.snapshots, { recursive: true });
  const name = stamp() + '-' + (reason || 'manual').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json';
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

try { fs.mkdirSync(DATA_DIR, { recursive: true }); migrateLayout(); } catch (e) { console.error('startup migration failed', e); }

const fail = (res, code, msg) => { res.statusCode = code; res.end(msg); };
const readBody = req => new Promise((ok, no) => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => ok(b)); req.on('error', no); });

// Which data set a request is about. An unknown id is a 404, never a silent fallback to some other data.
function resolveSet(url) {
  const pid = url.searchParams.get('project') || (listProjects()[0] || {}).id;
  if (!projectExists(pid)) return null;
  const sid = url.searchParams.get('set') || readProject(pid).sets[0];
  return setExists(pid, sid) ? setPaths(pid, sid) : null;
}

async function api(req, res, url, route) {
  // ---- projects ----
  if (route === '/api/projects' && req.method === 'GET') return sendJson(res, listProjects());
  if (route === '/api/projects' && req.method === 'POST') {
    const b = JSON.parse(await readBody(req) || '{}');
    if (!String(b.name || '').trim()) return fail(res, 400, 'name required');
    return sendJson(res, projectSummary(createProject(b.name, b.template)), 201);
  }
  const pm = route.match(/^\/api\/projects\/([^/]+)$/);
  if (pm) {
    const pid = decodeURIComponent(pm[1]);
    if (!projectExists(pid)) return fail(res, 404, 'no such project');
    if (req.method === 'PATCH') {
      const b = JSON.parse(await readBody(req) || '{}');
      if (String(b.name || '').trim()) writeProject(pid, { ...readProject(pid), title: String(b.name).trim() });
      return sendJson(res, projectSummary(pid));
    }
    if (req.method === 'DELETE') {
      if (projectIds().length <= 1) return fail(res, 400, 'cannot delete the only project');
      trash(projectDir(pid), pid);
      return sendJson(res, { ok: true });
    }
    return sendJson(res, projectSummary(pid));
  }

  // ---- data sets of one project ----
  if (route === '/api/sets' || route.startsWith('/api/sets/')) {
    const pid = url.searchParams.get('project') || (listProjects()[0] || {}).id;
    if (!projectExists(pid)) return fail(res, 404, 'no such project');
    if (route === '/api/sets' && req.method === 'GET') return sendJson(res, listSets(pid));
    if (route === '/api/sets' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      if (!String(b.name || '').trim()) return fail(res, 400, 'name required');
      return sendJson(res, setSummary(pid, createSet(pid, b.name, b.template)), 201);
    }
    const sid = decodeURIComponent(route.slice('/api/sets/'.length));
    if (!setExists(pid, sid)) return fail(res, 404, 'no such data set');
    if (req.method === 'PATCH') {
      const b = JSON.parse(await readBody(req) || '{}');
      renameSet(setPaths(pid, sid), b.name);
      return sendJson(res, setSummary(pid, sid));
    }
    if (req.method === 'DELETE') {
      const proj = readProject(pid);
      if (proj.sets.length <= 1) return fail(res, 400, 'cannot delete the only data set');
      trash(path.join(setsDir(pid), sid), pid + '--' + sid);
      writeProject(pid, { ...proj, sets: proj.sets.filter(x => x !== sid) });
      return sendJson(res, { ok: true });
    }
    return sendJson(res, setSummary(pid, sid));
  }

  // ---- everything below is about one data set ----
  const p = resolveSet(url);
  if (!p) return fail(res, 404, 'no such project or data set');
  if (route === '/api/state') {
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
  if (route === '/api/backup') {
    const name = p.project + '-' + p.set + '-' + new Date().toISOString().slice(0, 10) + '.json';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return res.end(backupJson(p));
  }
  if (route === '/api/snapshots' && req.method === 'GET') return sendJson(res, listSnapshots(p));
  if (route === '/api/snapshots' && req.method === 'POST') return sendJson(res, { name: takeSnapshot(p, url.searchParams.get('reason') || 'manual') });
  const sm = route.match(/^\/api\/snapshots\/([^/]+)$/);
  if (sm) {
    const name = decodeURIComponent(sm[1]);
    const f = path.join(p.snapshots, name);
    if (!snapName(name) || !fs.existsSync(f)) return fail(res, 404, 'no such snapshot');
    if (req.method === 'DELETE') { fs.unlinkSync(f); return sendJson(res, { ok: true }); }
    res.setHeader('Content-Type', 'application/json');
    if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return res.end(fs.readFileSync(f));
  }
  const m = route.match(/^\/data\/level(\d+)\.csv$/);
  if (m || route === '/data/main.csv') {
    const f = m ? p.level(Number(m[1]) - 1) : p.level(0);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.end(fs.existsSync(f) ? fs.readFileSync(f) : '');
  }
  fail(res, 404, 'not found');
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Behind a proxy the app may be served under a path prefix (e.g. /proxy/3160/) that isn't stripped:
  // API and data routes are matched from their own segment on, and static files fall back to their name alone.
  const at = url.pathname.search(/\/(api|data)\//);
  if (at >= 0) return void api(req, res, url, url.pathname.slice(at)).catch(e => fail(res, e instanceof SyntaxError ? 400 : 500, e.message));
  let p; try { p = decodeURIComponent(url.pathname); } catch { p = '/'; }
  // A prefix without a trailing slash (/proxy/3160) would make the page's relative links resolve one level up.
  if (!p.endsWith('/') && !path.extname(p)) { res.statusCode = 302; res.setHeader('Location', p + '/' + url.search); return res.end(); }
  const file = path.join(PUBLIC, p.endsWith('/') ? p + 'index.html' : p);
  const byName = path.join(PUBLIC, path.basename(file));
  if (!file.startsWith(PUBLIC + path.sep)) { res.statusCode = 403; return res.end(); }
  const send = (err, buf, f) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(buf);
  };
  fs.readFile(file, (err, buf) => err ? fs.readFile(byName, (e2, b2) => send(e2, b2, byName)) : send(err, buf, file));
})
  .on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Stop whatever is using it, or run with PORT=<other> node server.js`);
    else if (e.code === 'EACCES') console.error(`Not allowed to listen on port ${PORT}. Try PORT=<other> node server.js`);
    else console.error('Could not start:', e.message);
    process.exit(1);
  })
  .listen(PORT, () => console.log(`track-things on http://localhost:${PORT}`));
