#!/usr/bin/env python3
"""
Adaptador de la red BIOPETROL para el Monitor de Saldos de Combustible.

Fuente (desde 2026-07): la "Guia Biopetrol" migro de servidor y de formato.
  ANTES: http://ec2-3-22-240-207...amazonaws.com/guiasaldos/main/donde/<pid>
         (HTTP, var_dump PHP con `array(5) { ["un"]=>int(..) ["saldo"]=>.. }`).
  AHORA: https://app9.biocloud.info/saldos/main/donde/<pid>
         (HTTPS, tarjetas Bootstrap renderizadas en el servidor, SIN var_dump y
          SIN el `un` numerico). Se raspa con urllib (sin ejecutar JS).

Cada estacion es una tarjeta con:
  - nombre        (div .font-weight-bold.bg-oscuro-1)
  - "Volumen disponible"                 -> "221 Lts." / "21,403 Lts." / "0 Lts."
  - "El volumen alcanza aprox. para"     -> "6 vehiculos"
  - "Un vehiculo en cola avanza cada"    -> "2 minutos aprox."
  - direccion     (div .px-1.col-12)
  - geo           (onclick="invokeCSCode('lat,lng')" y/o iframe ...!2d<lng>!3d<lat>)
La fecha ("Ultima medicion YYYY-MM-DD HH:MM") es GLOBAL de la pagina (una por
producto), no por estacion.

Como la fuente ya no da un id numerico, mapeamos cada estacion por NOMBRE a un
`un` sintetico estable via biopetrol_stations.json (mismo patron que Genex), para
NO romper la continuidad del historico (que esta indexado por (un, producto_id)).

Devuelve records con el MISMO esquema que el adaptador Genex.
Solo libreria estandar (corre en GitHub Actions sin instalar nada).
"""

import json
import os
import re
import sys
import time
import urllib.request

BASE = "https://app9.biocloud.info/saldos/main/donde/"
# La fuente Biopetrol solo publica gasolina especial y diesel.
BIO_PRODUCTOS = {"134": "GASOLINA ESPECIAL", "132": "DIESEL"}
CARGA_DEFAULT = 40.0  # L/veh de respaldo si la pagina no permite derivarla

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY_PATH = os.path.join(HERE, "biopetrol_stations.json")

# nombre de la tarjeta (div en negrita con fondo oscuro). Evita el header del modal
# exigiendo la clase 'font-weight-bold bg-oscuro-1'.
_NAME = re.compile(r'font-weight-bold bg-oscuro-1[^>]*>([^<]+)</div>')
_ADDR = re.compile(r'class="px-1 col-12">([^<]+)</div>')
_GEO_JS = re.compile(r"invokeCSCode\('(-?\d+\.\d+),(-?\d+\.\d+)'\)")   # (lat, lng)
_GEO_EMBED = re.compile(r"!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)")             # (lng, lat)
_MEDICION = re.compile(r"ltima medici.n\s*([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{1,2}:[0-9]{2})")


def fetch(pid, retries=3, timeout=45, backoff=3):
    """Descarga la pagina de un producto con reintentos+backoff (la fuente puede
    dar timeouts/5xx transitorios; un solo intento hace parpadear todo el monitor)."""
    url = BASE + pid
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "Mozilla/5.0 (combustibles-monitor)"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            last = e
            if i < retries - 1:
                time.sleep(backoff * (i + 1))
    raise last


def _int(raw):
    """'21,403 Lts.' -> 21403 ; '6 vehiculos' -> 6 ; None si no hay digitos."""
    if not raw:
        return None
    digits = re.sub(r"[^\d]", "", raw)
    return int(digits) if digits else None


def _val_after(card, label_fragment):
    """Devuelve el texto del primer div .text-right que sigue a la etiqueta dada."""
    m = re.search(re.escape(label_fragment) + r".*?text-right[^>]*>([^<]+)</div>",
                  card, re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


def _geo(card):
    m = _GEO_JS.search(card)
    if m:
        return float(m.group(1)), float(m.group(2))       # lat, lng
    m = _GEO_EMBED.search(card)
    if m:
        return float(m.group(2)), float(m.group(1))       # lat, lng (embed da lng,lat)
    return None, None


def parse(html, pid, registry):
    """Trocea el HTML en tarjetas por estacion y devuelve records crudos."""
    fecha_pag = None
    mm = _MEDICION.search(html)
    if mm:
        f = mm.group(1)
        # normaliza 'YYYY-MM-DD H:MM' -> 'YYYY-MM-DD HH:MM:SS'
        d, t = f.split(" ")
        hh, mi = t.split(":")
        fecha_pag = f"{d} {int(hh):02d}:{mi}:00"

    starts = [m.start() for m in _NAME.finditer(html)]
    nombres = _NAME.findall(html)
    out = []
    for i, pos in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else pos + 6000
        card = html[pos:end]
        nombre = nombres[i].strip()

        saldo = _int(_val_after(card, "Volumen disponible"))
        if saldo is None:
            continue
        veh = _int(_val_after(card, "alcanza aprox"))
        minutos = _int(_val_after(card, "avanza cada"))
        m_dir = _ADDR.search(card)
        direccion = m_dir.group(1).strip() if m_dir else ""
        lat, lng = _geo(card)

        reg = registry.get(nombre)
        if reg is None:
            print(f"ADVERTENCIA BIOPETROL: estacion '{nombre}' no esta en "
                  f"biopetrol_stations.json (sin un/geo). Agregala con un un nuevo.",
                  file=sys.stderr)
            continue
        if lat is None:
            lat, lng = reg.get("lat"), reg.get("lng")

        carga = round(saldo / veh, 1) if veh else CARGA_DEFAULT
        out.append({
            "un": reg["un"], "producto_id": int(pid),
            "producto": BIO_PRODUCTOS.get(pid, pid), "marca": "biopetrol",
            "nombre": nombre, "direccion": direccion,
            "ciudad": reg.get("ciudad") or "Santa Cruz",
            "lat": lat, "lng": lng, "fecha": fecha_pag,
            "saldo": saldo, "mangueras": None, "carga_promedio": carga,
            "vehiculos": veh if veh is not None else round(saldo / carga, 1),
            "tiempo_carga": minutos,
            "cola": None, "cola_nivel": None,
            "disp": 1 if saldo > 0 else 0,
        })
    return out


def scrape():
    """Devuelve la lista de records (1 por estacion x producto) de BIOPETROL."""
    registry = {}
    if os.path.exists(REGISTRY_PATH):
        with open(REGISTRY_PATH, encoding="utf-8") as f:
            registry = {k: v for k, v in json.load(f).items() if not k.startswith("_")}

    records = []
    for pid, nombre in BIO_PRODUCTOS.items():
        try:
            recs = parse(fetch(pid), pid, registry)
        except Exception as e:  # noqa: BLE001
            print(f"ERROR biopetrol producto {pid}: {e}", file=sys.stderr)
            continue
        # Guard centinela: cuando la fuente falla suele publicar un saldo identico
        # para todas las estaciones (visto: '1 Lts.' en todas). Un inventario real
        # nunca es identico en varias estaciones -> se descarta el lote.
        if recs and len({r["saldo"] for r in recs}) <= 1:
            print(f"ADVERTENCIA: biopetrol producto {pid} devolvio saldo centinela "
                  f"({recs[0]['saldo']}) identico en {len(recs)} estaciones; "
                  f"se descarta (fuente sospechosa).", file=sys.stderr)
            recs = []
        if not recs:
            print(f"ADVERTENCIA: biopetrol producto {pid} ({nombre}) sin datos validos "
                  f"(0 estaciones, error de la fuente o cambio de formato).",
                  file=sys.stderr)
        else:
            print(f"biopetrol producto {pid} ({nombre}): {len(recs)} estaciones")
        records.extend(recs)
    return records


if __name__ == "__main__":
    recs = scrape()
    print(f"BIOPETROL: {len(recs)} records de {len(set(r['un'] for r in recs))} estaciones")
    for r in recs:
        print(f'  {r["nombre"]:14} {r["producto"]:18} {r["saldo"]:>8} L  '
              f'{r["vehiculos"]} veh  geo={r["lat"] is not None}')
