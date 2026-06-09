#!/usr/bin/env python3
"""
Motor de indicadores del Monitor de Saldos de Combustible.

Funciones puras (solo stdlib) que, a partir del historico de mediciones,
calculan los indicadores por estacion, los agregados de red y los patrones
hora x dia. Cada indicador esta documentado para que el dashboard pueda
mostrar su explicacion (ver INDICADORES al final).

Convencion de tiempo: TODO se maneja en hora local de Bolivia (UTC-4), que es
como la fuente reporta las mediciones. No mezclamos husos.
"""

from datetime import datetime, timedelta

# ---- Umbrales (centralizados para que el dashboard los lea de metrics.json) ----
CARGA_DEFAULT = 40.0          # litros por vehiculo si la fuente no lo da
CRIT_VEH = 50                 # < 50 vehiculos -> critico
LOW_VEH = 150                 # < 150 -> bajo
MID_VEH = 400                 # < 400 -> medio ; >= 400 -> alto
ETA_CRIT_H = 3.0              # si se agota en < 3 h, es critico aunque tenga litros
REFILL_MIN_L = 800            # un salto >= 800 L hacia arriba cuenta como recarga
REFILL_MIN_FRAC = 0.15        # ...y ademas >= 15% del saldo previo
DESPACHO_WINDOW_H = 3.0       # ventana para promediar la tasa de despacho
MAX_GAP_H = 3.0              # huecos mayores se ignoran para tasas (poco fiables)
STALE_MIN = 45               # sensor "viejo" si su ultima medicion es 45+ min mas vieja que la red


def parse_dt(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


def estado(veh, eta_h=None):
    """Semaforo hibrido: por autonomia en vehiculos Y por tiempo a agotarse.
    Una estacion con litros pero que se vacia muy rapido (ETA < 3 h) tambien es critica."""
    if veh is None:
        return "sin_dato"
    if eta_h is not None and eta_h < ETA_CRIT_H:
        return "critico"
    if veh < CRIT_VEH:
        return "critico"
    if veh < LOW_VEH:
        return "bajo"
    if veh < MID_VEH:
        return "medio"
    return "alto"


def group_series(history):
    """history: lista de dicts {un,producto_id,fecha,saldo,vehiculos}.
    Devuelve dict[(un,pid)] -> lista ordenada de (dt, saldo, veh)."""
    g = {}
    for h in history:
        try:
            dt = parse_dt(h["fecha"])
        except (ValueError, KeyError):
            continue
        key = (h["un"], h["producto_id"])
        g.setdefault(key, []).append((dt, h["saldo"], h.get("vehiculos")))
    for key in g:
        g[key].sort(key=lambda x: x[0])
        # dedup por minuto (por si hay duplicados)
        seen, out = set(), []
        for dt, s, v in g[key]:
            k = dt.replace(second=0)
            if k in seen:
                continue
            seen.add(k)
            out.append((dt, s, v))
        g[key] = out
    return g


def detect_refills(points):
    """points: [(dt,saldo,veh)] ordenado. Devuelve lista de recargas {t, delta}."""
    refills = []
    for (t1, s1, _), (t2, s2, _) in zip(points, points[1:]):
        d = s2 - s1
        if d >= REFILL_MIN_L and d >= REFILL_MIN_FRAC * max(s1, 1):
            refills.append({"t": t2.strftime("%Y-%m-%d %H:%M:%S"), "delta": int(d)})
    return refills


def despacho_rate(points, ref_dt):
    """Tasa de despacho reciente (L/h) = promedio de las caidas de saldo en la
    ventana DESPACHO_WINDOW_H antes de ref_dt. None si no hay tramos de caida."""
    rates = []
    for (t1, s1, _), (t2, s2, _) in zip(points, points[1:]):
        dt_h = (t2 - t1).total_seconds() / 3600
        if dt_h <= 0 or dt_h > MAX_GAP_H:
            continue
        if (ref_dt - t2).total_seconds() / 3600 > DESPACHO_WINDOW_H:
            continue
        if s2 < s1:
            rates.append((s1 - s2) / dt_h)
    if not rates:
        return None
    return sum(rates) / len(rates)


def station_metrics(points, attrs, global_latest_dt):
    """Calcula todos los indicadores de una estacion.
    points: [(dt,saldo,veh)] ; attrs: dict con mangueras/carga_promedio/tiempo_carga ;
    global_latest_dt: ultima medicion de toda la red (para detectar sensor viejo)."""
    if not points:
        return None
    last_dt, saldo, veh = points[-1]
    carga = attrs.get("carga_promedio") or CARGA_DEFAULT
    if veh is None:
        veh = saldo / carga
    mangueras = attrs.get("mangueras") or 0
    t_mang = attrs.get("tiempo_carga") or 0  # min por manguera

    despacho = despacho_rate(points, last_dt)
    refills = detect_refills(points)
    ultima_recarga = refills[-1] if refills else None

    # Capacidad teorica de despacho (L/h) = surtidores x (litros/veh / min-por-veh) x 60
    cap = None
    if mangueras and t_mang:
        cap = mangueras * (carga / t_mang) * 60

    # ETA a cero: solo si esta bajando
    eta_h = None
    if despacho and despacho > 0 and saldo > 0:
        eta_h = round(saldo / despacho, 1)

    # Disponibilidad de HOY
    hoy = last_dt.strftime("%Y-%m-%d")
    hoy_pts = [p for p in points if p[0].strftime("%Y-%m-%d") == hoy]
    n = len(hoy_pts) or 1
    con_stock = sum(1 for _, s, _ in hoy_pts if s > 0)
    en_crit = sum(1 for _, s, v in hoy_pts if (v if v is not None else s / carga) < CRIT_VEH)
    uptime = round(100 * con_stock / n, 1)
    pct_critico = round(100 * en_crit / n, 1)

    stale = (global_latest_dt - last_dt).total_seconds() / 60 > STALE_MIN

    return {
        "saldo": int(saldo),
        "vehiculos": round(veh, 1),
        "estado": estado(veh, eta_h),
        "fecha": last_dt.strftime("%Y-%m-%d %H:%M:%S"),
        "stale": stale,
        "despacho_lh": round(despacho) if despacho is not None else None,
        "eta_horas": eta_h,
        "saldo_por_manguera": round(saldo / mangueras) if mangueras else None,
        "capacidad_lh": round(cap) if cap else None,
        "saturacion": round(despacho / cap, 2) if (cap and despacho) else None,
        "vaciado_plena_h": round(saldo / cap, 1) if cap else None,
        "uptime_hoy": uptime,
        "pct_critico_hoy": pct_critico,
        "n_recargas_total": len(refills),
        "ultima_recarga": ultima_recarga,
        "recargas": refills[-20:],  # para marcar en el grafico
    }


def network_series(grouped, pid, max_days=14, bucket_min=60):
    """Serie agregada de red por producto, con forward-fill por bucket.
    Devuelve [{t, stock, n_con, n_crit, n_seca, n_total}]."""
    stations = {un: pts for (un, p), pts in grouped.items() if p == pid and pts}
    if not stations:
        return []
    latest = max(pts[-1][0] for pts in stations.values())
    earliest = min(pts[0][0] for pts in stations.values())
    # arranca en el primer dato real (no rellenar dias sin mediciones)
    start = max(latest - timedelta(days=max_days), earliest)

    # buckets alineados a bucket_min
    step = timedelta(minutes=bucket_min)
    t0 = start.replace(minute=0, second=0, microsecond=0)
    buckets = []
    t = t0
    while t <= latest:
        buckets.append(t)
        t += step

    out = []
    for b in buckets:
        b_end = b + step
        stock = n_con = n_crit = n_seca = n_total = 0
        for un, pts in stations.items():
            # ultima medicion <= fin del bucket
            val = None
            for dt, s, v in pts:
                if dt <= b_end:
                    val = (s, v)
                else:
                    break
            if val is None:
                continue
            s, v = val
            carga = CARGA_DEFAULT
            veh = v if v is not None else s / carga
            n_total += 1
            stock += s
            if s > 0:
                n_con += 1
            if s <= 0:
                n_seca += 1
            if veh < CRIT_VEH:
                n_crit += 1
        if n_total:
            out.append({
                "t": b.strftime("%Y-%m-%d %H:%M"),
                "stock": int(stock), "n_con": n_con,
                "n_crit": n_crit, "n_seca": n_seca, "n_total": n_total,
            })
    return out


def stacked_series(grouped, pid, stations_meta, max_days=7, bucket_min=60):
    """Stock por estacion alineado en buckets (para areas apiladas + linea total).
    Devuelve {'t': [horas], 'series': [{un, nombre, data:[saldo por bucket]}]}."""
    stations = {un: pts for (un, p), pts in grouped.items() if p == pid and pts}
    if not stations:
        return {"t": [], "series": []}
    latest = max(pts[-1][0] for pts in stations.values())
    earliest = min(pts[0][0] for pts in stations.values())
    start = max(latest - timedelta(days=max_days), earliest)
    step = timedelta(minutes=bucket_min)
    t = start.replace(minute=0, second=0, microsecond=0)
    buckets = []
    while t <= latest:
        buckets.append(t)
        t += step
    times = [b.strftime("%Y-%m-%d %H:%M") for b in buckets]
    series = []
    for un, pts in sorted(stations.items(), key=lambda kv: -kv[1][-1][1]):
        data = []
        for b in buckets:
            b_end = b + step
            val = None
            for dt, s, _ in pts:
                if dt <= b_end:
                    val = s
                else:
                    break
            data.append(val if val is not None else 0)
        meta = stations_meta.get(str(un), {})
        series.append({"un": un, "nombre": meta.get("nombre", f"UN-{un}"),
                       "marca": meta.get("marca"), "data": data})
    return {"t": times, "series": series}


def heatmap_hora_dia(net_series):
    """Promedio de % de estaciones criticas por (dia_semana, hora) -> patron tipico.
    Devuelve {'data': [[hora, dia, valor], ...], 'dias': [...]}.
    dia: 0=Lunes ... 6=Domingo."""
    from collections import defaultdict
    acc = defaultdict(lambda: [0.0, 0])
    for row in net_series:
        dt = datetime.strptime(row["t"], "%Y-%m-%d %H:%M")
        pct = 100 * row["n_crit"] / row["n_total"] if row["n_total"] else 0
        key = (dt.weekday(), dt.hour)
        acc[key][0] += pct
        acc[key][1] += 1
    data = []
    for (dia, hora), (suma, cnt) in acc.items():
        data.append([hora, dia, round(suma / cnt, 1)])
    return {"data": data, "dias": ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]}


def daily_rollups(grouped, stations_meta, days=2):
    """Resumen diario por estacion para los ultimos `days` dias."""
    from collections import defaultdict
    by_day = defaultdict(lambda: defaultdict(list))  # day -> key -> points
    all_days = set()
    for key, pts in grouped.items():
        for dt, s, v in pts:
            d = dt.strftime("%Y-%m-%d")
            by_day[d][key].append((dt, s, v))
            all_days.add(d)
    recientes = sorted(all_days)[-days:]
    out = {}
    for d in recientes:
        rows = []
        for (un, pid), pts in by_day[d].items():
            saldos = [s for _, s, _ in pts if s is not None]
            if not saldos:          # GNV u otros sin litros: no aplica resumen de saldo
                continue
            refills = detect_refills(sorted(pts))
            meta = stations_meta.get(str(un), {})
            carga = CARGA_DEFAULT
            n = len(pts)
            crit = sum(1 for _, s, v in pts if (v if v is not None else s / carga) < CRIT_VEH)
            rows.append({
                "un": un, "producto_id": pid, "nombre": meta.get("nombre", f"UN-{un}"),
                "saldo_min": min(saldos), "saldo_max": max(saldos),
                "saldo_prom": round(sum(saldos) / n),
                "n_recargas": len(refills),
                "vol_recargado": sum(r["delta"] for r in refills),
                "pct_critico": round(100 * crit / n, 1),
            })
        out[d] = rows
    return out


# ===================================================================
# Diccionario de indicadores: lo consume el dashboard para explicar cada uno.
# ===================================================================
INDICADORES = {
    "saldo": {
        "nombre": "Saldo disponible",
        "unidad": "litros",
        "desc": "Volumen de combustible que la estacion tiene en este momento, segun la ultima medicion de la fuente.",
    },
    "vehiculos": {
        "nombre": "Autonomia en vehiculos",
        "unidad": "vehiculos",
        "desc": "Cuantos vehiculos alcanza a cargar el saldo actual, asumiendo una carga promedio de 40 litros por vehiculo.",
    },
    "estado": {
        "nombre": "Estado",
        "unidad": "",
        "desc": "Semaforo hibrido: una estacion es critica si su autonomia baja de 50 vehiculos O si, al ritmo de despacho actual, se agota en menos de 3 horas. Luego: bajo (<150 veh.), medio (<400) y alto (>=400).",
    },
    "despacho_lh": {
        "nombre": "Tasa de despacho",
        "unidad": "litros/hora",
        "desc": "Velocidad a la que se esta vaciando el tanque, calculada con la caida del saldo en las ultimas horas. Es un proxy de la demanda real.",
    },
    "eta_horas": {
        "nombre": "Tiempo hasta agotarse",
        "unidad": "horas",
        "desc": "Proyeccion de cuanto durara el saldo al ritmo de despacho actual (saldo / tasa de despacho). Solo aplica si la estacion esta bajando.",
    },
    "saldo_por_manguera": {
        "nombre": "Saldo por surtidor",
        "unidad": "litros/manguera",
        "desc": "Saldo dividido entre el numero de mangueras. Mide mejor que el saldo bruto cuanta cola puede atender cada punto de carga.",
    },
    "capacidad_lh": {
        "nombre": "Capacidad teorica de despacho",
        "unidad": "litros/hora",
        "desc": "Maximo que la estacion podria despachar: mangueras x (litros por vehiculo / minutos por vehiculo) x 60.",
    },
    "saturacion": {
        "nombre": "Indice de saturacion",
        "unidad": "ratio 0-1",
        "desc": "Despacho observado dividido por la capacidad teorica. Cerca de 1 significa que la estacion opera al limite.",
    },
    "vaciado_plena_h": {
        "nombre": "Vaciado a plena demanda",
        "unidad": "horas",
        "desc": "Cuanto duraria el saldo si la estacion despachara a su capacidad maxima sin parar.",
    },
    "uptime_hoy": {
        "nombre": "Disponibilidad hoy",
        "unidad": "%",
        "desc": "Porcentaje de las mediciones de hoy en las que la estacion tuvo combustible (saldo > 0).",
    },
    "pct_critico_hoy": {
        "nombre": "Tiempo en critico hoy",
        "unidad": "%",
        "desc": "Porcentaje de las mediciones de hoy en estado critico (autonomia menor a 50 vehiculos).",
    },
    "ultima_recarga": {
        "nombre": "Ultima recarga",
        "unidad": "fecha / litros",
        "desc": "Momento y volumen del ultimo reabastecimiento detectado (un salto del saldo hacia arriba). Buen indicio de cuando conviene ir.",
    },
    "stock_red": {
        "nombre": "Stock total de la red",
        "unidad": "litros",
        "desc": "Suma del saldo de todas las estaciones de un combustible. El gran indicador de coyuntura de la ciudad.",
    },
    "estres_red": {
        "nombre": "Indice de estres de la red",
        "unidad": "% estaciones criticas",
        "desc": "Porcentaje de estaciones en estado critico o secas. Mide la tension del abastecimiento en toda la ciudad.",
    },
    "stale": {
        "nombre": "Dato desactualizado",
        "unidad": "",
        "desc": "El sensor de esta estacion no reporta hace mas de 45 minutos; el saldo mostrado puede no ser confiable.",
    },
    "cola": {
        "nombre": "Cola de vehiculos",
        "unidad": "nivel",
        "desc": "Longitud de la fila que reporta Genex para ese surtidor: sin cola, poca, hay o mucha cola. Es un indicio directo de la demanda en sitio (Biopetrol no lo publica).",
    },
    "disponibilidad": {
        "nombre": "Disponibilidad de GNV",
        "unidad": "disponible / agotado",
        "desc": "Para el gas natural vehicular la fuente no reporta litros, solo si la estacion tiene GNV disponible o agotado. Por eso el GNV se muestra como mapa de disponibilidad y no con saldos.",
    },
}
