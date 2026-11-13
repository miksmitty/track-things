// Shared by every page: which project and data set are open, their lists in the sidebar, and creating / deleting them.
// The open pair comes from ?project=<id>&set=<id> in the URL, else the last ones used in this browser, else the
// first the server lists. Pages wait on TT.ready, then scope every request with TT.api(path).
// Loaded at the end of <body>, after shell.js (ask / toast) and before the page's own script.
(() => {
  const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); kids.forEach(k => e.append(k)); return e; };
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const enc = encodeURIComponent;
  const here = new URL(location.href);

  let project = here.searchParams.get('project') || store.get('tt-project') || '';
  let set = here.searchParams.get('set') || '';
  let projects = [], sets = [];

  // Every URL is relative, so the app keeps working behind a proxy that serves it under a path prefix.
  const withQuery = (path, q) => path + (path.includes('?') ? '&' : '?') + q;
  const projectApi = path => withQuery(path, 'project=' + enc(project));
  const api = path => withQuery(path, 'project=' + enc(project) + '&set=' + enc(set));
  const page = () => /import-export\.html$/.test(location.pathname) ? 'import-export.html' : './';
  // Link to a page for a project / data set. Another project without a set opens the one last used there.
  const href = (pg, o = {}) => {
    const p = o.project || project;
    const s = o.set || (p === project ? set : '');
    return pg + '?project=' + enc(p) + (s ? '&set=' + enc(s) : '') + (o.hash || '');
  };

  // ---- sidebar ----
  // Top to bottom it reads as the hierarchy: the project (a switcher), its data sets, and under the open data set
  // the things you can do with it (the page's own Configure and Import / Export links, in #navTools).
  const nav = document.querySelector('nav');
  const tools = document.getElementById('navTools');
  const setList = h('div', { className: 'navlist' });
  const svg = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = '<path d="' + d + '"/>'; return s; };
  const FOLDER = 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z';
  const TABLE = 'M4 5h16v14H4zM4 10h16M10 10v9';
  const PLUS = 'M12 5v14M5 12h14';
  const CHEVRON = 'M8 10l4 4 4-4';
  const switchName = h('span', { className: 'pname' });
  const switcher = h('button', { type: 'button', className: 'projswitch', title: 'Switch project', onclick: () => (menu ? closeMenu() : openMenu()) }, svg(FOLDER), switchName, svg(CHEVRON));
  switcher.lastChild.classList.add('chev');
  if (nav) {
    const parts = [
      h('div', { className: 'navlabel', textContent: 'Project' }), switcher,
      h('div', { className: 'navlabel', textContent: 'Data sets' }), setList,
      h('button', { type: 'button', className: 'navitem add', onclick: () => newSet() }, svg(PLUS), 'New data set'),
    ];
    const before = tools || nav.querySelector('.spacer');
    before ? before.before(...parts) : nav.append(...parts);
    nav.querySelectorAll('a[href]').forEach(a => (a.dataset.base = a.getAttribute('href')));   // the page's own links, as written
  }

  // Project switcher menu: every project, then "New project".
  let menu = null;
  const closeMenu = () => { if (menu) menu.remove(); menu = null; switcher.classList.remove('on'); };
  function openMenu() {
    menu = h('div', { className: 'popmenu' });
    projects.forEach(p => {
      const a = h('a', { className: 'navitem' + (p.id === project ? ' active' : ''), href: href('./', { project: p.id }) }, svg(FOLDER),
        h('span', { className: 'pname', textContent: p.name }), h('small', { textContent: p.sets + (p.sets === 1 ? ' data set' : ' data sets') }));
      menu.append(a);
    });
    menu.append(h('hr'), h('button', { type: 'button', className: 'navitem add', onclick: () => { closeMenu(); newProject(); } }, svg(PLUS), 'New project'));
    document.body.append(menu);
    const r = switcher.getBoundingClientRect();
    menu.style.left = r.left + 'px'; menu.style.top = r.bottom + 6 + 'px'; menu.style.minWidth = r.width + 'px';
    switcher.classList.add('on');
  }
  document.addEventListener('mousedown', e => { if (menu && !menu.contains(e.target) && !switcher.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  function render() {
    const cur = projects.find(p => p.id === project);
    switchName.textContent = cur ? cur.name : 'No project';
    const onGrid = page() === './';
    // The open data set is the grid itself, so there is no separate "Grid" link: its row is the way back to it.
    setList.replaceChildren(...sets.map(s => {
      const a = h('a', { className: 'navitem entry' + (s.id === set ? (onGrid ? ' active' : ' open') : ''), href: href('./', { set: s.id }) },
        svg(TABLE), h('span', { className: 'pname', textContent: s.name }), h('span', { className: 'pcount', textContent: s.rows }));
      a.dataset.set = s.id;
      return a;
    }));
    const open = setList.querySelector('[data-set="' + set + '"]');
    if (tools && open) open.after(tools);
    // The page's own links keep the open project and data set.
    if (nav) nav.querySelectorAll('a[data-base]').forEach(a => {
      const [path, hash] = a.dataset.base.split('#');
      a.href = href(path.split('?')[0], { hash: hash ? '#' + hash : '' });
    });
  }

  async function load() {
    projects = await fetch('api/projects').then(r => r.json());
    if (!projects.some(p => p.id === project)) { project = projects[0] ? projects[0].id : ''; set = ''; }
    sets = await fetch(projectApi('api/sets')).then(r => r.json());
    sets.forEach(s => (s.byId = new Map(s.items.map(i => [i.id, i]))));   // record id -> record, for lookup columns
    if (!sets.some(s => s.id === set)) {
      const last = store.get('tt-set-' + project);
      set = sets.some(s => s.id === last) ? last : sets[0] ? sets[0].id : '';
    }
    store.set('tt-project', project); store.set('tt-set-' + project, set);
    const url = new URL(location.href);
    if (url.searchParams.get('project') !== project || url.searchParams.get('set') !== set) {
      url.searchParams.set('project', project); url.searchParams.set('set', set);
      history.replaceState(null, '', url);
    }
    render();
  }
  const ready = load();
  // Re-read both lists (row counts, names, lookup labels) without changing what is open.
  const refresh = () => load().catch(() => {});

  // ---- CSV: read a file, guess each column's type, and let the user choose which columns to use ----
  // Used to create a data set from a file (New data set) and to add columns to one (Configure).
  function parseCsv(text) {
    text = String(text).replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0];
    const delim = [',', ';', '\t', '|'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') q = false;
        else field += c;
      } else if (c === '"' && field === '') q = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = ''; rows.push(row); row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const body = rows.filter(r => r.some(v => v.trim() !== ''));
    const header = (body.shift() || []).map((v, i) => v.trim() || 'Column ' + (i + 1));
    return { header, rows: body };
  }
  const YES = new Set(['yes', 'y', 'true']), NO = new Set(['no', 'n', 'false']);
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad = n => String(n).padStart(2, '0');
  const validDate = (y, m, d) => { const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? y + '-' + pad(m) + '-' + pad(d) : ''; };
  // Text to ISO yyyy-mm-dd, or '' when it is not a date. `mdy` reads 3/4/2026 as March 4th rather than 3 April.
  function toIso(v, mdy) {
    const t = String(v).trim();
    let m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t))) return validDate(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(t))) { const y = m[3].length <= 2 ? 2000 + +m[3] : +m[3]; return mdy ? validDate(y, +m[1], +m[2]) : validDate(y, +m[2], +m[1]); }
    if ((m = /^(\d{1,2})[\s-]([a-z]{3})[a-z]*\.?[\s-](\d{2,4})$/i.exec(t))) { const mi = MONTHS.indexOf(m[2].toLowerCase()); const y = m[3].length <= 2 ? 2000 + +m[3] : +m[3]; return mi < 0 ? '' : validDate(y, mi + 1, +m[1]); }
    return '';
  }
  const isNumber = v => /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(v) && !/^-?0\d/.test(v);   // 007 or 01234 is a code, not a number
  function guessType(values) {
    const filled = values.map(v => v.trim()).filter(Boolean);
    if (!filled.length) return { type: 'text' };
    if (filled.every(v => YES.has(v.toLowerCase()) || NO.has(v.toLowerCase()))) return { type: 'checkbox' };
    if (filled.every(isNumber)) return { type: 'number' };
    const slashed = filled.map(v => /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-]\d{2,4}$/.exec(v)).filter(Boolean);
    const mdy = slashed.some(m => +m[2] > 12) && !slashed.some(m => +m[1] > 12);
    if (filled.every(v => toIso(v, mdy))) return { type: 'date', mdy };
    const distinct = [...new Set(filled)];
    if (filled.length >= 4 && distinct.length <= 10 && distinct.length <= filled.length / 2 && distinct.every(v => v.length <= 30)) return { type: 'choice', options: distinct };
    return { type: 'text' };
  }
  const convert = (v, col) => {
    const t = String(v ?? '').trim();
    if (col.type === 'checkbox') return YES.has(t.toLowerCase());
    if (col.type === 'number') { const n = Number(t.replace(/,/g, '')); return t !== '' && isFinite(n) ? n : ''; }
    if (col.type === 'date') return toIso(t, col.mdy);
    return t;
  };
  const RESERVED = new Set(['id', 'parent_id', 'children']);
  const PICK_TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['checkbox', 'Yes / no'], ['choice', 'Choice'], ['person', 'Person']];

  // The picker: a file chooser, then one line per column of the file with a tick, an editable name, a type and samples.
  // build(usedKeys) gives the ticked columns as ready-to-save column configs plus the file's rows converted to match.
  function csvPicker(onChange = () => {}) {
    let file = null, cols = [];
    const input = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv', hidden: true });
    const choose = h('button', { type: 'button', textContent: 'Choose a CSV file…', onclick: () => input.click() });
    const info = h('span', { className: 'csvinfo', textContent: 'Comma, semicolon or tab separated, with column names in the first row.' });
    const table = h('div', { className: 'csvcols' });
    const el = h('div', { className: 'csvpick' }, h('div', { className: 'csvfile' }, choose, info, input), table);
    const draw = () => {
      table.replaceChildren();
      if (!file) return;
      const all = h('input', { type: 'checkbox', checked: cols.every(c => c.on), title: 'Tick or untick every column' });
      all.indeterminate = !all.checked && cols.some(c => c.on);
      all.onchange = () => { cols.forEach(c => (c.on = all.checked)); draw(); onChange(); };
      table.append(h('div', { className: 'csvrow head' }, all, h('span', { textContent: 'Column' }), h('span', { textContent: 'Type' }), h('span', { textContent: 'Values in the file' })));
      cols.forEach(c => {
        const on = h('input', { type: 'checkbox', checked: c.on });
        on.onchange = () => { c.on = on.checked; draw(); onChange(); };
        const name = h('input', { type: 'text', value: c.label, placeholder: 'Column name' });
        name.oninput = () => { c.label = name.value; onChange(); };
        const type = h('select');
        PICK_TYPES.forEach(([v, t]) => type.append(h('option', { value: v, textContent: t, selected: v === c.type })));
        type.onchange = () => { c.type = type.value; if (c.type === 'choice' && !c.options) c.options = [...new Set(c.values.map(v => v.trim()).filter(Boolean))].slice(0, 50); };
        table.append(h('div', { className: 'csvrow' + (c.on ? '' : ' off') }, on, name, type, h('span', { className: 'sample', textContent: c.sample })));
      });
    };
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      const parsed = parseCsv(await f.text());
      if (!parsed.header.length) { window.toast('That file has no columns.', true); return; }
      file = { name: f.name, rows: parsed.rows };
      cols = parsed.header.map((label, i) => {
        const values = parsed.rows.map(r => r[i] ?? '');
        const distinct = [...new Set(values.map(v => v.trim()).filter(Boolean))];
        return { i, label, on: true, values, ...guessType(values), sample: distinct.slice(0, 3).join(', ') + (distinct.length > 3 ? ', …' : '') || '(empty)' };
      });
      choose.textContent = 'Choose another file…';
      info.textContent = f.name + ' · ' + cols.length + (cols.length === 1 ? ' column' : ' columns') + ' · ' + file.rows.length + (file.rows.length === 1 ? ' row' : ' rows');
      draw(); onChange();
    };
    return {
      el,
      get loaded() { return !!file; },
      get fileName() { return file ? file.name : ''; },
      get rowCount() { return file ? file.rows.length : 0; },
      get picked() { return cols.filter(c => c.on && c.label.trim()).length; },
      build(usedKeys = []) {
        const used = new Set(usedKeys);
        const chosen = cols.filter(c => c.on && c.label.trim()).map(c => {
          let key = c.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'col';
          while (RESERVED.has(key) || used.has(key)) key += '_';
          used.add(key);
          const col = { key, label: c.label.trim(), type: c.type };
          if (c.type === 'text') col.look = 'plain';
          if (c.type === 'choice') col.options = (c.options || []).slice();
          return { col, src: c };
        });
        return {
          columns: chosen.map(x => x.col),
          rows: file.rows.map((r, n) => Object.fromEntries([['id', String(n + 1)], ...chosen.map(x => [x.col.key, convert(r[x.src.i], x.src)])])),
        };
      },
    };
  }
  const closeBtn = d => h('button', { type: 'button', className: 'dlgx', title: 'Close', textContent: '×', onclick: () => d.close() });
  // Configure → "Add columns from a CSV file": resolves the ticked columns (no rows), or null when cancelled.
  function pickCsvColumns(usedKeys = []) {
    return new Promise(resolve => {
      const d = h('dialog', { className: 'wide' });
      let result = null;
      const ok = h('button', { type: 'button', className: 'primary', textContent: 'Add columns', disabled: true });
      const picker = csvPicker(() => { ok.disabled = !picker.picked; ok.textContent = picker.picked ? 'Add ' + picker.picked + (picker.picked === 1 ? ' column' : ' columns') : 'Add columns'; });
      ok.onclick = () => { result = picker.build(usedKeys).columns; d.close(); };
      d.append(closeBtn(d), h('h2', { textContent: 'Add columns from a CSV file' }),
        h('p', { className: 'sub', textContent: 'Tick the columns to add. Only the columns are created here; to bring in the rows as well, use Import / Export afterwards.' }),
        picker.el, h('div', { className: 'dlgbtns' }, h('button', { type: 'button', textContent: 'Cancel', onclick: () => d.close() }), ok));
      d.onclose = () => { d.remove(); resolve(result); };
      document.body.append(d);
      d.showModal();
    });
  }

  // ---- create: a name, and what to start from ----
  function createDialog({ title, sub, placeholder, startLabel, options, okLabel, submit }) {
    const d = h('dialog');
    const name = h('input', { placeholder, required: true, maxLength: 80 });
    const from = h('select');
    options.forEach(([value, text]) => from.append(h('option', { value, textContent: text })));
    const ok = h('button', { type: 'submit', className: 'primary', textContent: okLabel });
    const form = h('form', { method: 'dialog' },
      h('h2', { textContent: title }), h('p', { className: 'sub', textContent: sub }),
      h('h3', { textContent: 'Name' }), h('div', { className: 'crow' }, name),
      h('h3', { textContent: startLabel }), h('div', { className: 'crow' }, from),
      h('div', { className: 'dlgbtns' }, h('button', { type: 'button', textContent: 'Cancel', onclick: () => d.close() }), ok));
    form.onsubmit = async e => {
      e.preventDefault();
      if (!name.value.trim()) return name.focus();
      ok.disabled = true;
      try { await submit(name.value.trim(), from.value || undefined); }
      catch (err) { ok.disabled = false; window.toast('Could not create it: ' + err.message, true); }
    };
    d.onclose = () => d.remove();
    d.append(h('button', { type: 'button', className: 'dlgx', title: 'Close', textContent: '×', onclick: () => d.close() }), form);
    document.body.append(d);
    d.showModal();
    name.focus();
  }
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  };
  const newProject = () => createDialog({
    title: 'New project', sub: 'A project has its own people and its own data sets.',
    placeholder: 'e.g. Q1 launch, Office move', startLabel: 'Start with', okLabel: 'Create project',
    options: [['', 'One empty data set'], ...projects.map(p => [p.id, 'The data sets and columns of ' + p.name + ' (no rows)'])],
    submit: async (name, template) => { const made = await post('api/projects', { name, template }); location.href = href('./', { project: made.id }); },
  });
  // New data set: default columns, a copy of another data set's columns, or the columns (and rows) of a CSV file.
  function newSet() {
    const d = h('dialog');
    const name = h('input', { placeholder: 'e.g. Vendors, Systems, Risks', required: true, maxLength: 80 });
    const from = h('select');
    [['', 'Default columns'], ['csv', 'A CSV file: pick its columns'], ...sets.map(s => [s.id, 'Same columns as ' + s.name])].forEach(([value, text]) => from.append(h('option', { value, textContent: text })));
    const ok = h('button', { type: 'submit', className: 'primary', textContent: 'Create data set' });
    const withRows = h('input', { type: 'checkbox', checked: true });
    const rowsLabel = h('span');
    const rowsLine = h('label', { className: 'csvopt', hidden: true }, withRows, rowsLabel);
    const picker = csvPicker(() => {
      if (!name.value.trim() && picker.fileName) name.value = picker.fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/^./, ch => ch.toUpperCase());
      rowsLine.hidden = !picker.loaded;
      rowsLabel.textContent = 'Also import its ' + picker.rowCount + (picker.rowCount === 1 ? ' row' : ' rows');
      sync();
    });
    const csvBox = h('div', { hidden: true }, picker.el, rowsLine);
    const sync = () => {
      const csv = from.value === 'csv';
      csvBox.hidden = !csv;
      d.classList.toggle('wide', csv);
      ok.disabled = csv && !picker.picked;
      ok.textContent = csv && picker.picked ? 'Create with ' + picker.picked + (picker.picked === 1 ? ' column' : ' columns') : 'Create data set';
    };
    from.onchange = sync;
    const form = h('form', { method: 'dialog' },
      h('h2', { textContent: 'New data set' }), h('p', { className: 'sub', textContent: 'A separate list in this project, with its own columns and rows. Lookup columns can link one data set to another.' }),
      h('h3', { textContent: 'Name' }), h('div', { className: 'crow' }, name),
      h('h3', { textContent: 'Start from' }), h('div', { className: 'crow' }, from), csvBox,
      h('div', { className: 'dlgbtns' }, h('button', { type: 'button', textContent: 'Cancel', onclick: () => d.close() }), ok));
    form.onsubmit = async e => {
      e.preventDefault();
      const title = name.value.trim();
      if (!title) return name.focus();
      ok.disabled = true;
      try {
        const csv = from.value === 'csv';
        const made = await post(projectApi('api/sets'), { name: title, template: csv ? undefined : from.value || undefined });
        if (csv) {
          const built = picker.build();
          const body = { config: { title, levels: [{ title, columns: built.columns, rules: [] }] }, rows: withRows.checked ? built.rows : [] };
          const r = await fetch(withQuery('api/state', 'project=' + enc(project) + '&set=' + enc(made.id)), { method: 'PUT', body: JSON.stringify(body) });
          if (!r.ok) throw new Error(await r.text());
        }
        location.href = href('./', { set: made.id });
      } catch (err) { ok.disabled = false; window.toast('Could not create it: ' + err.message, true); }
    };
    d.onclose = () => d.remove();
    d.append(closeBtn(d), form);
    document.body.append(d);
    d.showModal();
    sync();
    name.focus();
  }

  // ---- delete: the folder is moved to data/trash, so it can be put back by hand ----
  async function deleteSet(id = set) {
    const s = sets.find(x => x.id === id);
    if (!s) return;
    if (sets.length < 2) return window.toast('This is the only data set in the project. Create another one before deleting it.', true);
    const users = sets.filter(x => x.id !== id && x.refs.includes(id)).map(x => x.name);
    const warn = users.length ? ' Lookup columns in ' + users.join(', ') + ' point at it and will show their values as missing.' : '';
    if (!await window.ask('Delete the data set "' + s.name + '" and its ' + s.rows + (s.rows === 1 ? ' row' : ' rows') + '?' + warn + ' Its folder is moved to data/trash, not erased.', 'Delete data set', { danger: true })) return;
    const r = await fetch(projectApi('api/sets/' + enc(id)), { method: 'DELETE' });
    if (!r.ok) return window.toast('Could not delete: ' + await r.text(), true);
    location.href = href('./', { set: sets.find(x => x.id !== id).id });
  }
  async function deleteProject(id = project) {
    const p = projects.find(x => x.id === id);
    if (!p) return;
    if (projects.length < 2) return window.toast('This is the only project. Create another one before deleting it.', true);
    if (!await window.ask('Delete the project "' + p.name + '" with its ' + p.sets + (p.sets === 1 ? ' data set' : ' data sets') + ' and ' + p.rows + (p.rows === 1 ? ' row' : ' rows') + '? Its folder is moved to data/trash, not erased.', 'Delete project', { danger: true })) return;
    const r = await fetch('api/projects/' + enc(id), { method: 'DELETE' });
    if (!r.ok) return window.toast('Could not delete: ' + await r.text(), true);
    location.href = href('./', { project: projects.find(x => x.id !== id).id });
  }
  async function renameProject(name) {
    const r = await fetch('api/projects/' + enc(project), { method: 'PATCH', body: JSON.stringify({ name }) });
    if (!r.ok) return window.toast('Could not rename the project.', true);
    refresh();
  }

  // ---- lookups: what a lookup column shows for a record of the data set it points at ----
  // One piece of text per field in the column's `show` list (blank ones left out); with no list, the record's
  // default label. null when the record, or the whole data set, no longer exists.
  const fieldText = (col, raw) => {
    const v = String(raw ?? '').trim();
    if (!v) return '';
    if (col.type === 'checkbox') return v === 'true' ? col.label : '';
    if (col.type === 'choice') return v.split('|').map(x => x.trim()).filter(Boolean).join(', ');
    if (col.type === 'date' && typeof fmtDate === 'function') return fmtDate(v, col.format || 'native');   // the grid page's formatter
    return v;
  };
  function lookupParts(c, id) {
    const t = sets.find(s => s.id === c.set);
    const item = t && t.byId.get(String(id));
    if (!item) return null;
    const parts = (c.show || []).map(k => t.columns.find(x => x.key === k)).filter(Boolean).map(col => fieldText(col, item.f[col.key])).filter(Boolean);
    return parts.length ? parts : [item.label];
  }
  // The record a piece of imported text means: its id, what the column shows for it, its first shown field, or its default label.
  function lookupFind(c, text) {
    const t = sets.find(s => s.id === c.set), q = String(text ?? '').trim().toLowerCase();
    if (!t || !q) return null;
    if (t.byId.has(String(text).trim())) return String(text).trim();
    const hit = t.items.find(i => { const p = lookupParts(c, i.id) || []; return p.join(' · ').toLowerCase() === q || (p[0] || '').toLowerCase() === q || i.label.toLowerCase() === q; });
    return hit ? hit.id : null;
  }

  window.TT = {
    get project() { return project; },
    get set() { return set; },
    projects: () => projects,
    sets: () => sets,
    setInfo: id => sets.find(s => s.id === id) || null,
    api, href, ready, refresh, newProject, newSet, deleteProject, deleteSet, renameProject, lookupParts, lookupFind, pickCsvColumns,
  };
})();
