// Sidebar hide / show, shared by every page. The choice is remembered per browser.
(() => {
  const KEY = 'navhidden';
  const root = document.documentElement;
  let hidden = false;
  try { hidden = localStorage.getItem(KEY) === '1'; } catch {}
  const apply = () => {
    root.classList.toggle('navhidden', hidden);
    try { localStorage.setItem(KEY, hidden ? '1' : '0'); } catch {}
  };
  apply();
  const icon = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = '<path d="' + d + '"/>'; return s; };
  const nav = document.querySelector('nav');
  if (!nav) return;
  const hideBtn = document.createElement('button');
  hideBtn.type = 'button'; hideBtn.className = 'navhide'; hideBtn.dataset.tip = 'Hide sidebar (⌘B)'; hideBtn.title = 'Hide sidebar';
  hideBtn.append(icon('M15 6l-6 6 6 6'));
  hideBtn.onclick = () => { hidden = true; apply(); };
  nav.prepend(hideBtn);
  const showBtn = document.createElement('button');
  showBtn.type = 'button'; showBtn.className = 'navshow'; showBtn.dataset.tip = 'Show sidebar (⌘B)'; showBtn.title = 'Show sidebar';
  showBtn.append(icon('M9 6l6 6-6 6'));
  showBtn.onclick = () => { hidden = false; apply(); };
  document.body.append(showBtn);
  addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); hidden = !hidden; apply(); }
  });
})();
