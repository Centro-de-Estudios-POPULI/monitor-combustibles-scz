// ===== Render de cada vista =====

function infoIcon(k) { return `<i class="info" data-k="${k}"></i>`; }
const pctCrit = d => d.n_total ? Math.round(100 * d.n_crit / d.n_total) : 0;

// Tendencia de stock ~24 h coherente con el filtro de marca. Devuelve null (no mostrar)
// si hace 24 h reportaban muchas menos estaciones de esa marca (p. ej. Genex recién entró),
// porque el % sería engañoso. Se reactiva sola cuando hay 24 h de historia.
function stockTrend() {
  const st = (S.stacked && S.stacked[String(S.pid)]) || { t: [], series: [] };
  let series = st.series;
  if (S.marca !== 'todas') series = series.filter(s => s.marca === S.marca);
  const n = st.t.length;
  if (n < 6 || !series.length) return null;
  const idxNow = n - 1, idxRef = Math.max(0, n - 25);
  const sumAt = j => series.reduce((a, s) => a + (s.data[j] || 0), 0);
  const cntAt = j => series.filter(s => (s.data[j] || 0) > 0).length;
  const ref = sumAt(idxRef);
  if (ref <= 0 || cntAt(idxRef) < cntAt(idxNow) * 0.6) return null;
  return Math.round(100 * (sumAt(idxNow) - ref) / ref);
}

// ---------- RESUMEN ----------
function renderResumen() {
  if (isGnv(S.pid)) return renderResumenGnv();
  const list = estaciones();                 // ya filtrado por producto + marca
  const stock = list.reduce((a, e) => a + (e.saldo || 0), 0);
  const nCon = list.filter(e => (e.saldo || 0) > 0).length;
  const nCrit = list.filter(e => e.estado === 'critico').length;
  const veh = Math.round(list.reduce((a, e) => a + (e.vehiculos || 0), 0));
  const estres = list.length ? Math.round(100 * nCrit / list.length) : 0;

  const rs = S.redSeries[String(S.pid)] || [];   // serie de red (combinada) para el gráfico de estrés
  const tpct = stockTrend();                     // trend coherente con el filtro de marca
  const trend = tpct == null ? '' :
    `<span class="trend ${tpct >= 0 ? 'up' : 'down'}">${tpct >= 0 ? '▲' : '▼'} ${Math.abs(tpct)}% / 24h</span>`;
  const kpis = [
    { v: fmtKL(stock), l: `stock total ${infoIcon('stock_red')}`, t: trend },
    { v: `${nCon}/${list.length}`, l: 'estaciones con stock' },
    { v: `${estres}%`, l: `estrés de la red ${infoIcon('estres_red')}` },
    { v: fmt(veh), l: 'vehículos que alcanza' },
  ];
  document.getElementById('kpis').innerHTML = kpis.map(k =>
    `<div class="kpi"><div class="v">${k.v}${k.t || ''}</div><div class="l">${k.l}</div></div>`).join('');

  lineChart('chart-estres', rs.map(d => [d.t.replace(' ', 'T'), pctCrit(d)]),
    { area: true, suffix: '%', color: cssVar('crit'), max: 100 });
  renderStockStacked();
  renderCompare();
}

// Resumen para GNV: disponibilidad, no litros.
function renderResumenGnv() {
  const list = estaciones();
  const total = list.length;
  const disp = list.filter(e => e.disp).length;
  const conCola = list.filter(e => e.cola_nivel > 0).length;
  const kpis = [
    { v: `${disp}/${total}`, l: `con GNV disponible ${infoIcon('disponibilidad')}` },
    { v: `${total - disp}`, l: 'estaciones agotadas' },
    { v: total ? Math.round(100 * disp / total) + '%' : '—', l: 'disponibilidad de la red' },
    { v: `${conCola}`, l: `con cola reportada ${infoIcon('cola')}` },
  ];
  document.getElementById('kpis').innerHTML = kpis.map(k =>
    `<div class="kpi"><div class="v">${k.v}</div><div class="l">${k.l}</div></div>`).join('');
  const c1 = getChart('chart-estres'); if (c1) c1.setOption({ series: [], xAxis: { show: false }, yAxis: { show: false }, graphic: emptyGraphic('El GNV se reporta solo como disponible / agotado.\nVer el mapa y la lista de estaciones.') }, true);
  const c2 = getChart('chart-stock'); if (c2) c2.setOption({ series: [], xAxis: { show: false }, yAxis: { show: false }, graphic: emptyGraphic('Sin serie de litros para GNV.') }, true);
  renderCompare();
}

// paleta verde/teal para las áreas apiladas
function stackPalette(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = 150 + (i * 58 / Math.max(1, n - 1));
    const l = (theme() === 'dark' ? 42 : 52) + (i % 2 ? 7 : 0);
    out.push(`hsl(${Math.round(h)},52%,${l}%)`);
  }
  return out;
}
// Stock total: áreas apiladas por estación (atrás) + línea general (adelante).
// Respeta el filtro de marca.
function renderStockStacked() {
  const st = (S.stacked && S.stacked[String(S.pid)]) || { t: [], series: [] };
  const c = getChart('chart-stock'); if (!c) return;
  const th = axisTheme();
  const xs = st.t.map(t => t.replace(' ', 'T'));
  let series = st.series;
  if (S.marca !== 'todas') series = series.filter(s => s.marca === S.marca);
  const pal = stackPalette(series.length);
  const areas = series.map((s, i) => ({
    name: s.nombre, type: 'line', stack: 'estaciones', smooth: false, showSymbol: false,
    lineStyle: { width: 0 }, areaStyle: { opacity: theme() === 'dark' ? .65 : .55 },
    itemStyle: { color: pal[i] }, emphasis: { focus: 'series' }, data: s.data,
  }));
  const total = xs.map((_, j) => series.reduce((a, s) => a + (s.data[j] || 0), 0));
  const totalSeries = {
    name: 'TOTAL', type: 'line', smooth: true, showSymbol: false, z: 20, data: total,
    lineStyle: { color: th.accent, width: 2.6 }, itemStyle: { color: th.accent }, tooltip: { show: true },
  };
  // Señal: dónde se incorpora Genex (solo en la vista combinada), para explicar el salto.
  if (S.marca === 'todas') {
    const gseries = st.series.filter(s => s.marca === 'genex');
    let gStart = -1;
    for (let j = 0; j < xs.length; j++) { if (gseries.some(s => (s.data[j] || 0) > 0)) { gStart = j; break; } }
    if (gStart >= 0) totalSeries.markLine = {
      symbol: 'none', silent: true, data: [{ xAxis: xs[gStart] }],
      lineStyle: { color: cssVar('low'), type: 'dashed', width: 1.5 },
      label: { formatter: 'Genex se suma', color: cssVar('low'), fontSize: 10, position: 'insideStartTop' },
    };
  }
  c.setOption({
    grid: { left: 60, right: 14, top: 14, bottom: 34 },
    tooltip: {
      trigger: 'axis', confine: true, ...tipStyle(),
      formatter: params => {
        const tot = params.find(p => p.seriesName === 'TOTAL');
        const st2 = params.filter(p => p.seriesName !== 'TOTAL' && p.value > 0).sort((a, b) => b.value - a.value);
        let html = `<b>${params[0].axisValueLabel.slice(5, 16)}</b><br><b>Total: ${fmtKL(tot ? tot.value : 0)}</b>`;
        st2.slice(0, 7).forEach(p => { html += `<br>${p.marker}${p.seriesName}: ${fmtKL(p.value)}`; });
        if (st2.length > 7) html += `<br><span style="opacity:.6">+${st2.length - 7} estaciones…</span>`;
        return html;
      },
    },
    xAxis: {
      type: 'category', data: xs, boundaryGap: false, show: true,
      axisLine: { lineStyle: { color: th.axis } },
      axisLabel: { color: th.muted, formatter: v => v.slice(5, 10) },
    },
    yAxis: {
      type: 'value', show: true, axisLabel: { color: th.muted, formatter: v => fmtK(v) },
      splitLine: { lineStyle: { color: th.grid } },
    },
    series: [...areas, totalSeries],
  }, true);
  if (!xs.length || !series.length) c.setOption({ graphic: emptyGraphic('Acumulando datos') });
}

function renderCompare() {
  const el = document.getElementById('compare');
  const marca = S.marca;
  el.innerHTML = Object.keys(PRODUCTOS).map(pid => {
    const r = S.metrics.red[pid];
    if (!r) return '';
    const d = marca !== 'todas' ? (r.por_marca && r.por_marca[marca]) : r;
    if (!d) return '';                         // esa marca no tiene este combustible
    if (r.tipo === 'gnv') {
      const n = d.n_total || 0, disp = d.n_disp || 0;
      const pctDisp = n ? Math.round(100 * disp / n) : 0;
      const col = pctDisp >= 60 ? cssVar('high') : pctDisp >= 30 ? cssVar('low') : cssVar('crit');
      return `<div class="comp-card">
        <div class="pname">${r.producto}</div>
        <div class="comp-row"><span>Disponible en</span><b>${disp}/${n}</b></div>
        <div class="comp-row"><span>Agotado en</span><b>${d.n_agotado || 0}</b></div>
        <div class="comp-row"><span>Disponibilidad</span><b>${pctDisp}%</b></div>
        <div class="barmeter"><span style="width:${pctDisp}%;background:${col}"></span></div>
      </div>`;
    }
    const col = d.estres >= 40 ? cssVar('crit') : d.estres >= 15 ? cssVar('low') : cssVar('high');
    return `<div class="comp-card">
      <div class="pname">${r.producto}</div>
      <div class="comp-row"><span>Stock total</span><b>${fmtKL(d.stock)}</b></div>
      <div class="comp-row"><span>Con stock</span><b>${d.n_con}/${d.n_total}</b></div>
      <div class="comp-row"><span>En crítico</span><b>${d.n_critico}</b></div>
      <div class="comp-row"><span>Vehículos</span><b>${fmt(d.vehiculos)}</b></div>
      <div class="comp-row"><span>Estrés</span><b>${d.estres}%</b></div>
      <div class="barmeter"><span style="width:${d.estres}%;background:${col}"></span></div>
    </div>`;
  }).join('');
}

// ---------- MAPA ----------
let map, markerLayer, tileLayer, markersByKey = {};
const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
// Vista por defecto: ciudad de Santa Cruz dentro del 4º anillo. Las estaciones de
// Montero (Genex) quedan fuera del encuadre, accesibles desde la lista (clic → vuela).
const CITY_CENTER = [-17.7833, -63.1821], CITY_ZOOM = 13;
function ensureMap() {
  if (map) { map.invalidateSize(); return; }
  map = L.map('map', { scrollWheelZoom: false, zoomSnap: 0.25 }).setView(CITY_CENTER, CITY_ZOOM);
  tileLayer = L.tileLayer(TILES[theme()], { attribution: '&copy; OpenStreetMap, &copy; CARTO', maxZoom: 19 }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  const el = document.getElementById('map');
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe(el);
}
// Icono de estación: forma = marca (círculo Biopetrol / cuadrado Genex), color = estado.
function stationIcon(e, color, sel) {
  const shape = (MARCAS[e.marca] && MARCAS[e.marca].shape) || 'circle';
  const s = sel ? 17 : 12;
  return L.divIcon({
    className: 'mk-wrap', iconSize: [s, s], iconAnchor: [s / 2, s / 2],
    html: `<span class="mk mk-${shape} ${sel ? 'mk-sel' : ''}" style="background:${color};width:${s}px;height:${s}px"></span>`,
  });
}
function renderMapa() {
  ensureMap();
  const mode = document.getElementById('color-by').value;
  renderLegend(mode);
  markerLayer.clearLayers();
  markersByKey = {};
  estaciones().forEach(e => {
    if (e.lat == null || e.lng == null) return;
    const m = metricOf(keyOf(e));
    const color = colorFor(e, mode);
    const mk = L.marker([e.lat, e.lng], { icon: stationIcon(e, color, false) }).bindPopup(popupHtml(e, m));
    mk.on('click', () => selectStation(keyOf(e), { fromMap: true }));
    mk.addTo(markerLayer);
    markersByKey[keyOf(e)] = { mk, e, color };
  });
  highlightMarker();
}
function gmapsUrl(e) {
  return `https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}`;
}
function popupHtml(e, m) {
  const link = e.lat != null
    ? `<a class="pp-link" target="_blank" rel="noopener" href="${gmapsUrl(e)}">Cómo llegar · Google Maps ↗</a>` : '';
  const ciudad = e.ciudad && e.ciudad !== 'Santa Cruz' ? ` · ${e.ciudad}` : '';
  const head = `<div class="pp-name">${e.nombre} ${marcaPill(e)}${e.stale ? ' <span class="tag-stale">dato viejo</span>' : ''}</div>
    <div class="pp-addr">${e.direccion || ''}${ciudad}</div>`;
  if (isGnv(e.producto_id)) {
    const cola = e.cola_nivel != null ? `<div class="pp-veh">${COLA_LABEL[e.cola_nivel]}</div>` : '';
    return `${head}<div class="pp-saldo" style="color:${e.disp ? cssVar('high') : cssVar('crit')}">${e.disp ? 'GNV disponible' : 'GNV agotado'}</div>${cola}${link}`;
  }
  const eta = m.eta_horas != null
    ? `<div class="pp-eta" style="color:${estadoColor(etaBucket(m.eta_horas))}">Se agota en ~${m.eta_horas} h</div>` : '';
  const cola = e.cola_nivel != null ? `<div class="pp-veh">${COLA_LABEL[e.cola_nivel]}</div>` : '';
  return `${head}<div class="pp-saldo">${fmtKL(e.saldo)}</div>
    <div class="pp-veh">Alcanza para ~${fmt(Math.round(e.vehiculos))} vehículos</div>${eta}${cola}${link}`;
}
function renderLegend(mode) {
  let colors;
  if (isGnv(S.pid)) colors = [['alto', 'Disponible'], ['critico', 'Agotado']];
  else colors = mode === 'eta'
    ? [['critico', '< 3 h'], ['bajo', '3–8 h'], ['medio', '8–24 h'], ['alto', '> 24 h']]
    : [['critico', 'Crítico'], ['bajo', 'Bajo'], ['medio', 'Medio'], ['alto', 'Alto']];
  let html = colors.map(([est, lbl]) =>
    `<span class="legend-item"><i class="dot" style="background:${estadoColor(est)}"></i>${lbl}</span>`).join('');
  if (S.marca === 'todas') {
    html += '<span class="legend-sep"></span>' + Object.entries(MARCAS).map(([k, v]) =>
      `<span class="legend-item"><i class="mk mk-${v.shape} legend-mk"></i>${v.label}</span>`).join('');
  }
  document.getElementById('legend').innerHTML = html;
}
function highlightMarker() {
  Object.entries(markersByKey).forEach(([k, o]) => {
    const sel = k === S.selected;
    o.mk.setIcon(stationIcon(o.e, o.color, sel));
    if (sel) o.mk.setZIndexOffset(1000); else o.mk.setZIndexOffset(0);
  });
}

// ---------- ESTACIONES ----------
function renderEstaciones() {
  const list = estaciones();
  const lc = document.getElementById('list-count');
  if (lc) lc.textContent = `(${list.length})`;
  document.getElementById('list').innerHTML = list.map(e => {
    const c = colorFor(e, 'estado');
    const ciudad = e.ciudad && e.ciudad !== 'Santa Cruz' ? ` · ${e.ciudad}` : '';
    const vals = isGnv(e.producto_id)
      ? `<div class="saldo" style="color:${e.disp ? cssVar('high') : cssVar('crit')}">${e.disp ? 'Disponible' : 'Agotado'}</div>
         ${e.cola_nivel != null ? `<div class="veh">${COLA_LABEL[e.cola_nivel]}</div>` : ''}`
      : `<div class="saldo">${fmtKL(e.saldo)}</div><div class="veh">~${fmt(Math.round(e.vehiculos))} veh.</div>`;
    const cb = (!isGnv(e.producto_id) && e.marca === 'genex') ? colaBadge(e) : '';
    return `<div class="row" data-key="${keyOf(e)}">
      <span class="bar" style="background:${c}"></span>
      <div><div class="name">${e.nombre} ${marcaPill(e)}${e.stale ? '<span class="tag-stale">viejo</span>' : ''}</div>
        <div class="addr">${e.direccion || ''}${ciudad} ${cb}</div></div>
      <div class="vals">${vals}</div></div>`;
  }).join('') || '<div class="empty">Sin resultados.</div>';
  document.querySelectorAll('#list .row').forEach(row =>
    row.onclick = () => selectStation(row.dataset.key, { zoom: true }));
  if (!list.some(e => keyOf(e) === S.selected)) S.selected = list.length ? keyOf(list[0]) : null;
  renderDetail();
  markActiveRow();
}

function selectStation(key, opts = {}) {
  S.selected = key;
  markActiveRow();
  highlightMarker();
  renderDetail();
  const e = estaciones().find(x => keyOf(x) === key);
  if (!e) return;
  if (opts.zoom && map && e.lat != null) {
    map.flyTo([e.lat, e.lng], 15, { duration: .6 });
    const o = markersByKey[key];
    if (o) setTimeout(() => o.mk.openPopup(), 250);
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
  if (isGnv(e.producto_id)) return renderDetailGnv(e, box);
  const m = metricOf(keyOf(e));
  document.getElementById('detail-title').textContent = 'Detalle · ' + e.nombre;
  const badge = `<span class="badge" style="background:${estadoColor(e.estado)}">${ESTADO_LABEL[e.estado] || e.estado}</span>`;
  const rec = m.ultima_recarga ? `${fmtKL(m.ultima_recarga.delta)} · ${m.ultima_recarga.t.slice(5, 16)}` : '—';
  const ar = avgRecent(keyOf(e), 24);
  const sDelta = ar ? deltaHtml(e.saldo, ar.avg) : '<span class="dlt flat">acumulando</span>';
  const cells = [
    { k: 'saldo', v: fmtKL(e.saldo), extra: sDelta },
    { k: 'vehiculos', v: fmt(Math.round(e.vehiculos)), extra: sDelta },
    { label: 'Saldo prom. (24 h)', v: ar ? fmtKL(Math.round(ar.avg)) : '—' },
    { k: 'despacho_lh', v: m.despacho_lh != null ? fmtK(m.despacho_lh) + ' L/h' : '—' },
    { k: 'eta_horas', v: m.eta_horas != null ? m.eta_horas + ' h' : '—' },
    { k: 'saldo_por_manguera', v: m.saldo_por_manguera != null ? fmtKL(m.saldo_por_manguera) : '—' },
    { k: 'capacidad_lh', v: m.capacidad_lh != null ? fmt(m.capacidad_lh) + ' L/h' : '—' },
    { k: 'saturacion', v: m.saturacion != null ? m.saturacion : '—' },
    { k: 'uptime_hoy', v: m.uptime_hoy != null ? m.uptime_hoy + '%' : '—' },
    { k: 'ultima_recarga', v: rec },
  ];
  if (e.cola_nivel != null) cells.push({ k: 'cola', v: COLA_LABEL[e.cola_nivel] });
  const gmaps = e.lat != null
    ? `<a class="gmaps-btn" target="_blank" rel="noopener" href="${gmapsUrl(e)}"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>Cómo llegar</a>` : '';
  const mang = e.mangueras ? `${e.mangueras} mangueras · ` : '';
  box.innerHTML = `<div class="detail-head">
      <div>${badge} ${marcaPill(e)}${e.stale ? ' <span class="tag-stale">dato viejo</span>' : ''}</div>${gmaps}</div>
    <p class="detail-addr">${e.direccion || ''}${e.ciudad && e.ciudad !== 'Santa Cruz' ? ' · ' + e.ciudad : ''} · ${mang}${relTime(e.fecha)}</p>
    <div class="metrics-grid">${cells.map(c =>
      `<div class="metric"><div class="mv">${c.v}</div>
        ${c.extra ? `<div class="cmp">${c.extra}</div>` : ''}
        <div class="ml">${c.label || indic(c.k).nombre} ${c.k ? infoIcon(c.k) : ''}</div></div>`).join('')}</div>`;
  renderStationChart(e, m, ar);
}
// Detalle para GNV: disponibilidad + cola, sin gráfico de litros.
function renderDetailGnv(e, box) {
  document.getElementById('detail-title').textContent = 'Detalle · ' + e.nombre;
  const badge = `<span class="badge" style="background:${e.disp ? cssVar('high') : cssVar('crit')}">${e.disp ? 'GNV disponible' : 'GNV agotado'}</span>`;
  const gmaps = e.lat != null
    ? `<a class="gmaps-btn" target="_blank" rel="noopener" href="${gmapsUrl(e)}"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>Cómo llegar</a>` : '';
  const cells = [
    { k: 'disponibilidad', v: e.disp ? 'Disponible' : 'Agotado' },
    { k: 'cola', v: e.cola_nivel != null ? COLA_LABEL[e.cola_nivel] : '—' },
    { label: 'Última lectura', v: relTime(e.fecha) },
  ];
  box.innerHTML = `<div class="detail-head">
      <div>${badge} ${marcaPill(e)}</div>${gmaps}</div>
    <p class="detail-addr">${e.direccion || ''}${e.ciudad && e.ciudad !== 'Santa Cruz' ? ' · ' + e.ciudad : ''}</p>
    <div class="metrics-grid">${cells.map(c =>
      `<div class="metric"><div class="mv">${c.v}</div>
        <div class="ml">${c.label || indic(c.k).nombre} ${c.k ? infoIcon(c.k) : ''}</div></div>`).join('')}</div>
    <p class="card-note">El GNV se publica solo como disponible/agotado; no hay serie de litros.</p>`;
  getChart('chart-station').clear();
  getChart('chart-station').setOption({ graphic: emptyGraphic('Sin serie de litros para GNV') }, true);
}
// Adelgaza las recargas: junta las que están a < 1 h (deja la mayor) y conserva las 6
// más recientes, para que las etiquetas del gráfico no se amontonen.
function thinRefills(refills) {
  const sorted = [...refills].sort((a, b) => (a.t < b.t ? -1 : 1));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && (new Date(r.t.replace(' ', 'T')) - new Date(last.t.replace(' ', 'T'))) / 3600e3 < 1) {
      if (r.delta > last.delta) out[out.length - 1] = r;
      continue;
    }
    out.push(r);
  }
  return out.slice(-6);
}
function renderStationChart(e, m, ar) {
  const raw = (S.series && S.series[keyOf(e)]) || [];
  const data = raw.map(([t, v]) => [t.replace(' ', 'T'), v]);
  const refs = thinRefills(m.recargas || []);
  const marks = refs.map((r, i) => ({
    xAxis: r.t.replace(' ', 'T'),
    // alterna la etiqueta arriba/abajo para que no se solapen ni se corten en el borde
    label: { formatter: '+' + fmtK(r.delta), color: cssVar('high'), fontSize: 10,
             position: i % 2 ? 'start' : 'end' },
    lineStyle: { color: cssVar('high'), type: 'dashed' },
  }));
  if (ar) marks.push({
    yAxis: Math.round(ar.avg),
    label: { formatter: 'prom 24h', color: cssVar('muted'), fontSize: 10, position: 'insideEndBottom' },
    lineStyle: { color: cssVar('muted'), type: 'dotted' },
  });
  lineChart('chart-station', data, {
    area: true, suffix: ' L', kAxis: true, headroom: 1.15,
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
  const el = getChart('heatmap'); if (!el) return;
  if (isGnv(S.pid)) { el.clear(); el.setOption({ series: [], xAxis: { show: false }, yAxis: { show: false }, graphic: emptyGraphic('El GNV no tiene patrón de litros (solo disponibilidad).') }, true); return; }
  const hm = (S.heatmap && S.heatmap[String(S.pid)]) || { data: [], dias: [] };
  const t = axisTheme();
  const horas = Array.from({ length: 24 }, (_, i) => i + 'h');
  const max = Math.max(10, ...hm.data.map(d => d[2]));
  el.setOption({
    tooltip: { position: 'top', ...tipStyle(), formatter: p => `${hm.dias[p.value[1]]} ${p.value[0]}:00<br>${p.value[2]}% críticas` },
    grid: { left: 44, right: 14, top: 10, bottom: 28 },
    xAxis: { type: 'category', data: horas, show: true, splitArea: { show: true }, axisLabel: { color: t.muted, interval: 1 }, axisLine: { lineStyle: { color: t.axis } } },
    yAxis: { type: 'category', data: hm.dias, show: true, splitArea: { show: true }, axisLabel: { color: t.muted }, axisLine: { lineStyle: { color: t.axis } } },
    visualMap: { min: 0, max, calculable: true, orient: 'horizontal', left: 'center', bottom: -4, show: false,
      inRange: { color: [cssVar('high'), cssVar('mid'), cssVar('low'), cssVar('crit')] } },
    series: [{ type: 'heatmap', data: hm.data, itemStyle: { borderColor: cssVar('panel'), borderWidth: 1 } }],
  }, true);
  if (!hm.data.length) el.setOption({ graphic: emptyGraphic('Acumulando datos para el patrón') });
}
function renderDaily() {
  const el = document.getElementById('daily');
  if (isGnv(S.pid)) { el.innerHTML = '<div class="empty">El GNV no tiene resumen diario de litros.</div>'; return; }
  const dates = Object.keys(S.daily || {}).sort();
  if (!dates.length) { el.innerHTML = '<div class="empty">Aún no hay resúmenes diarios.</div>'; return; }
  const day = dates[dates.length - 1];
  const rows = (S.daily[day] || []).filter(r => r.producto_id === S.pid).sort((a, b) => b.saldo_prom - a.saldo_prom);
  if (!rows.length) { el.innerHTML = `<div class="empty">Sin datos diarios para ${PRODUCTOS[S.pid]}.</div>`; return; }
  el.innerHTML = `<p class="card-note">Día ${day} · combustible: ${PRODUCTOS[S.pid]}</p>
    <table><thead><tr>
      <th>Estación</th><th class="num">Mín</th><th class="num">Prom</th><th class="num">Máx</th>
      <th class="num">Recargas</th><th class="num">Vol. recargado</th><th class="num">% crítico</th>
    </tr></thead><tbody>${rows.map(r => `<tr>
      <td>${r.nombre}</td><td class="num">${fmtK(r.saldo_min)}</td><td class="num">${fmtK(r.saldo_prom)}</td>
      <td class="num">${fmtK(r.saldo_max)}</td><td class="num">${r.n_recargas}</td>
      <td class="num">${fmtK(r.vol_recargado)}</td><td class="num">${r.pct_critico}%</td></tr>`).join('')}</tbody></table>`;
}

// ---------- METODOLOGÍA ----------
function renderMetodologia() {
  document.getElementById('metodo-intro').innerHTML = `
    <p>Este monitor extrae cada <b>15 minutos</b> los saldos de combustible que publican la
       <b>Guía Biopetrol</b> y el <b>portal de estaciones Genex</b> en Santa Cruz y Montero, los almacena
       y calcula indicadores.</p>
    <p>De Biopetrol obtenemos, por estación: el <code>saldo</code> en litros, la hora, el número de
       <code>mangueras</code>, la carga promedio por vehículo y la georreferencia. De Genex obtenemos el
       saldo en litros (gasolina especial, premium y diésel), la <b>cola de vehículos</b> reportada y, para
       el <b>GNV</b>, solo su disponibilidad (disponible/agotado, sin litros). Genex no publica mangueras,
       así que los indicadores que dependen de ellas no aplican a esa red.</p>
    <p>Las dos redes se distinguen en el mapa por su forma (Biopetrol círculo, Genex cuadrado) y se pueden
       aislar con el <b>filtro de marca</b>. Todo se maneja en <b>hora de Bolivia (UTC-4)</b>. Las estimaciones
       de despacho, tiempo de agotamiento y saturación son aproximaciones basadas en la evolución del saldo.</p>`;
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
  let ymax = opts.max;
  if (opts.headroom && data.length) {                 // deja aire arriba para que las etiquetas no se corten
    const mx = Math.max(...data.map(d => (Array.isArray(d) ? d[1] : d)).filter(v => v != null));
    if (isFinite(mx) && mx > 0) ymax = Math.round(mx * opts.headroom);
  }
  c.setOption({
    grid: { left: 58, right: 16, top: opts.markLine ? 30 : 14, bottom: 36 },
    tooltip: { trigger: 'axis', confine: true,
      valueFormatter: v => (opts.kAxis ? fmtKL(v) : fmt(v) + (opts.suffix || '')), ...tipStyle() },
    xAxis: { type: 'time', show: true, axisLine: { lineStyle: { color: t.axis } }, axisLabel: { color: t.muted } },
    yAxis: { type: 'value', show: true, max: ymax,
      axisLabel: { color: t.muted, formatter: v => (opts.kAxis ? fmtK(v) : v.toLocaleString('es-BO')) },
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
  const nEst = new Set(S.latest.estaciones.map(e => e.un)).size;
  const chips = [
    { v: fmtKL(g.stock), l: 'Gasolina disponible' },
    { v: fmtKL(d.stock), l: 'Diésel disponible' },
    { v: nEst, l: 'estaciones (Biopetrol + Genex)' },
  ];
  document.getElementById('hero-stats').innerHTML = chips.map(c =>
    `<div class="hero-stat"><div class="hv">${c.v}</div><div class="hl">${c.l}</div></div>`).join('');
}

// ---------- RECOMENDACIÓN POR UBICACIÓN ----------
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Penalización (en "km equivalentes") por estado, para mezclar cercanía + disponibilidad.
const ESTADO_PENAL = { alto: 0, medio: 0.6, bajo: 2, critico: 6, seca: Infinity, sin_dato: Infinity };
function renderReco() {
  const prodEl = document.getElementById('reco-prod');
  if (prodEl) prodEl.textContent = (PRODUCTOS[S.pid] || '').toLowerCase();
  const box = document.getElementById('reco-result');
  if (!box) return;
  if (!S.pos) { box.innerHTML = ''; return; }
  const gnv = isGnv(S.pid);
  const cand = estaciones().filter(e => e.lat != null && e.lng != null)
    .map(e => ({ e, km: haversineKm(S.pos.lat, S.pos.lng, e.lat, e.lng) }))
    .filter(o => gnv ? o.e.disp : (o.e.saldo || 0) > 0 && ESTADO_PENAL[o.e.estado] !== Infinity);
  if (!cand.length) {
    box.innerHTML = `<div class="reco-empty">No encontré estaciones de ${PRODUCTOS[S.pid]} con stock cerca tuyo ahora mismo. Probá con otra marca o combustible.</div>`;
    return;
  }
  cand.sort((a, b) => (a.km + (gnv ? 0 : ESTADO_PENAL[a.e.estado])) - (b.km + (gnv ? 0 : ESTADO_PENAL[b.e.estado])));
  box.innerHTML = cand.slice(0, 3).map((o, i) => {
    const e = o.e;
    const dist = o.km < 1 ? Math.round(o.km * 1000) + ' m'
      : o.km.toLocaleString('es-BO', { maximumFractionDigits: 1 }) + ' km';
    const estado = gnv ? (e.disp ? 'GNV disponible' : 'agotado') : `${ESTADO_LABEL[e.estado]} · ${fmtKL(e.saldo)}`;
    const cola = e.cola_nivel != null ? ` · ${COLA_LABEL[e.cola_nivel]}` : '';
    const col = estadoColor(gnv ? (e.disp ? 'alto' : 'critico') : e.estado);
    return `<div class="reco-card ${i === 0 ? 'best' : ''}" data-key="${keyOf(e)}">
      <div class="reco-rank">${i === 0 ? '★' : i + 1}</div>
      <div class="reco-body">
        <div class="reco-name">${e.nombre} ${marcaPill(e)}</div>
        <div class="reco-meta"><b>${dist}</b> · <span style="color:${col}">${estado}</span>${cola}</div>
      </div>
      <a class="reco-go" target="_blank" rel="noopener" href="${gmapsUrl(e)}">Ir ↗</a>
    </div>`;
  }).join('');
  box.querySelectorAll('.reco-card').forEach(card => card.addEventListener('click', ev => {
    if (ev.target.closest('.reco-go')) return;
    selectStation(card.dataset.key, { zoom: true });
    const mapa = document.getElementById('mapa');
    if (mapa) mapa.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}
function requestLocation() {
  const btn = document.getElementById('reco-btn');
  const box = document.getElementById('reco-result');
  if (!navigator.geolocation) {
    box.innerHTML = '<div class="reco-empty">Tu navegador no soporta geolocalización.</div>';
    return;
  }
  btn.disabled = true; btn.textContent = 'Ubicando…';
  navigator.geolocation.getCurrentPosition(
    pos => {
      S.pos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      btn.disabled = false; btn.textContent = 'Actualizar ubicación';
      renderReco();
    },
    err => {
      btn.disabled = false; btn.textContent = 'Usar mi ubicación';
      box.innerHTML = `<div class="reco-empty">No pudimos obtener tu ubicación (${err.code === 1 ? 'permiso denegado' : 'intentá de nuevo'}). Podés activarla en los permisos del navegador.</div>`;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// ---------- render de toda la página ----------
function renderAll() {
  const steps = [renderHero, renderEstaciones, renderMapa, renderReco, renderResumen, renderPatrones, renderMetodologia];
  steps.forEach(fn => { try { fn(); } catch (e) { console.error('Error en', fn.name, e); } });
  setTimeout(() => Object.values(charts).forEach(c => c.resize()), 40);
}
