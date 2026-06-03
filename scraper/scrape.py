#!/usr/bin/env python3
"""
Scraper de la Guia Biopetrol (saldos de combustible, Santa Cruz - Bolivia).

Fuente: http://ec2-3-22-240-207.us-east-2.compute.amazonaws.com/guiasaldos/main/donde/<producto_id>
Productos con existencia: 134 = GASOLINA ESPECIAL, 132 = DIESEL.

Solo usa la libreria estandar para correr en GitHub Actions sin instalar nada.

Genera / actualiza, en ../data:
  - stations.json   maestro geo: un -> {nombre, direccion, lat, lng}
  - latest.json     ultimo estado de cada estacion/producto (se sobreescribe)
  - history.jsonl   una linea por MEDICION nueva (dedup por un+producto+fecha)
  - series.json     serie temporal compacta para los graficos del dashboard
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "http://ec2-3-22-240-207.us-east-2.compute.amazonaws.com/guiasaldos/main/donde/"
PRODUCTOS = {
    "134": "GASOLINA ESPECIAL",
    "132": "DIESEL",
}

# Bolivia = UTC-4 (la fuente reporta hora local de Santa Cruz)
TZ_BO = timezone(timedelta(hours=-4))

HERE = os.path.dirname(os.path.abspath(__file__))
# La data vive dentro de docs/ para que GitHub Pages (source = /docs) la sirva.
DATA = os.path.normpath(os.path.join(HERE, "..", "docs", "data"))


def fetch(producto_id: str) -> str:
    url = BASE + producto_id
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (guia-saldos-monitor)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    # El servidor a veces emite bytes mal etiquetados; utf-8 tolerante.
    return raw.decode("utf-8", errors="replace")


def parse(html: str, producto_id: str) -> list[dict]:
    """Divide el HTML por bloque de estacion (cada bloque empieza con var_dump array(5))."""
    chunks = html.split("array(5) {")
    out = []
    for chunk in chunks[1:]:  # el primer trozo es la cabecera de la pagina
        rec = parse_chunk(chunk, producto_id)
        if rec:
            out.append(rec)
    return out


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def parse_chunk(chunk: str, producto_id: str) -> dict | None:
    m_id = re.search(r'\["id"\]=>\s*int\((\d+)\)', chunk)
    m_un = re.search(r'\["un"\]=>\s*int\((\d+)\)', chunk)
    m_pid = re.search(r'\["producto_id"\]=>\s*int\((\d+)\)', chunk)
    m_fecha = re.search(r'\["fecha"\]=>\s*string\(\d+\)\s*"([^"]+)"', chunk)
    m_saldo = re.search(r'\["saldo"\]=>\s*string\(\d+\)\s*"(\d+)"', chunk)
    if not (m_un and m_saldo and m_fecha):
        return None

    def attr(label):
        m = re.search(re.escape(label) + r":\s*([0-9.]+)", chunk)
        return _num(m.group(1)) if m else None

    # Nombre: viene justo despues de "cantidad de vehiculos: X" y antes de "Volumen disponible"
    txt = re.sub(r"<[^>]+>", " ", chunk)
    txt = re.sub(r"&nbsp;", " ", txt)
    txt = re.sub(r"\s+", " ", txt)
    m_name = re.search(r"cantidad de vehiculos:\s*[0-9.]+\s+(.+?)\s+Volumen disponible", txt)
    nombre = m_name.group(1).strip() if m_name else f"UN-{m_un.group(1)}"

    # Direccion: en el div <div class="px-1 col-12">DIRECCION</div>
    m_dir = re.search(r'class="px-1 col-12">([^<]+)</div>', chunk)
    direccion = m_dir.group(1).strip() if m_dir else ""

    # Coordenadas del embed de Google Maps: !2d<lng>!3d<lat>
    m_geo = re.search(r"!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)", chunk)
    lng = _num(m_geo.group(1)) if m_geo else None
    lat = _num(m_geo.group(2)) if m_geo else None

    return {
        "un": int(m_un.group(1)),
        "producto_id": int(producto_id),
        "producto": PRODUCTOS.get(producto_id, producto_id),
        "nombre": nombre,
        "direccion": direccion,
        "lat": lat,
        "lng": lng,
        "fecha": m_fecha.group(1),
        "saldo": int(m_saldo.group(1)),
        "mangueras": attr("mangueras"),
        "carga_promedio": attr("carga promedio"),
        "vehiculos": attr("cantidad de vehiculos"),
        "tiempo_carga": attr("tiempo de carga por manguera"),
        "_id": int(m_id.group(1)) if m_id else None,
    }


def load_json(name, default):
    p = os.path.join(DATA, name)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return default


def write_json(name, obj):
    p = os.path.join(DATA, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def main():
    os.makedirs(DATA, exist_ok=True)
    now_iso = datetime.now(TZ_BO).strftime("%Y-%m-%d %H:%M:%S")

    records = []
    for pid in PRODUCTOS:
        try:
            html = fetch(pid)
            recs = parse(html, pid)
            print(f"producto {pid} ({PRODUCTOS[pid]}): {len(recs)} estaciones")
            records.extend(recs)
        except Exception as e:  # noqa: BLE001
            print(f"ERROR producto {pid}: {e}", file=sys.stderr)

    if not records:
        print("Sin datos; abortando para no pisar archivos.", file=sys.stderr)
        sys.exit(1)

    # ---- stations.json (maestro geo) ----
    stations = load_json("stations.json", {})
    for r in records:
        key = str(r["un"])
        prev = stations.get(key, {})
        stations[key] = {
            "un": r["un"],
            "nombre": r["nombre"],
            "direccion": r["direccion"] or prev.get("direccion", ""),
            "lat": r["lat"] if r["lat"] is not None else prev.get("lat"),
            "lng": r["lng"] if r["lng"] is not None else prev.get("lng"),
        }
    write_json("stations.json", stations)

    # ---- latest.json ----
    latest = {
        "actualizado": now_iso,
        "estaciones": [
            {k: r[k] for k in (
                "un", "producto_id", "producto", "nombre", "direccion",
                "lat", "lng", "fecha", "saldo", "mangueras", "vehiculos")}
            for r in records
        ],
    }
    write_json("latest.json", latest)

    # ---- history.jsonl (dedup por un+producto+fecha de MEDICION) ----
    seen = set()
    hist_path = os.path.join(DATA, "history.jsonl")
    if os.path.exists(hist_path):
        with open(hist_path, encoding="utf-8") as f:
            for line in f:
                try:
                    h = json.loads(line)
                    seen.add((h["un"], h["producto_id"], h["fecha"]))
                except (json.JSONDecodeError, KeyError):
                    continue
    nuevos = 0
    with open(hist_path, "a", encoding="utf-8") as f:
        for r in records:
            sig = (r["un"], r["producto_id"], r["fecha"])
            if sig in seen:
                continue
            seen.add(sig)
            f.write(json.dumps({
                "un": r["un"], "producto_id": r["producto_id"],
                "fecha": r["fecha"], "saldo": r["saldo"],
                "vehiculos": r["vehiculos"],
            }, ensure_ascii=False) + "\n")
            nuevos += 1
    print(f"history.jsonl: +{nuevos} mediciones nuevas")

    # ---- series.json (compacta para el dashboard) ----
    rebuild_series(hist_path)
    print(f"OK {now_iso}")


def rebuild_series(hist_path):
    """Agrupa el historico por estacion+producto en series ordenadas por fecha."""
    series = {}
    with open(hist_path, encoding="utf-8") as f:
        for line in f:
            try:
                h = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = f'{h["un"]}-{h["producto_id"]}'
            series.setdefault(key, []).append([h["fecha"], h["saldo"]])
    for key in series:
        series[key].sort(key=lambda x: x[0])
    write_json("series.json", series)


if __name__ == "__main__":
    main()
