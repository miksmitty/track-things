// Shared by every page: which project is open, the project list in the sidebar, and creating / renaming /
// deleting projects. The open project comes from ?project=<id> in the URL, else the last one used in this
// browser, else the first project the server lists. Pages call TT.api(path) to scope a request to it and wait
// on TT.ready before their first load.
(() => {
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); kids.forEach(k => e.append(k)); return e; };
  const ask = (message, okLabel = 'OK') => new Promise(resolve => {
    const d = el('dialog', { className: 'ask' });
    const no = el('button', { type: 'button', textContent: 'Cancel' });
    const yes = el('button', { type: 'button', className: 'primary', textContent: okLabel });
    d.append(el('p', { textContent: message }), el('div', { className: 'dlgbtns' }, no, yes));
    let answer = false;
    yes.onclick = () => { answer = true; d.close(); };
    no.onclick = () => d.close();
    d.onclose = () => { d.remove(); resolve(answer); };
    document.body.append(d);
    d.showModal();
    yes.focus();
  });

  const here = new URL(location.href);
  let project = here.searchParams.get('project') || '';
  try { if (!project) project = localStorage.getItem('tt-project') || ''; } catch {}
  let projects = [];

  const api = p => { const u = new URL(p, location.origin); if (project) u.searchParams.set('project', project); return u.pathname + u.search; };
  const pageFor = (page, id) => page + '?project=' + encodeURIComponent(id);
  const go = (page, id) => { location.href = pageFor(page, id); };

  const ICON = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';
  function renderList() {
    const box = document.getElementById('projectList');
    if (!box) return;
    box.replaceChildren();
    for (const p of projects) {
      const a = el('a', { className: 'navitem project' + (p.id === project ? ' active' : ''), href: pageFor(location.pathname, p.id) });
      a.innerHTML = ICON;
      a.append(el('span', { className: 'pname', textContent: p.name }), el('span', { className: 'pcount', textContent: p.rows }));
      box.append(a);
    }
    // Links between pages keep the open project.
    document.querySelectorAll('a[data-page]').forEach(a => { a.href = pageFor(a.dataset.page, project); });
  }

  async function refresh() {
    projects = await fetch('/api/projects').then(r => r.json());
    renderList();
    return projects;
  }

  const ready = refresh().then(() => {
    if (!projects.some(p => p.id === project)) project = projects[0] ? projects[0].id : '';
    try { localStorage.setItem('tt-project', project); } catch {}
    if (here.searchParams.get('project') !== project) { here.searchParams.set('project', project); history.replaceState(null, '', here); }
    renderList();
    return project;
  });

  // Create a project: a name, and either the default columns or a copy of an existing project's set-up (no records).
  function newProject() {
    const d = el('dialog');
    const form = el('form', { method: 'dialog' });
    const name = el('input', { placeholder: 'e.g. Q1 launch, Garden jobs, Reading list', required: true, maxLength: 80 });
    const from = el('select');
    from.append(el('option', { value: '', textContent: 'Default columns' }));
    projects.forEach(p => from.append(el('option', { value: p.id, textContent: 'Same columns as ' + p.name })));
    if (projects.some(p => p.id === project)) from.value = project;
    const cancel = el('button', { type: 'button', textContent: 'Cancel', onclick: () => d.close() });
    const ok = el('button', { type: 'submit', className: 'primary', textContent: 'Create project' });
    form.append(
      el('h2', { textContent: 'New project' }),
      el('p', { className: 'sub', textContent: 'Each project has its own rows, columns, people and snapshots.' }),
      el('h3', { textContent: 'Name' }), el('div', { className: 'crow' }, name),
      el('h3', { textContent: 'Start with' }), el('div', { className: 'crow' }, from),
      el('div', { className: 'dlgbtns' }, cancel, ok));
    form.onsubmit = async e => {
      e.preventDefault();
      if (!name.value.trim()) return name.focus();
      ok.disabled = true;
      const r = await fetch('/api/projects', { method: 'POST', body: JSON.stringify({ name: name.value.trim(), template: from.value || undefined }) });
      if (!r.ok) { ok.disabled = false; return alert('Could not create the project: ' + await r.text()); }
      const made = await r.json();
      d.close();
      go('/', made.id);
    };
    d.onclose = () => d.remove();
    d.append(form);
    document.body.append(d);
    d.showModal();
    name.focus();
  }

  async function deleteProject(id = project) {
    const p = projects.find(x => x.id === id);
    if (!p) return false;
    if (projects.length < 2) { await ask('This is the only project. Create another one before deleting it.', 'OK'); return false; }
    if (!await ask(`Delete the project "${p.name}" and its ${p.rows} top-level ${p.rows === 1 ? 'row' : 'rows'}? Its folder is moved to data/trash, not erased.`, 'Delete project')) return false;
    const r = await fetch('/api/projects/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) { alert('Could not delete: ' + await r.text()); return false; }
    const next = projects.find(x => x.id !== id);
    go('/', next.id);
    return true;
  }

  // The grid page renames a project by editing its title; it tells us so the sidebar updates at once.
  function setName(name) {
    const p = projects.find(x => x.id === project);
    if (p) { p.name = name; renderList(); }
  }

  window.TT = { get project() { return project; }, projects: () => projects, api, ready, refresh, newProject, deleteProject, setName };
  const btn = document.getElementById('newProjectBtn');
  if (btn) btn.onclick = newProject;
})();
