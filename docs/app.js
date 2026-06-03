// ===== Bootstrap, navegación (single-page) y wiring =====

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
  document.getElementById('color-by').onchange = () => renderMapa();
}

async function boot() {
  initTooltips();
  initTheme();
  await loadData();
  setUpdated();
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
    try { await loadData(); setUpdated(); renderAll(); } catch (e) {}
  }, 5 * 60 * 1000);
}

boot();
