// Monitor de Saldos de Combustible — Santa Cruz (POPULI)
const SANTA_CRUZ = [-17.7833, -63.1821];
const COLORS = { crit: '#e5484d', low: '#f5a623', mid: '#f6d31b', high: '#33c27f' };

const state = { pid: 134, selected: null, data: null, stations: null, series: null };
let map, markerLayer, chart, tileLayer;

// ===== Tema (claro premium por defecto, con toggle persistente) =====
const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('tema', t); } catch (e) {}
  if (tileLayer) tileLayer.setUrl(TILES[t]);
  if (chart) renderChart();
}
function initTheme() {
  let t = 'light';
  try { t = localStorage.getItem('tema') || 'light'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('theme-toggle').onclick = () =>
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

// Clasifica por "alcanza para N vehículos" (estimación de la fuente)
function level(veh) {
  if (veh == null) return 'mid';
  if (veh < 50) return 'crit';
  if (veh < 150) return 'low';
  if (veh < 400) return 'mid';
  return 'high';
}
const fmt = n => (n == null ? '—' : Number(n).toLocaleString('es-BO'));

async function load() {
  const [latest, stations, series] = await Promise.all([
    fetch('data/latest.json').then(r => r.json()),
    fetch('data/stations.json').then(r => r.json()),
    fetch('data/series.json').then(r => r.json()),
  ]);
  state.data = latest; state.stations = stations; state.series = series;
  document.getElementById('updated').textContent = latest.actualizado;
  initTheme();
  initMap();
  initChart();
  wireControls();
  render();
}

function current() {
  return state.data.estaciones
    .filter(e => e.producto_id === state.pid)
    .sort((a, b) => b.saldo - a.saldo);
}

function initMap() {
  map = L.map('map', { scrollWheelZoom: false }).setView(SANTA_CRUZ, 11);
  tileLayer = L.tileLayer(TILES[currentTheme()], {
    attribution: '&copy; OpenStreetMap, &copy; CARTO', maxZoom: 19,
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

function render() {
  const list = current();
  renderKpis(list);
  renderMarkers(list);
  renderList(list);
  // selección por defecto: la de mayor saldo del producto actual
  if (!list.some(e => keyOf(e) === state.selected)) {
    state.selected = list.length ? keyOf(list[0]) : null;
  }
  highlight();
  renderChart();
}
const keyOf = e => `${e.un}-${e.producto_id}`;

function renderKpis(list) {
  const total = list.reduce((s, e) => s + e.saldo, 0);
  const veh = list.reduce((s, e) => s + (e.vehiculos || 0), 0);
  const crit = list.filter(e => level(e.vehiculos) === 'crit').length;
  const kpis = [
    [list.length, 'estaciones con stock'],
    [fmt(total) + ' L', 'volumen total disponible'],
    [fmt(Math.round(veh)), 'vehículos que alcanza (aprox.)'],
    [crit, 'estaciones en estado crítico'],
  ];
  document.getElementById('kpis').innerHTML = kpis
    .map(([v, l]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`)
    .join('');
}

let markersByKey = {};
function renderMarkers(list) {
  markerLayer.clearLayers();
  markersByKey = {};
  const pts = [];
  list.forEach(e => {
    if (e.lat == null || e.lng == null) return;
    const c = COLORS[level(e.vehiculos)];
    const m = L.circleMarker([e.lat, e.lng], {
      radius: 5, color: '#fff', weight: 1.5, fillColor: c, fillOpacity: .95,
    }).bindPopup(
      `<div class="pp-name">${e.nombre}</div>` +
      `<div class="pp-addr">${e.direccion || ''}</div>` +
      `<div class="pp-saldo">${fmt(e.saldo)} L</div>` +
      `<div class="pp-veh">Alcanza para ~${fmt(Math.round(e.vehiculos || 0))} vehículos</div>`
    );
    m.on('click', () => { state.selected = keyOf(e); highlight(); renderChart(); });
    m.addTo(markerLayer);
    markersByKey[keyOf(e)] = m;
    pts.push([e.lat, e.lng]);
  });
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 });
}

function renderList(list) {
  document.getElementById('list-count').textContent = `(${list.length})`;
  document.getElementById('list').innerHTML = list.map(e => {
    const c = COLORS[level(e.vehiculos)];
    return `<div class="row" data-key="${keyOf(e)}">
      <span class="bar" style="background:${c}"></span>
      <div><div class="name">${e.nombre}</div><div class="addr">${e.direccion || ''}</div></div>
      <div class="vals"><div class="saldo">${fmt(e.saldo)} L</div>
        <div class="veh">~${fmt(Math.round(e.vehiculos || 0))} veh.</div></div>
    </div>`;
  }).join('');
  document.querySelectorAll('#list .row').forEach(row => {
    row.onclick = () => {
      state.selected = row.dataset.key; highlight(); renderChart();
      const e = current().find(x => keyOf(x) === state.selected);
      if (e && e.lat != null) map.setView([e.lat, e.lng], 14);
    };
  });
}

function highlight() {
  document.querySelectorAll('#list .row').forEach(r =>
    r.classList.toggle('active', r.dataset.key === state.selected));
  Object.entries(markersByKey).forEach(([k, m]) => {
    const sel = k === state.selected;
    m.setRadius(sel ? 8 : 5);
    m.setStyle({ weight: sel ? 2.5 : 1.5 });
    if (sel) m.bringToFront();
  });
}

function initChart() {
  chart = echarts.init(document.getElementById('chart'), null, { renderer: 'canvas' });
  window.addEventListener('resize', () => chart.resize());
}

function renderChart() {
  const key = state.selected;
  const e = current().find(x => keyOf(x) === key);
  document.getElementById('chart-station').textContent =
    e ? `${e.nombre} · ${e.producto}` : 'sin datos';
  const raw = (state.series && state.series[key]) || [];
  const data = raw.map(([t, v]) => [t.replace(' ', 'T'), v]);
  const cs = getComputedStyle(document.documentElement);
  const muted = cs.getPropertyValue('--muted').trim();
  const axis = cs.getPropertyValue('--axis').trim();
  const grid = cs.getPropertyValue('--grid').trim();
  const accent = cs.getPropertyValue('--accent').trim();
  const dark = currentTheme() === 'dark';
  chart.setOption({
    grid: { left: 58, right: 18, top: 18, bottom: 40 },
    tooltip: { trigger: 'axis', valueFormatter: v => fmt(v) + ' L' },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: axis } },
      axisLabel: { color: muted } },
    yAxis: { type: 'value', name: 'Litros', nameTextStyle: { color: muted },
      axisLabel: { color: muted, formatter: v => v.toLocaleString('es-BO') },
      splitLine: { lineStyle: { color: grid } } },
    series: [{
      type: 'line', smooth: true, showSymbol: raw.length < 40, symbolSize: 5,
      data, lineStyle: { color: accent, width: 2.2 },
      areaStyle: { color: dark ? 'rgba(91,157,255,.16)' : 'rgba(31,95,224,.10)' },
      itemStyle: { color: accent },
    }],
    graphic: raw.length <= 1 ? { type: 'text', left: 'center', top: 'middle',
      style: { text: 'Aún se está acumulando histórico\n(vuelve en unas horas)',
        fill: muted, fontSize: 13, textAlign: 'center' } } : [],
  }, true);
}

function wireControls() {
  document.querySelectorAll('#producto-seg .seg-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#producto-seg .seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.pid = Number(btn.dataset.pid);
      state.selected = null;
      render();
    };
  });
}

load();
