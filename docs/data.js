// ===== Estado global y utilidades =====
const SANTA_CRUZ = [-17.7833, -63.1821];
const PRODUCTOS = { 134: 'Gasolina Especial', 132: 'Diésel' };

const S = {
  pid: 134, view: 'resumen', selected: null,
  latest: null, metrics: null, series: null, redSeries: null, heatmap: null, daily: null,
};

// ---- formato ----
const fmt = n => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('es-BO'));
const fmtL = n => (n == null ? '—' : fmt(Math.round(n)) + ' L');
function relTime(fechaStr) {
  if (!fechaStr) return '—';
  const t = new Date(fechaStr.replace(' ', 'T'));
  const min = Math.round((Date.now() - t.getTime()) / 60000);
  if (isNaN(min)) return fechaStr;
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h ${min % 60} min`;
  return `hace ${Math.floor(h / 24)} d`;
}

// ---- colores ----
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
}
const ESTADO_VAR = { critico: 'crit', bajo: 'low', medio: 'mid', alto: 'high', seca: 'seca', sin_dato: 'seca' };
const ESTADO_LABEL = { critico: 'Crítico', bajo: 'Bajo', medio: 'Medio', alto: 'Alto', seca: 'Sin stock', sin_dato: 'Sin dato' };
function estadoColor(estado) { return cssVar(ESTADO_VAR[estado] || 'seca'); }
function etaBucket(h) {
  if (h == null) return 'seca';
  if (h < 3) return 'critico';
  if (h < 8) return 'bajo';
  if (h < 24) return 'medio';
  return 'alto';
}
function colorFor(e, mode) {
  return mode === 'eta' ? estadoColor(etaBucket(e.eta_horas)) : estadoColor(e.estado);
}

// ---- acceso a datos ----
const theme = () => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
const estaciones = () => S.latest.estaciones
  .filter(e => e.producto_id === S.pid).sort((a, b) => b.saldo - a.saldo);
const keyOf = e => `${e.un}-${e.producto_id}`;
const metricOf = key => (S.metrics && S.metrics.estaciones[key]) || {};
const indic = k => (S.metrics && S.metrics.indicadores[k]) || { nombre: k, desc: '', unidad: '' };

async function loadData() {
  const j = f => fetch(`data/${f}?t=${Math.floor(Date.now() / 60000)}`).then(r => r.json());
  const [latest, metrics, series, redSeries, heatmap, daily] = await Promise.all([
    j('latest.json'), j('metrics.json'), j('series_recent.json'),
    j('red_series.json'), j('heatmap.json'), j('daily.json'),
  ]);
  Object.assign(S, { latest, metrics, series, redSeries, heatmap, daily });
}

// ---- tooltips de los iconos (i) ----
function initTooltips() {
  const tip = document.getElementById('tooltip');
  document.body.addEventListener('mouseover', e => {
    const el = e.target.closest('.info');
    if (!el) return;
    const d = indic(el.dataset.k);
    tip.innerHTML = `<b>${d.nombre}</b>${d.unidad ? ` · ${d.unidad}` : ''}<br>${d.desc}`;
    const r = el.getBoundingClientRect();
    tip.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
    tip.style.top = (r.bottom + 8) + 'px';
    tip.classList.add('show');
  });
  document.body.addEventListener('mouseout', e => {
    if (e.target.closest('.info')) tip.classList.remove('show');
  });
}

// ---- registro de charts ECharts (para resize/re-tema) ----
const charts = {};
function getChart(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (!charts[id]) charts[id] = echarts.init(el, null, { renderer: 'canvas' });
  return charts[id];
}
function axisTheme() {
  return { muted: cssVar('muted'), axis: cssVar('axis'), grid: cssVar('grid'), accent: cssVar('accent') };
}
window.addEventListener('resize', () => Object.values(charts).forEach(c => c.resize()));
