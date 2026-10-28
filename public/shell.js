// Shared by every page: theme, sidebar hide / show, in-page confirm / prompt dialogs, toasts and save status.
// Loaded in <head> without defer so the saved theme is applied before the first paint (no light flash in dark mode).
(() => {
  const root = document.documentElement;
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  // ---- theme ----
  const t = store.get('tt-theme');
  if (t === 'dark' || t === 'light') root.dataset.theme = t;
  const isDark = () => (root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';

  const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); kids.forEach(k => e.append(k)); return e; };
  const icon = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = '<path d="' + d + '"/>'; return s; };
  const MOON = 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z';
  const SUN = 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66l1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14l-1.41-1.41M16 12a4 4 0 11-8 0 4 4 0 018 0z';

  // ---- in-page dialogs (native confirm() / prompt() are blocked in some embedded browsers and silently return null) ----
  // ask(message, okLabel, { danger }) resolves true for OK, false for Cancel / Escape / the close button.
  // askText(message, { value, placeholder, okLabel }) resolves the trimmed text, or null when cancelled.
  function modal(build) {
    return new Promise(resolve => {
      const d = h('dialog', { className: 'ask' });
      let answer = null;
      const done = v => { answer = v; d.close(); };
      d.append(h('button', { type: 'button', className: 'dlgx', title: 'Close', 'ariaLabel': 'Close', textContent: '×', onclick: () => d.close() }));
      const focus = build(d, done);
      d.onclose = () => { d.remove(); resolve(answer); };
      document.body.append(d);
      d.showModal();
      focus && focus.focus();
    });
  }
  window.ask = (message, okLabel = 'OK', opts = {}) => modal((d, done) => {
    const no = h('button', { type: 'button', textContent: 'Cancel', onclick: () => done(false) });
    const yes = h('button', { type: 'button', className: 'primary' + (opts.danger ? ' danger' : ''), textContent: okLabel, onclick: () => done(true) });
    d.append(h('p', { textContent: message }), h('div', { className: 'dlgbtns' }, no, yes));
    return yes;
  }).then(v => v === true);
  window.askText = (message, opts = {}) => modal((d, done) => {
    const inp = h('input', { type: 'text', value: opts.value || '', placeholder: opts.placeholder || '' });
    const form = h('form', { method: 'dialog', onsubmit: e => { e.preventDefault(); done(inp.value.trim() || null); } });
    form.append(h('p', { textContent: message }), inp,
      h('div', { className: 'dlgbtns' }, h('button', { type: 'button', textContent: 'Cancel', onclick: () => done(null) }), h('button', { type: 'submit', className: 'primary', textContent: opts.okLabel || 'OK' })));
    d.append(form);
    return inp;
  });

  // ---- toast: short confirmation at the bottom of the screen; bad = true shows it as an error ----
  let toastEl, toastTimer;
  window.toast = (msg, bad) => {
    if (!toastEl) document.body.append((toastEl = h('div', { className: 'toast', role: 'status' })));
    toastEl.textContent = msg;
    toastEl.classList.toggle('bad', !!bad);
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), bad ? 6000 : 3000);
  };

  // ---- save status in the sidebar: 'saving' | 'saved' | 'error' ----
  window.setSaveStatus = (state, text) => {
    const dot = document.getElementById('dot'), label = document.getElementById('dotText');
    if (!dot || !label) return;
    dot.classList.toggle('saving', state === 'saving');
    dot.classList.toggle('error', state === 'error');
    label.textContent = text || { saving: 'Saving…', saved: 'All changes saved', error: 'Could not save' }[state];
  };

  document.addEventListener('DOMContentLoaded', () => {
    const nav = document.querySelector('nav');
    if (!nav) return;

    // Theme button: shows the theme you will switch to.
    const themeBtn = document.getElementById('themeBtn');
    if (themeBtn) {
      const paint = () => {
        const dark = isDark();
        themeBtn.replaceChildren(icon(dark ? SUN : MOON), document.createTextNode(dark ? 'Light mode' : 'Dark mode'));
      };
      paint();
      themeBtn.onclick = () => { root.dataset.theme = isDark() ? 'light' : 'dark'; store.set('tt-theme', root.dataset.theme); paint(); };
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
    }

    // Sidebar hide / show. On wide screens the choice is remembered; on narrow screens the sidebar opens over the page.
    const small = matchMedia('(max-width: 760px)');
    let hidden = store.get('navhidden') === '1';
    const apply = () => { root.classList.toggle('navhidden', hidden); store.set('navhidden', hidden ? '1' : '0'); };
    apply();
    const setOpen = open => small.matches ? root.classList.toggle('navopen', open) : ((hidden = !open), apply());
    const hideBtn = h('button', { type: 'button', className: 'navhide', title: 'Hide sidebar', onclick: () => setOpen(false) }, icon('M15 6l-6 6 6 6'));
    hideBtn.dataset.tip = 'Hide sidebar (⌘B)';
    nav.prepend(hideBtn);
    const showBtn = h('button', { type: 'button', className: 'navshow', title: 'Show sidebar', onclick: () => setOpen(true) }, icon('M4 6h16M4 12h16M4 18h16'));
    showBtn.dataset.tip = 'Show sidebar (⌘B)';
    document.body.append(showBtn);
    document.addEventListener('mousedown', e => { if (root.classList.contains('navopen') && !nav.contains(e.target) && !showBtn.contains(e.target)) root.classList.remove('navopen'); });
    addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setOpen(small.matches ? !root.classList.contains('navopen') : hidden);
      }
    });
  });
})();
