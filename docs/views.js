// ===== Render de cada vista =====

function infoIcon(k) { return `<i class="info" data-k="${k}"></i>`; }

// ---------- RESUMEN ----------
function renderResumen() {
  const r = S.metrics.red[S.pid];
  const rs = S.redSeries[String(S.pid)] || [];
  // tendencia de stock vs ~24h atras
  let trend = '';
  if (rs.length > 4) {
    const ahora = rs[rs.length - 1].stock;
    const ref = rs[Math.max(0, rs.length - 25)].stock;
    if (ref > 0) {
      const pct = Math.round(100 * (ahora - ref) / ref);
      const cls = pct >= 0 ? 'up' : 'down';
      trend = `<span class="trend ${cls}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% / 24h</span>`;
    }
  }
  const kpis = [
    { v: fmtL(r.stock), l: `stock total ${infoIcon('stock_red')}`, t: trend },
    { v: `${r.n_con}/${r.n_total}`, l: 'estaciones con stock' },
    { v: `${r.estres}%`, l: `estrés de la red ${infoIcon('estres_red')}` },
    { v: fmt(r.vehiculos), l: 'vehículos que alcanza' },
  ];
  document.getElementById('kpis').innerHTML = kpis.map(k =>
    `<div class="kpi"><div class="v">${k.v}${k.t || ''}</div><div class="l">${k.l}</div></div>`).join('');

  lineChart('chart-estres', rs.map(d => [d.t.replace(' ', 'T'), pctCrit(d)]),
    { area: true, suffix: '%', color: cssVar('crit'), max: 100 });
  renderStockStacked();
  renderCompare();
}
const pctCrit = d => d.n_total ? Math.round(100 * d.n_crit / d.n_total) : 0;

// paleta verde/teal para las áreas apiladas
function stackPalette(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = 150 + (i * 58 / Math.max(1, n - 1));   // verde -> teal -> azulado
    const l = (theme() === 'dark' ? 42 : 52) + (i % 2 ? 7 : 0);
    out.push(`hsl(${Math.round(h)},52%,${l}%)`);
  }
  return out;
}
// Stock total: áreas apiladas por estación (atrás) + línea general (adelante)
function renderStockStacked() {
  const st = (S.stacked && S.stacked[String(S.pid)]) || { t: [], series: [] };
  const c = getChart('chart-stock'); if (!c) return;
  const th = axisTheme();
  const xs = st.t.map(t => t.replace(' ', 'T'));
  const pal = stackPalette(st.series.length);
  const areas = st.series.map((s, i) => ({
    name: s.nombre, type: 'line', stack: 'estaciones', smooth: false, showSymbol: false,
    lineStyle: { width: 0 }, areaStyle: { opacity: theme() === 'dark' ? .65 : .55 },
    itemStyle: { color: pal[i] }, emphasis: { focus: 'series' }, data: s.data,
  }));
  const total = xs.map((_, j) => st.series.reduce((a, s) => a + (s.data[j] || 0), 0));
  const totalSeries = {
    name: 'TOTAL', type: 'line', smooth: true, showSymbol: false, z: 20, data: total,
    lineStyle: { color: th.accent, width: 2.6 }, itemStyle: { color: th.accent }, tooltip: { show: true },
  };
  c.setOption({
    grid: { left: 60, right: 14, top: 14, bottom: 34 },
    tooltip: {
      trigger: 'axis', confine: true,
      formatter: params => {
        const tot = params.find(p => p.seriesName === 'TOTAL');
        const st2 = params.filter(p => p.seriesName !== 'TOTAL' && p.value > 0)
          .sort((a, b) => b.value - a.value);
        let html = `<b>${params[0].axisValueLabel.slice(5, 16)}</b><br>` +
          `<b>Total: ${fmt(tot ? tot.value : 0)} L</b>`;
        st2.slice(0, 7).forEach(p => { html += `<br>${p.marker}${p.seriesName}: ${fmt(p.value)} L`; });
        if (st2.length > 7) html += `<br><span style="opacity:.6">+${st2.length - 7} estaciones…</span>`;
        return html;
      },
    },
    xAxis: {
      type: 'category', data: xs, boundaryGap: false,
      axisLine: { lineStyle: { color: th.axis } },
      axisLabel: { color: th.muted, formatter: v => v.slice(5, 10) },
    },
    yAxis: {
      type: 'value', axisLabel: { color: th.muted, formatter: v => v.toLocaleString('es-BO') },
      splitLine: { lineStyle: { color: th.grid } },
    },
    series: [...areas, totalSeries],
  }, true);
  if (!xs.length) c.setOption({ graphic: emptyGraphic('Acumulando datos') });
}

function renderCompare() {
  const el = document.getElementById('compare');
  el.innerHTML = Object.keys(PRODUCTOS).map(pid => {
    const r = S.metrics.red[pid];
    if (!r) return '';
    const col = r.estres >= 40 ? cssVar('crit') : r.estres >= 15 ? cssVar('low') : cssVar('high');
    return `<div class="comp-card">
      <div class="pname">${r.producto}</div>
      <div class="comp-row"><span>Stock total</span><b>${fmtL(r.stock)}</b></div>
      <div class="comp-row"><span>Con stock</span><b>${r.n_con}/${r.n_total}</b></div>
      <div class="comp-row"><span>En crítico</span><b>${r.n_critico}</b></div>
      <div class="comp-row"><span>Vehículos</span><b>${fmt(r.vehiculos)}</b></div>
      <div class="comp-row"><span>Estrés</span><b>${r.estres}%</b></div>
      <div class="barmeter"><span style="width:${r.estres}%;background:${col}"></span></div>
    </div>`;
  }).join('');
}

// ---------- MAPA ----------
let map, markerLayer, tileLayer, markersByKey = {};
const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
// Vista por defecto: ciudad de Santa Cruz dentro del 4º anillo
const CITY_CENTER = [-17.7833, -63.1821], CITY_ZOOM = 13;
function ensureMap() {
  if (map) { map.invalidateSize(); return; }
  map = L.map('map', { scrollWheelZoom: false, zoomSnap: 0.25 }).setView(CITY_CENTER, CITY_ZOOM);
  tileLayer = L.tileLayer(TILES[theme()], { attribution: '&copy; OpenStreetMap, &copy; CARTO', maxZoom: 19 }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}
function renderMapa() {
  ensureMap();
  const mode = document.getElementById('color-by').value;
  renderLegend(mode);
  markerLayer.clearLayers();
  markersByKey = {};
  const pts = [];
  estaciones().forEach(e => {
    if (e.lat == null || e.lng == null) return;
    const m = metricOf(keyOf(e));
    const c = colorFor(e, mode);
    const mk = L.circleMarker([e.lat, e.lng], { radius: 5, color: '#fff', weight: 1.5, fillColor: c, fillOpacity: .95 })
      .bindPopup(popupHtml(e, m));
    mk.on('click', () => selectStation(keyOf(e), { fromMap: true }));
    mk.addTo(markerLayer);
    markersByKey[keyOf(e)] = mk;
    pts.push([e.lat, e.lng]);
  });
  highlightMarker();
}
function gmapsUrl(e) {
  return `https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}`;
}
function popupHtml(e, m) {
  const eta = m.eta_horas != null
    ? `<div class="pp-eta" style="color:${estadoColor(etaBucket(m.eta_horas))}">Se agota en ~${m.eta_horas} h</div>` : '';
  const link = e.lat != null
    ? `<a class="pp-link" target="_blank" rel="noopener" href="${gmapsUrl(e)}">Cómo llegar · Google Maps ↗</a>` : '';
  return `<div class="pp-name">${e.nombre}${e.stale ? ' <span class="tag-stale">dato viejo</span>' : ''}</div>
    <div class="pp-addr">${e.direccion || ''}</div>
    <div class="pp-saldo">${fmtL(e.saldo)}</div>
    <div class="pp-veh">Alcanza para ~${fmt(Math.round(e.vehiculos))} vehículos</div>${eta}${link}`;
}
function renderLegend(mode) {
  const items = mode === 'eta'
    ? [['critico', '< 3 h'], ['bajo', '3–8 h'], ['medio', '8–24 h'], ['alto', '> 24 h']]
    : [['critico', 'Crítico'], ['bajo', 'Bajo'], ['medio', 'Medio'], ['alto', 'Alto']];
  document.getElementById('legend').innerHTML = items.map(([est, lbl]) =>
    `<span class="legend-item"><i class="dot" style="background:${estadoColor(est)}"></i>${lbl}</span>`).join('');
}
function highlightMarker() {
  Object.entries(markersByKey).forEach(([k, mk]) => {
    const sel = k === S.selected;
    mk.setRadius(sel ? 8 : 5); mk.setStyle({ weight: sel ? 2.5 : 1.5 });
    if (sel) mk.bringToFront();
  });
}

// ---------- ESTACIONES ----------
function renderEstaciones() {
  const list = estaciones();   // todas las del combustible seleccionado
  const lc = document.getElementById('list-count');
  if (lc) lc.textContent = `(${list.length})`;
  document.getElementById('list').innerHTML = list.map(e => {
    const c = estadoColor(e.estado);
    return `<div class="row" data-key="${keyOf(e)}">
      <span class="bar" style="background:${c}"></span>
      <div><div class="name">${e.nombre}${e.stale ? '<span class="tag-stale">viejo</span>' : ''}</div>
        <div class="addr">${e.direccion || ''}</div></div>
      <div class="vals"><div class="saldo">${fmtL(e.saldo)}</div>
        <div class="veh">~${fmt(Math.round(e.vehiculos))} veh.</div></div></div>`;
  }).join('') || '<div class="empty">Sin resultados.</div>';
  document.querySelectorAll('#list .row').forEach(row =>
    row.onclick = () => selectStation(row.dataset.key, { zoom: true }));
  if (!list.some(e => keyOf(e) === S.selected)) S.selected = list.length ? keyOf(list[0]) : null;
  renderDetail();
  markActiveRow();
}

// Selección interactiva (mapa <-> lista <-> detalle)
function selectStation(key, opts = {}) {
  S.selected = key;
  markActiveRow();
  highlightMarker();
  renderDetail();
  const e = estaciones().find(x => keyOf(x) === key);
  if (!e) return;
  if (opts.zoom && map && e.lat != null) {
    map.flyTo([e.lat, e.lng], 15, { duration: .6 });
    const mk = markersByKey[key];
    if (mk) setTimeout(() => mk.openPopup(), 250);
  }
  if (opts.fromMap) {
    const row = document.querySelector(`#list .row[data-key="${key}"]`);
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
function markActiveRow() {
  document.querySelectorAll('#list .row').forEach(r =>
    r.classList.toggle('active', r.dataset.key === S.selected));
}
// promedio del saldo en las ultimas `hours` horas (desde series_recent)
function avgRecent(key, hours = 24) {
  const raw = (S.series && S.series[key]) || [];
  if (raw.length < 2) return null;
  const last = new Date(raw[raw.length - 1][0].replace(' ', 'T')).getTime();
  const cut = last - hours * 3600e3;
  const vals = raw.filter(([t]) => new Date(t.replace(' ', 'T')).getTime() >= cut).map(([, v]) => v);
  if (vals.length < 2) return null;
  return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length, hours };
}
function deltaHtml(cur, avg) {
  if (avg == null || avg === 0) return '';
  const pct = Math.round((cur - avg) / avg * 100);
  if (pct === 0) return '<span class="dlt flat">≈ prom</span>';
  return `<span class="dlt ${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs prom 24h</span>`;
}
function renderDetail() {
  const e = estaciones().find(x => keyOf(x) === S.selected);
  const box = document.getElementById('detail');
  if (!e) { box.innerHTML = '<div class="empty">Selecciona una estación.</div>'; getChart('chart-station').clear(); return; }
  const m = metricOf(keyOf(e));
  document.getElementById('detail-title').textContent = 'Detalle · ' + e.nombre;
  const badge = `<span class="badge" style="background:${estadoColor(e.estado)}">${ESTADO_LABEL[e.estado] || e.estado}</span>`;
  const rec = m.ultima_recarga ? `${fmt(m.ultima_recarga.delta)} L · ${m.ultima_recarga.t.slice(5, 16)}` : '—';
  const ar = avgRecent(keyOf(e), 24);
  const sDelta = ar ? deltaHtml(e.saldo, ar.avg) : '<span class="dlt flat">acumulando</span>';
  const cells = [
    { k: 'saldo', v: fmtL(e.saldo), extra: sDelta },
    { k: 'vehiculos', v: fmt(Math.round(e.vehiculos)), extra: sDelta },
    { label: 'Saldo prom. (24 h)', v: ar ? fmtL(Math.round(ar.avg)) : '—' },
    { k: 'despacho_lh', v: m.despacho_lh != null ? fmt(m.despacho_lh) + ' L/h' : '—' },
    { k: 'eta_horas', v: m.eta_horas != null ? m.eta_horas + ' h' : '—' },
    { k: 'saldo_por_manguera', v: m.saldo_por_manguera != null ? fmtL(m.saldo_por_manguera) : '—' },
    { k: 'capacidad_lh', v: m.capacidad_lh != null ? fmt(m.capacidad_lh) + ' L/h' : '—' },
    { k: 'saturacion', v: m.saturacion != null ? m.saturacion : '—' },
    { k: 'uptime_hoy', v: m.uptime_hoy != null ? m.uptime_hoy + '%' : '—' },
    { k: 'ultima_recarga', v: rec },
  ];
  const gmaps = e.lat != null
    ? `<a class="gmaps-btn" target="_blank" rel="noopener" href="${gmapsUrl(e)}"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>Cómo llegar</a>` : '';
  box.innerHTML = `<div class="detail-head">
      <div>${badge}${e.stale ? ' <span class="tag-stale">dato viejo</span>' : ''}</div>${gmaps}</div>
    <p class="detail-addr">${e.direccion || ''} · ${e.mangueras || '?'} mangueras · ${relTime(e.fecha)}</p>
    <div class="metrics-grid">${cells.map(c =>
      `<div class="metric"><div class="mv">${c.v}</div>
        ${c.extra ? `<div class="cmp">${c.extra}</div>` : ''}
        <div class="ml">${c.label || indic(c.k).nombre} ${c.k ? infoIcon(c.k) : ''}</div></div>`).join('')}</div>`;
  renderStationChart(e, m, ar);
}
function renderStationChart(e, m, ar) {
  const raw = (S.series && S.series[keyOf(e)]) || [];
  const data = raw.map(([t, v]) => [t.replace(' ', 'T'), v]);
  const marks = (m.recargas || []).map(r => ({
    xAxis: r.t.replace(' ', 'T'),
    label: { formatter: '+' + fmt(r.delta) + ' L', color: cssVar('high'), fontSize: 10 },
    lineStyle: { color: cssVar('high'), type: 'dashed' },
  }));
  if (ar) marks.push({
    yAxis: Math.round(ar.avg),
    label: { formatter: 'prom 24h', color: cssVar('muted'), fontSize: 10, position: 'insideEndTop' },
    lineStyle: { color: cssVar('muted'), type: 'dotted' },
  });
  lineChart('chart-station', data, {
    area: true, suffix: ' L',
    markLine: marks.length ? { symbol: 'none', data: marks } : null,
    empty: raw.length <= 1 ? 'Acumulando histórico (vuelve en unas horas)' : null,
  });
}

// ---------- PATRONES ----------
function renderPatrones() {
  renderHeatmap();
  renderDaily();
}
function renderHeatmap() {
  const hm = (S.heatmap && S.heatmap[String(S.pid)]) || { data: [], dias: [] };
  const t = axisTheme();
  const horas = Array.from({ length: 24 }, (_, i) => i + 'h');
  const max = Math.max(10, ...hm.data.map(d => d[2]));
  getChart('heatmap').setOption({
    tooltip: { position: 'top', formatter: p => `${hm.dias[p.value[1]]} ${p.value[0]}:00<br>${p.value[2]}% críticas` },
    grid: { left: 44, right: 14, top: 10, bottom: 28 },
    xAxis: { type: 'category', data: horas, splitArea: { show: true }, axisLabel: { color: t.muted, interval: 1 }, axisLine: { lineStyle: { color: t.axis } } },
    yAxis: { type: 'category', data: hm.dias, splitArea: { show: true }, axisLabel: { color: t.muted }, axisLine: { lineStyle: { color: t.axis } } },
    visualMap: { min: 0, max, calculable: true, orient: 'horizontal', left: 'center', bottom: -4, show: false,
      inRange: { color: [cssVar('high'), cssVar('mid'), cssVar('low'), cssVar('crit')] } },
    series: [{ type: 'heatmap', data: hm.data, itemStyle: { borderColor: cssVar('panel'), borderWidth: 1 } }],
  }, true);
  if (!hm.data.length) getChart('heatmap').setOption({ graphic: emptyGraphic('Acumulando datos para el patrón') });
}
function renderDaily() {
  const dates = Object.keys(S.daily || {}).sort();
  const el = document.getElementById('daily');
  if (!dates.length) { el.innerHTML = '<div class="empty">Aún no hay resúmenes diarios.</div>'; return; }
  const day = dates[dates.length - 1];
  const rows = (S.daily[day] || []).filter(r => r.producto_id === S.pid)
    .sort((a, b) => b.saldo_prom - a.saldo_prom);
  el.innerHTML = `<p class="card-note">Día ${day} · combustible: ${PRODUCTOS[S.pid]}</p>
    <table><thead><tr>
      <th>Estación</th><th class="num">Mín</th><th class="num">Prom</th><th class="num">Máx</th>
      <th class="num">Recargas</th><th class="num">Vol. recargado</th><th class="num">% crítico</th>
    </tr></thead><tbody>${rows.map(r => `<tr>
      <td>${r.nombre}</td><td class="num">${fmt(r.saldo_min)}</td><td class="num">${fmt(r.saldo_prom)}</td>
      <td class="num">${fmt(r.saldo_max)}</td><td class="num">${r.n_recargas}</td>
      <td class="num">${fmt(r.vol_recargado)}</td><td class="num">${r.pct_critico}%</td></tr>`).join('')}</tbody></table>`;
}

// ---------- METODOLOGÍA ----------
function renderMetodologia() {
  document.getElementById('metodo-intro').innerHTML = `
    <p>Este monitor extrae cada <b>15 minutos</b> los saldos de combustible que publica la
       <b>Guía Biopetrol</b> para las estaciones de Santa Cruz, los almacena y calcula indicadores.</p>
    <p>La fuente reporta, por estación: el <code>saldo</code> en litros, la hora de la medición, el número de
       <code>mangueras</code>, la carga promedio por vehículo (~40 L) y la georreferencia. A partir de la
       <b>serie temporal</b> que vamos acumulando se derivan el resto de indicadores.</p>
    <p>Todo se maneja en <b>hora de Bolivia (UTC-4)</b>. Las estimaciones de despacho, tiempo de agotamiento y
       saturación son aproximaciones basadas en la evolución del saldo, no cifras oficiales.</p>`;
  const ind = S.metrics.indicadores;
  document.getElementById('metodo-indicadores').innerHTML = Object.values(ind).map(d =>
    `<div class="indic"><div class="it"><span>${d.nombre}</span><span class="iu">${d.unidad || ''}</span></div>
      <div class="id">${d.desc}</div></div>`).join('');
}

// ---------- helpers de chart ----------
function emptyGraphic(text) {
  return { type: 'text', left: 'center', top: 'middle',
    style: { text, fill: cssVar('muted'), fontSize: 13, textAlign: 'center' } };
}
function lineChart(id, data, opts = {}) {
  const c = getChart(id); if (!c) return;
  const t = axisTheme();
  const color = opts.color || t.accent;
  c.setOption({
    grid: { left: 58, right: 16, top: 14, bottom: 36 },
    tooltip: { trigger: 'axis', valueFormatter: v => fmt(v) + (opts.suffix || '') },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: t.axis } }, axisLabel: { color: t.muted } },
    yAxis: { type: 'value', max: opts.max, axisLabel: { color: t.muted, formatter: v => v.toLocaleString('es-BO') },
      splitLine: { lineStyle: { color: t.grid } } },
    series: [{
      type: 'line', smooth: true, showSymbol: data.length < 40, symbolSize: 5, data,
      lineStyle: { color, width: 2.2 }, itemStyle: { color },
      areaStyle: opts.area ? { color: hexA(color, theme() === 'dark' ? .16 : .10) } : null,
      markLine: opts.markLine,
    }],
    graphic: opts.empty ? emptyGraphic(opts.empty) : [],
  }, true);
}
function hexA(hex, a) {
  const h = hex.replace('#', '');
  if (h.length < 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- HERO ----------
function renderHero() {
  const g = S.metrics.red['134'] || {}, d = S.metrics.red['132'] || {};
  const chips = [
    { v: fmtL(g.stock), l: 'Gasolina disponible' },
    { v: fmtL(d.stock), l: 'Diésel disponible' },
    { v: (g.n_total || 0) + (d.n_total || 0), l: 'estaciones monitoreadas' },
  ];
  document.getElementById('hero-stats').innerHTML = chips.map(c =>
    `<div class="hero-stat"><div class="hv">${c.v}</div><div class="hl">${c.l}</div></div>`).join('');
}

// ---------- render de toda la página ----------
function renderAll() {
  const steps = [renderHero, renderEstaciones, renderMapa, renderResumen, renderPatrones, renderMetodologia];
  steps.forEach(fn => { try { fn(); } catch (e) { console.error('Error en', fn.name, e); } });
  setTimeout(() => Object.values(charts).forEach(c => c.resize()), 40);
}
