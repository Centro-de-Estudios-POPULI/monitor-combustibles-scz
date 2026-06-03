// Monitor de Saldos de Combustible — Santa Cruz (POPULI)
const SANTA_CRUZ = [-17.7833, -63.1821];
const COLORS = { crit: '#e5484d', low: '#f5a623', mid: '#f6d31b', high: '#33c27f' };

const state = { pid: 134, selected: null, data: null, stations: null, series: null };
let map, markerLayer, chart;

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
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
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

function renderMarkers(list) {
  markerLayer.clearLayers();
  const pts = [];
  list.forEach(e => {
    if (e.lat == null || e.lng == null) return;
    const c = COLORS[level(e.vehiculos)];
    const m = L.circleMarker([e.lat, e.lng], {
      radius: 9, color: '#0f1115', weight: 1.5, fillColor: c, fillOpacity: .92,
    }).bindPopup(
      `<div class="pp-name">${e.nombre}</div>` +
      `<div class="pp-addr">${e.direccion || ''}</div>` +
      `<div class="pp-saldo">${fmt(e.saldo)} L</div>` +
      `<div class="pp-veh">Alcanza para ~${fmt(Math.round(e.vehiculos || 0))} vehículos</div>`
    );
    m.on('click', () => { state.selected = keyOf(e); highlight(); renderChart(); });
    m.addTo(markerLayer);
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
  chart.setOption({
    grid: { left: 56, right: 18, top: 18, bottom: 40 },
    tooltip: { trigger: 'axis', valueFormatter: v => fmt(v) + ' L' },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: '#3a4150' } },
      axisLabel: { color: '#9aa3b2' } },
    yAxis: { type: 'value', name: 'Litros', nameTextStyle: { color: '#9aa3b2' },
      axisLabel: { color: '#9aa3b2', formatter: v => v.toLocaleString('es-BO') },
      splitLine: { lineStyle: { color: '#222831' } } },
    series: [{
      type: 'line', smooth: true, showSymbol: raw.length < 40, symbolSize: 5,
      data, lineStyle: { color: '#3da5ff', width: 2 },
      areaStyle: { color: 'rgba(61,165,255,.14)' }, itemStyle: { color: '#3da5ff' },
    }],
  }, true);
  if (raw.length <= 1) {
    chart.setOption({ graphic: { type: 'text', left: 'center', top: 'middle',
      style: { text: 'Aún se está acumulando histórico\n(vuelve en unas horas)',
        fill: '#9aa3b2', fontSize: 13, textAlign: 'center' } } });
  }
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
