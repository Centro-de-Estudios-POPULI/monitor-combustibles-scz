// ===== Bootstrap, navegación y wiring =====

function renderCurrent() {
  ({ resumen: renderResumen, mapa: renderMapa, estaciones: renderEstaciones,
     patrones: renderPatrones, metodologia: renderMetodologia }[S.view] || (() => {}))();
  // re-tamaño de charts visibles
  setTimeout(() => Object.values(charts).forEach(c => c.resize()), 30);
}

function setView(view) {
  S.view = view;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  renderCurrent();
}

function selectStation(key) {
  S.selected = key;
  markActiveRow();
  highlightMarker();
  if (S.view === 'estaciones') renderDetail();
  if (S.view === 'mapa' && markersByKey[key]) markersByKey[key].openPopup();
}

function setUpdated() {
  const a = S.latest.actualizado;
  const el = document.getElementById('updated');
  el.textContent = relTime(a);
  el.title = `${a} (${S.latest.tz || 'hora local'})`;
}

// ---- tema ----
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('tema', t); } catch (e) {}
  if (tileLayer) tileLayer.setUrl(TILES[t]);
  renderCurrent();
}
function initTheme() {
  let t = 'light';
  try { t = localStorage.getItem('tema') || 'light'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('theme-toggle').onclick = () =>
    applyTheme(theme() === 'dark' ? 'light' : 'dark');
}

function wire() {
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => setView(b.dataset.view));
  document.querySelectorAll('#producto-seg .seg-btn').forEach(b => b.onclick = () => {
    document.querySelectorAll('#producto-seg .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    S.pid = Number(b.dataset.pid);
    S.selected = null;
    renderCurrent();
  });
  document.getElementById('search').oninput = () => { if (S.view === 'estaciones') renderEstaciones(); };
  document.getElementById('color-by').onchange = () => { if (S.view === 'mapa') renderMapa(); };
}

async function boot() {
  initTooltips();
  initTheme();
  await loadData();
  setUpdated();
  wire();
  setView('resumen');

  // auto-refresco cada 5 minutos
  setInterval(async () => {
    try { await loadData(); setUpdated(); renderCurrent(); } catch (e) {}
  }, 5 * 60 * 1000);
}

boot();
