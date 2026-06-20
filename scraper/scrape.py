#!/usr/bin/env python3
"""
Scraper + pipeline de indicadores de la Guia Biopetrol (saldos de combustible,
Santa Cruz - Bolivia).

Fuente: http://ec2-3-22-240-207.us-east-2.compute.amazonaws.com/guiasaldos/main/donde/<producto_id>
Productos con existencia: 134 = GASOLINA ESPECIAL, 132 = DIESEL.

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
import re
import sys
import urllib.request
from datetime import datetime, timedelta

import metrics as M
import genex

BASE = "http://ec2-3-22-240-207.us-east-2.compute.amazonaws.com/guiasaldos/main/donde/"
# Productos que publica Biopetrol (su fuente solo expone gasolina especial y diesel).
BIO_PRODUCTOS = {"134": "GASOLINA ESPECIAL", "132": "DIESEL"}
# Catalogo unificado del monitor (Biopetrol + Genex).
#   134/132/200 se miden en litros (serie + semaforo completos).
#   300 = GNV: la fuente solo da disponible/agotado (vista de disponibilidad, sin litros).
PRODUCTOS = {"134": "GASOLINA ESPECIAL", "132": "DIESEL",
             "200": "GASOLINA PREMIUM", "300": "GNV"}
LITER_PRODUCTS = ("134", "132", "200")
GNV_PID = 300

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "docs", "data"))
HIST = os.path.join(DATA, "history")
RECENT_HOURS = 72


# --------------------------- fetch & parse ---------------------------
def fetch(producto_id):
    req = urllib.request.Request(BASE + producto_id,
                                 headers={"User-Agent": "Mozilla/5.0 (combustibles-monitor)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def parse(html, producto_id):
    return [r for c in html.split("array(5) {")[1:] if (r := parse_chunk(c, producto_id))]


def parse_chunk(chunk, producto_id):
    m_un = re.search(r'\["un"\]=>\s*int\((\d+)\)', chunk)
    m_fecha = re.search(r'\["fecha"\]=>\s*string\(\d+\)\s*"([^"]+)"', chunk)
    # La fuente publica "saldo" a veces como string ("123") y a veces como int(123);
    # aceptamos ambos para no romper si vuelve a cambiar de tipo.
    m_saldo = re.search(r'\["saldo"\]=>\s*(?:string\(\d+\)\s*"(\d+)"|int\((\d+)\))', chunk)
    if not (m_un and m_saldo and m_fecha):
        return None
    saldo = int(m_saldo.group(1) or m_saldo.group(2))

    def attr(label):
        m = re.search(re.escape(label) + r":\s*([0-9.]+)", chunk)
        return _num(m.group(1)) if m else None

    txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", chunk).replace("&nbsp;", " "))
    m_name = re.search(r"cantidad de vehiculos:\s*[0-9.]+\s+(.+?)\s+Volumen disponible", txt)
    nombre = m_name.group(1).strip() if m_name else f"UN-{m_un.group(1)}"
    m_dir = re.search(r'class="px-1 col-12">([^<]+)</div>', chunk)
    direccion = m_dir.group(1).strip() if m_dir else ""
    m_geo = re.search(r"!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)", chunk)
    lng = _num(m_geo.group(1)) if m_geo else None
    lat = _num(m_geo.group(2)) if m_geo else None

    carga = attr("carga promedio") or M.CARGA_DEFAULT
    return {
        "un": int(m_un.group(1)), "producto_id": int(producto_id),
        "producto": PRODUCTOS.get(producto_id, producto_id),
        "nombre": nombre, "direccion": direccion, "lat": lat, "lng": lng,
        "fecha": m_fecha.group(1), "saldo": saldo,
        "mangueras": attr("mangueras"), "carga_promedio": carga,
        "vehiculos": round(saldo / carga, 1),
        "tiempo_carga": attr("tiempo de carga por manguera"),
    }


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

    # ---- Biopetrol ----
    for pid in BIO_PRODUCTOS:
        try:
            recs = parse(fetch(pid), pid)
            print(f"biopetrol producto {pid} ({BIO_PRODUCTOS[pid]}): {len(recs)} estaciones")
            if not recs:
                print(f"ADVERTENCIA: biopetrol producto {pid} devolvió 0 estaciones "
                      f"(¿cambió el formato de la fuente?)", file=sys.stderr)
            for r in recs:
                r["marca"] = "biopetrol"
                r["ciudad"] = "Santa Cruz"
                r["cola"] = None
                r["cola_nivel"] = None
                r["disp"] = 1 if (r.get("saldo") or 0) > 0 else 0
            records.extend(recs)
        except Exception as e:  # noqa: BLE001
            print(f"ERROR biopetrol producto {pid}: {e}", file=sys.stderr)

    # ---- Genex ----
    try:
        grecs = genex.scrape()
        print(f"genex: {len(grecs)} records de {len(set(r['un'] for r in grecs))} estaciones")
        if not grecs:
            print("ADVERTENCIA: genex devolvió 0 records (¿cambió el formato de la web?)",
                  file=sys.stderr)
        records.extend(grecs)
    except Exception as e:  # noqa: BLE001
        print(f"ERROR genex: {e}", file=sys.stderr)

    if not records:
        print("Sin datos de ninguna fuente; abortando para no pisar archivos.", file=sys.stderr)
        sys.exit(1)

    actualizado = max(r["fecha"] for r in records)

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
    nuevos = append_measurements(records)
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
            "eta_horas": m.get("eta_horas"), "stale": m.get("stale", False),
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

    print(f"OK actualizado={actualizado} | estaciones={len(estaciones)} | hist={len(history)}")


if __name__ == "__main__":
    main()
