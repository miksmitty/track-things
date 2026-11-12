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

  // ---- sidebar: Projects and Data sets, inserted above the page's own links ----
  const nav = document.querySelector('nav');
  const projectList = h('div', { className: 'navlist' }), setList = h('div', { className: 'navlist' });
  const svg = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = '<path d="' + d + '"/>'; return s; };
  const FOLDER = 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z';
  const TABLE = 'M4 5h16v14H4zM4 10h16M10 10v9';
  const PLUS = 'M12 5v14M5 12h14';
  const addBtn = (label, fn) => h('button', { type: 'button', className: 'navitem add', onclick: fn }, svg(PLUS), label);
  if (nav) {
    const first = nav.querySelector('.navlabel');
    const parts = [
      h('div', { className: 'navlabel', textContent: 'Projects' }), projectList, addBtn('New project', () => newProject()),
      h('div', { className: 'navlabel', textContent: 'Data sets' }), setList, addBtn('New data set', () => newSet()),
    ];
    first ? first.before(...parts) : nav.append(...parts);
    nav.querySelectorAll('a[href]').forEach(a => (a.dataset.base = a.getAttribute('href')));   // the page's own links, as written
  }
  const entry = (active, link, icon, name, count) => {
    const a = h('a', { className: 'navitem entry' + (active ? ' active' : ''), href: link }, svg(icon), h('span', { className: 'pname', textContent: name }));
    if (count != null) a.append(h('span', { className: 'pcount', textContent: count }));
    return a;
  };
  function render() {
    projectList.replaceChildren(...projects.map(p => entry(p.id === project, href(page(), { project: p.id }), FOLDER, p.name)));
    setList.replaceChildren(...sets.map(s => entry(s.id === set, href(page(), { set: s.id }), TABLE, s.name, s.rows)));
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
    sets.forEach(s => (s.byId = new Map(s.items.map(i => [i.id, i.label]))));   // record id -> label, for lookup columns
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
  const newSet = () => createDialog({
    title: 'New data set', sub: 'A separate list in this project, with its own columns and rows. Lookup columns can link one data set to another.',
    placeholder: 'e.g. Vendors, Systems, Risks', startLabel: 'Columns', okLabel: 'Create data set',
    options: [['', 'Default columns'], ...sets.map(s => [s.id, 'Same columns as ' + s.name])],
    submit: async (name, template) => { const made = await post(projectApi('api/sets'), { name, template }); location.href = href('./', { set: made.id }); },
  });

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

  window.TT = {
    get project() { return project; },
    get set() { return set; },
    projects: () => projects,
    sets: () => sets,
    setInfo: id => sets.find(s => s.id === id) || null,
    api, href, ready, refresh, newProject, newSet, deleteProject, deleteSet, renameProject,
  };
})();
