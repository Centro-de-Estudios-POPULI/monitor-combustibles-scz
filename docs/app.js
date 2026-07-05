// ===== Bootstrap, navegación (single-page) y wiring =====

function setUpdated() {
  const a = S.latest.actualizado;
  const el = document.getElementById('updated');
  el.textContent = relTime(a);
  el.title = `${a} (${S.latest.tz || 'hora local'})`;
}

// Aviso visible cuando una fuente (Biopetrol/Genex) lleva rato sin datos frescos.
// Lo alimenta health.json (generado por el scraper). Sin alertas => oculto.
function renderHealth() {
  const el = document.getElementById('health-banner');
  if (!el) return;
  const marcas = (S.health && S.health.marcas) || {};
  const probs = Object.entries(marcas).filter(([, v]) => v && v.alerta);
  if (!probs.length) { el.hidden = true; el.innerHTML = ''; return; }
  const parts = probs.map(([m, v]) => {
    const nombre = marcaLabel(m);
    if (!v.estaciones_frescas) return `<b>${nombre}</b> sin datos en este momento`;
    return `<b>${nombre}</b> sin actualizar desde hace ${Math.round(v.antiguedad_h)} h`;
  });
  el.innerHTML = `<span class="health-ic" aria-hidden="true">⚠</span>`
    + `<div class="health-text">${parts.join(' · ')}. `
    + `Se muestra el último dato disponible; puede estar desactualizado.</div>`;
  el.hidden = false;
}

// ---- tema ----
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('tema', t); } catch (e) {}
  if (tileLayer) tileLayer.setUrl(TILES[t]);
  renderAll();
}
function initTheme() {
  let t = 'light';
  try { t = localStorage.getItem('tema') || 'light'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('theme-toggle').onclick = () =>
    applyTheme(theme() === 'dark' ? 'light' : 'dark');
}

// ---- scroll-spy de las anclas ----
function initScrollSpy() {
  const links = [...document.querySelectorAll('.anchor')];
  const secs = links.map(a => document.querySelector(a.getAttribute('href')));
  const obs = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        const id = '#' + en.target.id;
        links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === id));
      }
    });
  }, { rootMargin: '-120px 0px -65% 0px', threshold: 0 });
  secs.forEach(s => s && obs.observe(s));
}

function wire() {
  document.querySelectorAll('#producto-seg .seg-btn').forEach(b => b.onclick = () => {
    document.querySelectorAll('#producto-seg .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    S.pid = Number(b.dataset.pid);
    S.selected = null;
    renderAll();
  });
  document.querySelectorAll('#marca-seg .seg-btn').forEach(b => b.onclick = () => {
    document.querySelectorAll('#marca-seg .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    S.marca = b.dataset.marca;
    S.selected = null;
    renderAll();
  });
  document.getElementById('color-by').onchange = () => renderMapa();
  const recoBtn = document.getElementById('reco-btn');
  if (recoBtn) recoBtn.onclick = requestLocation;
}

// ---- ayuda / cómo usar (descartable, recordada en localStorage) ----
function initHelp() {
  const banner = document.getElementById('help-banner');
  const close = document.getElementById('help-close');
  if (!banner || !close) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('help_dismissed') === '1'; } catch (e) {}
  banner.hidden = dismissed;
  close.onclick = () => {
    banner.hidden = true;
    try { localStorage.setItem('help_dismissed', '1'); } catch (e) {}
  };
}

async function boot() {
  initTooltips();
  initTheme();
  initHelp();
  await loadData();
  setUpdated();
  renderHealth();
  wire();
  renderAll();
  initScrollSpy();

  // reajuste robusto en móvil: tras el layout, al cargar imágenes y al rotar
  const refit = () => { try { if (typeof map !== 'undefined' && map) map.invalidateSize(); Object.values(charts).forEach(c => c.resize()); } catch (e) {} };
  [200, 600, 1200].forEach(ms => setTimeout(refit, ms));
  window.addEventListener('load', refit);
  window.addEventListener('orientationchange', () => setTimeout(refit, 300));

  // auto-refresco cada 5 minutos
  setInterval(async () => {
    try { await loadData(); setUpdated(); renderHealth(); renderAll(); } catch (e) {}
  }, 5 * 60 * 1000);
}

boot();
