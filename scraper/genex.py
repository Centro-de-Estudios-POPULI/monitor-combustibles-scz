#!/usr/bin/env python3
"""
Adaptador de la red GENEX para el Monitor de Saldos de Combustible.

Fuente: tabla "WooCommerce Product Table" (wcpt) que GENEX publica, renderizada
en el servidor (se raspa con urllib, sin ejecutar JS):
  https://genex.com.bo/estaciones/?3142_tax_product_tag%5B0%5D=314&3142_filtered=true&3142_orderby=option_1

Cada estacion es una fila con:
  .station_name / .station_address / .station_map (link maps.app.goo.gl) /
  .station_updated ("DD/MM/YY h:mm am/pm", hora Bolivia) y 1+ productos
  (.product_name / .product_volume "25.397 litros" o "[AGOTADO]"/"[DISPONIBLE]" /
   .product_queue_label "Poca cola").

GENEX no expone un id numerico ni coordenadas embebidas: usamos un registro
estatico (genex_stations.json) que mapea cada estacion a un `un` sintetico
estable (9001+), sus coordenadas y su ciudad.

Devuelve records con el MISMO esquema que el adaptador Biopetrol mas los campos
extra `marca`, `ciudad`, `cola`, `cola_nivel`, `disp` (este ultimo para el GNV,
que la fuente solo reporta como disponible/agotado, sin litros).

Solo libreria estandar (corre en GitHub Actions sin instalar nada).
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime

URL = ("https://genex.com.bo/estaciones/?3142_tax_product_tag%5B0%5D=314"
       "&3142_filtered=true&3142_orderby=option_1")

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY_PATH = os.path.join(HERE, "genex_stations.json")

# nombre de producto en la web -> (producto_id interno, carga promedio L/veh)
# 300 = GNV: la fuente NO da litros (solo disponible/agotado) -> carga None.
PRODUCT_MAP = {
    "G. ESPECIAL+": ("134", 40.0),
    "G. PREMIUM+":  ("200", 40.0),
    "DIESEL+":      ("132", 250.0),
    "GAS":          ("300", None),
}
PRODUCTO_NOMBRE = {"134": "GASOLINA ESPECIAL", "132": "DIESEL",
                   "200": "GASOLINA PREMIUM", "300": "GNV"}

COLA_NIVEL = {"no hay cola": 0, "poca cola": 1, "hay cola": 2, "mucha cola": 3}


def fetch():
    req = urllib.request.Request(URL, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) combustibles-monitor"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")


def _clean(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip() if s else None


def _parse_volume(raw):
    """Devuelve (saldo, disp). saldo en litros o None; disp = 1/0/None."""
    if not raw:
        return None, None
    up = raw.upper()
    if "AGOTADO" in up:
        return 0, 0
    if "DISPONIBLE" in up:        # GNV con stock, sin cifra de litros
        return None, 1
    digits = re.sub(r"[^\d]", "", raw)   # "25.397 litros" -> "25397"
    if digits:
        return int(digits), 1
    return None, None


def _parse_dt(raw):
    """'08/06/26 8:51 pm' -> '2026-06-08 20:51:00' (hora Bolivia)."""
    if not raw:
        return None
    s = raw.strip().upper().replace("A. M.", "AM").replace("P. M.", "PM")
    try:
        return datetime.strptime(s, "%d/%m/%y %I:%M %p").strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def _blocks(html):
    """Trocea el HTML en bloques por estacion. La web repite cada estacion en
    varias zonas (filtro/grilla/tabla); nos quedamos, por nombre, con el bloque
    que trae mas productos (el de la tabla de datos)."""
    positions = [m.start() for m in re.finditer(r'class="station_name"', html)]
    best = {}
    for i, pos in enumerate(positions):
        end = positions[i + 1] if i + 1 < len(positions) else min(pos + 6000, len(html))
        block = html[pos - 300:end]
        name = _clean(_search(r'station_name">(.*?)</span>', block))
        if not name:
            continue
        n_prod = block.count('class="product_volume"')
        if name not in best or n_prod > best[name][0]:
            best[name] = (n_prod, block)
    return {name: blk for name, (_, blk) in best.items()}


def _search(pat, s):
    m = re.search(pat, s, re.S)
    return m.group(1) if m else None


def _parse_products(block):
    out = []
    for pm in re.finditer(
            r'product_name">(.*?)</span>\s*<span class="product_volume">(.*?)</span>(.*?)'
            r'(?=<span class="product_row|</td>|$)', block, re.S):
        name = (_clean(pm.group(1)) or "").upper()
        if name not in PRODUCT_MAP:
            continue
        pid, carga = PRODUCT_MAP[name]
        saldo, disp = _parse_volume(_clean(pm.group(2)))
        cola = _clean(_search(r'product_queue_label">(.*?)</span>', pm.group(3)))
        out.append({"pid": pid, "carga": carga, "saldo": saldo, "disp": disp,
                    "cola": cola, "cola_nivel": COLA_NIVEL.get((cola or "").lower())})
    return out


def scrape():
    """Devuelve la lista de records (1 por estacion x producto) de GENEX."""
    registry = {}
    if os.path.exists(REGISTRY_PATH):
        with open(REGISTRY_PATH, encoding="utf-8") as f:
            registry = {k: v for k, v in json.load(f).items() if not k.startswith("_")}

    html = fetch()
    blocks = _blocks(html)
    records = []
    for nombre, block in blocks.items():
        direccion = _clean(_search(r'station_address">(.*?)</span>', block)) or ""
        fecha = _parse_dt(_clean(_search(r'station_updated">(.*?)</span>', block)))
        reg = registry.get(nombre)
        if reg is None:
            print(f"ADVERTENCIA GENEX: estacion '{nombre}' no esta en "
                  f"genex_stations.json (sin geo). Agregala.", file=sys.stderr)
        un = reg["un"] if reg else None
        lat = reg.get("lat") if reg else None
        lng = reg.get("lng") if reg else None
        ciudad = reg.get("ciudad") if reg else ""
        if un is None or not fecha:
            continue
        for p in _parse_products(block):
            saldo, carga = p["saldo"], p["carga"]
            veh = round(saldo / carga, 1) if (saldo is not None and carga) else None
            records.append({
                "un": un, "producto_id": int(p["pid"]),
                "producto": PRODUCTO_NOMBRE[p["pid"]], "marca": "genex",
                "nombre": nombre, "direccion": direccion, "ciudad": ciudad,
                "lat": lat, "lng": lng, "fecha": fecha,
                "saldo": saldo, "mangueras": None, "carga_promedio": carga,
                "vehiculos": veh, "tiempo_carga": None,
                "cola": p["cola"], "cola_nivel": p["cola_nivel"], "disp": p["disp"],
            })
    return records


if __name__ == "__main__":
    recs = scrape()
    print(f"GENEX: {len(recs)} records de {len(set(r['un'] for r in recs))} estaciones")
    for r in recs:
        v = f'{r["saldo"]} L' if r["saldo"] is not None else (
            "DISPONIBLE" if r["disp"] else "agotado")
        print(f'  {r["nombre"]:18} {r["producto"]:18} {v:12} cola={r["cola"]}')
