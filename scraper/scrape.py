#!/usr/bin/env python3
"""
Scraper + pipeline de indicadores del Monitor de Saldos de Combustible
(Biopetrol + Genex, Santa Cruz - Bolivia).

Fuentes (cada una en su propio adaptador, mismo esquema de record):
  - biopetrol.py -> https://app9.biocloud.info/saldos/main/donde/<pid>
  - genex.py     -> https://genex.com.bo/estaciones/...
Productos: 134 = GASOLINA ESPECIAL, 132 = DIESEL, 200 = PREMIUM, 300 = GNV.

Solo usa la libreria estandar (corre en GitHub Actions sin instalar nada).

Genera en docs/data:
  stations.json      maestro geo: un -> {nombre, direccion, lat, lng}
  latest.json        snapshot actual de cada estacion + estado
  metrics.json       indicadores por estacion + red + umbrales + diccionario de ayuda
  series_recent.json serie de saldo de las ultimas 72 h por estacion (para graficos)
  red_series.json    serie agregada de red por producto (stock, % critico, ...)
  heatmap.json       patron hora x dia de estres por producto
  daily.json         resumen diario por estacion (ultimos 2 dias)
  history/YYYY-MM-DD.jsonl   historico crudo particionado por dia (dedup por medicion)
"""

import json
import os
import sys
from datetime import datetime, timedelta

import metrics as M
import genex
import biopetrol

# Catalogo unificado del monitor (Biopetrol + Genex).
#   134/132/200 se miden en litros (serie + semaforo completos).
#   300 = GNV: la fuente solo da disponible/agotado (vista de disponibilidad, sin litros).
PRODUCTOS = {"134": "GASOLINA ESPECIAL", "132": "DIESEL",
             "200": "GASOLINA PREMIUM", "300": "GNV"}
LITER_PRODUCTS = ("134", "132", "200")
GNV_PID = 300
# Una marca lleva "rancia" (outage silencioso que hay que gritar) si su ultimo dato
# real supera estas horas. El carry-forward la mantiene visible mientras tanto.
STALE_ALERT_H = 6
# Tope de edad del carry-forward: una estacion que la fuente dejo de listar se conserva
# como "dato viejo" hasta este limite; pasado eso se DESCARTA del mapa (mostrar litros
# de hace dias es enganoso). Un blip de horas se tolera; un outage de dias, no.
CARRY_MAX_H = 48

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "docs", "data"))
HIST = os.path.join(DATA, "history")
RECENT_HOURS = 72


# --------------------------- io helpers ---------------------------
def load_json(name, default):
    p = os.path.join(DATA, name)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return default


def write_json(name, obj):
    p = os.path.join(DATA, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def migrate_old_history():
    """Reparte el viejo history.jsonl monolitico en particiones por dia."""
    old = os.path.join(DATA, "history.jsonl")
    if not os.path.exists(old):
        return
    os.makedirs(HIST, exist_ok=True)
    by_day = {}
    with open(old, encoding="utf-8") as f:
        for line in f:
            try:
                h = json.loads(line)
                by_day.setdefault(h["fecha"][:10], []).append(line.rstrip("\n"))
            except (json.JSONDecodeError, KeyError):
                continue
    for day, lines in by_day.items():
        with open(os.path.join(HIST, f"{day}.jsonl"), "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    os.remove(old)
    print(f"migrado history.jsonl -> {len(by_day)} particiones")


def append_measurements(records):
    """Agrega mediciones nuevas a la particion del dia (dedup por un+pid+fecha)."""
    os.makedirs(HIST, exist_ok=True)
    nuevos = 0
    by_day = {}
    for r in records:
        by_day.setdefault(r["fecha"][:10], []).append(r)
    for day, recs in by_day.items():
        path = os.path.join(HIST, f"{day}.jsonl")
        seen = set()
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    try:
                        h = json.loads(line)
                        seen.add((h["un"], h["producto_id"], h["fecha"]))
                    except (json.JSONDecodeError, KeyError):
                        continue
        with open(path, "a", encoding="utf-8") as f:
            for r in recs:
                sig = (r["un"], r["producto_id"], r["fecha"])
                if sig in seen:
                    continue
                seen.add(sig)
                f.write(json.dumps({"un": r["un"], "producto_id": r["producto_id"],
                                    "fecha": r["fecha"], "saldo": r["saldo"],
                                    "vehiculos": r["vehiculos"]}, ensure_ascii=False) + "\n")
                nuevos += 1
    return nuevos


def load_history(days=20):
    """Carga el historico crudo de las ultimas `days` particiones."""
    if not os.path.isdir(HIST):
        return []
    files = sorted(f for f in os.listdir(HIST) if f.endswith(".jsonl"))[-days:]
    out = []
    for fn in files:
        with open(os.path.join(HIST, fn), encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return out


def marca_breakdown(actuales, gnv=False):
    """Desglosa un agregado de red por marca (biopetrol/genex) para el filtro de marca."""
    out = {}
    for marca in ("biopetrol", "genex"):
        sub = [e for e in actuales if e.get("marca") == marca]
        n = len(sub)
        if not n:
            continue
        if gnv:
            n_disp = sum(1 for e in sub if e.get("disp"))
            out[marca] = {"n_total": n, "n_disp": n_disp, "n_agotado": n - n_disp,
                          "estres": round(100 * (n - n_disp) / n, 1)}
        else:
            n_crit = sum(1 for e in sub if e["estado"] == "critico")
            out[marca] = {
                "n_total": n, "stock": sum((e["saldo"] or 0) for e in sub),
                "n_con": sum(1 for e in sub if (e["saldo"] or 0) > 0),
                "n_critico": n_crit, "vehiculos": round(sum((e["vehiculos"] or 0) for e in sub)),
                "estres": round(100 * n_crit / n, 1),
            }
    return out


# --------------------------- main ---------------------------
def main():
    os.makedirs(DATA, exist_ok=True)

    records = []
    fresh_por_marca = {}          # marca -> nº de estaciones con dato FRESCO este ciclo

    # ---- Fuentes (cada adaptador devuelve records ya normalizados) ----
    for marca, adapter in (("biopetrol", biopetrol.scrape), ("genex", genex.scrape)):
        try:
            recs = adapter()
        except Exception as e:  # noqa: BLE001
            print(f"ERROR {marca}: {e}", file=sys.stderr)
            recs = []
        est = len({(r["un"], r["producto_id"]) for r in recs})
        fresh_por_marca[marca] = est
        print(f"{marca}: {len(recs)} records de {len(set(r['un'] for r in recs))} estaciones")
        if not recs:
            print(f"ADVERTENCIA: {marca} devolvió 0 records "
                  f"(fuente caída o cambio de formato).", file=sys.stderr)
        records.extend(recs)

    # ---- Carry-forward POR ESTACION ----
    # Cualquier estacion (un,producto_id) que aparecio en el ultimo snapshot pero NO vino
    # con dato valido este ciclo (fuente caida, blip, centinela, o que la fuente dejo de
    # listarla por estar agotada) se conserva desde latest.json marcada como "dato viejo",
    # para que no desaparezca del mapa ni se pise con ceros. La serie/metrics no se tocan
    # (siguen leyendo el historico real); solo repoblamos el snapshot actual.
    prev = load_json("latest.json", {}).get("estaciones", [])
    presentes = {(r["un"], r["producto_id"]) for r in records}
    # Reloj de referencia = dato mas fresco de este ciclo (aqui todo en records es fresco).
    ref_fresh = M.parse_dt(max(r["fecha"] for r in records)) if records else None
    carried_por_marca = {}
    dropped = 0
    for e in prev:
        key = (e.get("un"), e.get("producto_id"))
        if key in presentes:
            continue
        if ref_fresh is not None and e.get("fecha"):
            age_h = (ref_fresh - M.parse_dt(e["fecha"])).total_seconds() / 3600
            if age_h > CARRY_MAX_H:
                dropped += 1          # demasiado viejo: se descarta (no se muestra litros rancios)
                continue
        e = dict(e)
        e["_carried"] = True
        records.append(e)
        carried_por_marca[e.get("marca")] = carried_por_marca.get(e.get("marca"), 0) + 1
    for marca, n in carried_por_marca.items():
        print(f"carry-forward {marca}: {n} estaciones del último snapshot real "
              f"(marcadas 'dato viejo')", file=sys.stderr)
    if dropped:
        print(f"descartadas {dropped} estaciones con carry-forward > {CARRY_MAX_H} h "
              f"(dato demasiado viejo para mostrar)", file=sys.stderr)

    if not records:
        print("Sin datos de ninguna fuente; abortando para no pisar archivos.", file=sys.stderr)
        sys.exit(1)

    # La marca de referencia para el reloj es la que trajo dato fresco (evita que un
    # carry-forward viejo fije el 'actualizado' de toda la red hacia atras).
    frescas = [r["fecha"] for r in records if not r.get("_carried")]
    actualizado = max(frescas) if frescas else max(r["fecha"] for r in records)

    # ---- maestro geo ----
    stations = load_json("stations.json", {})
    # Backfill: antes de Genex toda estacion era Biopetrol/Santa Cruz.
    for s in stations.values():
        s.setdefault("marca", "biopetrol")
        s.setdefault("ciudad", "Santa Cruz")
    for r in records:
        k = str(r["un"])
        prev = stations.get(k, {})
        stations[k] = {
            "un": r["un"], "nombre": r["nombre"], "marca": r["marca"],
            "ciudad": r.get("ciudad") or prev.get("ciudad", ""),
            "direccion": r["direccion"] or prev.get("direccion", ""),
            "lat": r["lat"] if r["lat"] is not None else prev.get("lat"),
            "lng": r["lng"] if r["lng"] is not None else prev.get("lng"),
        }
    write_json("stations.json", stations)

    # ---- historico crudo ----
    migrate_old_history()
    # Las estaciones carry-forward NO se escriben al histórico (su medición real ya está);
    # solo sirven para repoblar el snapshot actual.
    nuevos = append_measurements([r for r in records if not r.get("_carried")])
    print(f"mediciones nuevas: +{nuevos}")
    history = load_history()

    # ---- indicadores ----
    grouped = M.group_series(history)
    attrs_by_key = {(r["un"], r["producto_id"]): r for r in records}
    global_latest = M.parse_dt(actualizado)

    est_metrics = {}
    for key, pts in grouped.items():
        un, pid = key
        attrs = attrs_by_key.get(key)
        if pid == GNV_PID:
            # GNV: no hay litros; el "estado" es disponibilidad.
            if not attrs:
                continue
            est_metrics[f"{un}-{pid}"] = {
                "estado": "alto" if attrs.get("disp") else "seca",
                "disp": attrs.get("disp"), "cola": attrs.get("cola"),
                "cola_nivel": attrs.get("cola_nivel"), "fecha": attrs.get("fecha"),
                "stale": False, "marca": attrs.get("marca"),
            }
            continue
        m = M.station_metrics(pts, attrs or {}, global_latest)
        if m:
            if attrs:
                m["marca"] = attrs.get("marca")
                m["cola"] = attrs.get("cola")
                m["cola_nivel"] = attrs.get("cola_nivel")
            est_metrics[f"{un}-{pid}"] = m

    # snapshot actual (latest.json) enriquecido con estado
    estaciones = []
    for r in records:
        key = f'{r["un"]}-{r["producto_id"]}'
        m = est_metrics.get(key, {})
        if r["producto_id"] == GNV_PID:
            estado = "alto" if r.get("disp") else "seca"
        else:
            estado = m.get("estado", M.estado(r["vehiculos"]))
        estaciones.append({
            "un": r["un"], "producto_id": r["producto_id"], "producto": r["producto"],
            "marca": r["marca"], "ciudad": r.get("ciudad", ""),
            "nombre": r["nombre"], "direccion": r["direccion"],
            "lat": r["lat"], "lng": r["lng"], "fecha": r["fecha"],
            "saldo": r["saldo"], "vehiculos": r["vehiculos"],
            "mangueras": r["mangueras"], "estado": estado,
            "eta_horas": m.get("eta_horas"),
            "stale": True if r.get("_carried") else m.get("stale", False),
            "cola": r.get("cola"), "cola_nivel": r.get("cola_nivel"), "disp": r.get("disp"),
        })
    write_json("latest.json", {"actualizado": actualizado, "tz": "America/La_Paz (UTC-4)",
                               "estaciones": estaciones})

    # series recientes (72 h) por estacion
    corte = global_latest - timedelta(hours=RECENT_HOURS)
    series = {}
    for (un, pid), pts in grouped.items():
        if pid == GNV_PID:        # el GNV no tiene serie de litros
            continue
        s = [[dt.strftime("%Y-%m-%d %H:%M:%S"), saldo]
             for dt, saldo, _ in pts if dt >= corte and saldo is not None]
        if s:
            series[f"{un}-{pid}"] = s
    write_json("series_recent.json", series)

    # red por producto + heatmap + rollups + apilado por estacion
    red, red_series, heat, stacked = {}, {}, {}, {}
    for pid_s, nombre in PRODUCTOS.items():
        pid = int(pid_s)
        actuales = [e for e in estaciones if e["producto_id"] == pid]
        n = len(actuales)
        if pid == GNV_PID:
            # GNV: agregado de disponibilidad (sin litros / series).
            n_disp = sum(1 for e in actuales if e.get("disp"))
            red[pid_s] = {
                "producto": nombre, "tipo": "gnv", "n_total": n,
                "n_disp": n_disp, "n_agotado": n - n_disp,
                "estres": round(100 * (n - n_disp) / n, 1) if n else 0,
                "por_marca": marca_breakdown(actuales, gnv=True),
            }
            continue
        ns = M.network_series(grouped, pid)
        red_series[pid_s] = ns
        heat[pid_s] = M.heatmap_hora_dia(ns)
        stacked[pid_s] = M.stacked_series(grouped, pid, stations)
        red[pid_s] = {
            "producto": nombre, "tipo": "litros", "n_total": n,
            "stock": sum((e["saldo"] or 0) for e in actuales),
            "n_con": sum(1 for e in actuales if (e["saldo"] or 0) > 0),
            "n_critico": sum(1 for e in actuales if e["estado"] == "critico"),
            "n_seca": sum(1 for e in actuales if (e["saldo"] or 0) <= 0),
            "vehiculos": round(sum((e["vehiculos"] or 0) for e in actuales)),
            "estres": round(100 * sum(1 for e in actuales if e["estado"] == "critico") / n, 1) if n else 0,
            "por_marca": marca_breakdown(actuales, gnv=False),
        }
    write_json("red_series.json", red_series)
    write_json("stock_stacked.json", stacked)
    write_json("heatmap.json", heat)
    write_json("daily.json", M.daily_rollups(grouped, stations))

    write_json("metrics.json", {
        "actualizado": actualizado, "tz": "America/La_Paz (UTC-4)",
        "umbrales": {"crit_veh": M.CRIT_VEH, "low_veh": M.LOW_VEH, "mid_veh": M.MID_VEH,
                     "stale_min": M.STALE_MIN},
        "productos": PRODUCTOS, "gnv_pid": GNV_PID, "liter_products": list(LITER_PRODUCTS),
        "red": red, "estaciones": est_metrics, "indicadores": M.INDICADORES,
    })

    # ---- Health check: que un outage silencioso deje de enmascararse ----
    # (Biopetrol estuvo 2 semanas caido y el job "pasaba" porque Genex si traia datos.)
    # Reloj de referencia = dato mas fresco de la red; una marca esta en ALERTA si no
    # trajo ninguna estacion fresca este ciclo o si su ultimo dato real supera el umbral.
    ref = M.parse_dt(actualizado)
    salud = {}
    alertas = []
    for marca in ("biopetrol", "genex"):
        marca_recs = [r for r in records if r.get("marca") == marca]
        if not marca_recs:
            continue
        last_real = max(r["fecha"] for r in marca_recs)
        age_h = round((ref - M.parse_dt(last_real)).total_seconds() / 3600, 1)
        fresh = fresh_por_marca.get(marca, 0)
        # Alerta SOLO por antiguedad sostenida (>umbral), no por un ciclo suelto en 0:
        # un blip (fuente devuelve 0 este ciclo) lo cubre el carry-forward y su ultimo
        # dato real sigue reciente -> age_h chico -> sin falsa alarma. Solo un outage
        # real (fuente caida/migrada) hace crecer age_h por encima del umbral.
        alerta = age_h > STALE_ALERT_H
        salud[marca] = {"estaciones_frescas": fresh, "ultimo_dato_real": last_real,
                        "antiguedad_h": age_h, "alerta": alerta}
        if alerta:
            msg = (f"{marca.upper()} con dato rancio: ultimo real hace {age_h} h "
                   f"({last_real}); mostrando 'dato viejo'")
            alertas.append(msg)
            # ::warning:: -> anotacion visible en la UI de GitHub Actions
            print(f"::warning::{msg}")
            print(f"ALERTA SALUD: {msg}", file=sys.stderr)
    write_json("health.json", {"actualizado": actualizado, "tz": "America/La_Paz (UTC-4)",
                               "umbral_alerta_h": STALE_ALERT_H, "marcas": salud,
                               "alertas": alertas})

    print(f"OK actualizado={actualizado} | estaciones={len(estaciones)} | "
          f"hist={len(history)} | salud={ {m: v['alerta'] for m, v in salud.items()} }")


if __name__ == "__main__":
    main()
