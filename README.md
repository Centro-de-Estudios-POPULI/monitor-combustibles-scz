# Monitor de Combustibles · Santa Cruz

Scraper + **dashboard de indicadores** que monitorea los **saldos de combustible** de las
redes **Biopetrol** y **Genex** en Santa Cruz y Montero, Bolivia, con **georreferencia**:
gasolina especial, gasolina premium, diésel y GNV. Los datos se extraen **cada 30 minutos**,
se almacenan y se publican en un dashboard navegable con mapa, series temporales e
indicadores derivados, con **filtro de marca** y vista unificada de ambas redes.

🌐 **https://centro-de-estudios-populi.github.io/monitor-combustibles-scz/**

> Centro de Estudios POPULI · scraper Python → JSON → mapa Leaflet + ECharts → GitHub Pages.

## Fuentes

El monitor unifica dos redes (campo `marca` en todos los datos):

- **Biopetrol** — `https://app9.biocloud.info/saldos/main/donde/<producto_id>`
  (HTTPS) · `134` = Gasolina Especial, `132` = Diésel. Página de tarjetas renderizada en
  servidor; trae saldo, autonomía en vehículos, tiempo de cola, dirección y georreferencia.
  **No publica un id numérico**: las estaciones se mapean por **nombre** a un `un` sintético
  estable en `scraper/biopetrol_stations.json` (preserva el histórico). Solo lista las
  estaciones con stock en el momento.
  <br>_(Hasta 2026-07 la fuente vivía en un host EC2 con otro formato; migró — ver la receta
  de migración más abajo.)_
- **Genex** — `https://genex.com.bo/estaciones/...` (tabla WooCommerce renderizada en servidor).
  Productos: gasolina especial, **premium** (`200`), diésel y **GNV** (`300`). Aporta además la
  **cola de vehículos** reportada. No publica mangueras ni coordenadas: las estaciones se
  resuelven una vez a `scraper/genex_stations.json` (`un` sintético + lat/lng + ciudad).

Cada adaptador (`biopetrol.py`, `genex.py`) es **autónomo** y devuelve el mismo esquema de
record; `scrape.py` solo los orquesta. Si una fuente no entrega datos válidos en un ciclo, se
conserva su último snapshot real como *dato viejo* (**carry-forward** por estación, con tope de
48 h) y se registra en `docs/data/health.json` para alertar (ver *Salud y alertas*).

Productos internos: `134` especial, `132` diésel, `200` premium (litros), `300` GNV
(solo disponible/agotado, sin litros → vista de disponibilidad). Por estación se captura:
nombre, dirección, ciudad, **lat/lng**, marca, saldo (L), hora, y según la fuente mangueras,
carga, autonomía en vehículos y cola.

## Indicadores

A partir de la **serie temporal** del saldo se derivan (ver `scraper/metrics.py` y la
sección *Metodología* del dashboard):

- **Por estación:** tasa de despacho (L/h), tiempo hasta agotarse (ETA), recargas
  detectadas, saldo por surtidor, capacidad teórica de despacho, índice de saturación,
  vaciado a plena demanda, disponibilidad/uptime, tiempo en crítico, sensor desactualizado.
- **De red:** stock total, % de estaciones con stock / críticas / secas, índice de estrés,
  comparación gasolina vs diésel.
- **Patrones:** heatmap hora × día del estrés, resúmenes diarios por estación.

## Estructura

```
scraper/
  scrape.py                Orquesta ambas fuentes + carry-forward + almacenamiento + genera los JSON
  biopetrol.py             Adaptador de la red Biopetrol (fetch HTTPS + parse de tarjetas)
  biopetrol_stations.json  Registro estático Biopetrol: nombre → un sintético + lat/lng + ciudad
  genex.py                 Adaptador de la red Genex (fetch HTTPS + parse de la tabla)
  genex_stations.json      Registro estático Genex (un sintético, lat/lng, ciudad)
  metrics.py               Motor de indicadores (funciones puras, solo stdlib)
docs/              Dashboard (GitHub Pages, source = /docs)
  index.html  style.css  data.js  views.js  app.js
  data/
    latest.json        snapshot actual + estado por estación
    metrics.json       indicadores por estación + red + diccionario de ayuda
    series_recent.json saldo de las últimas 72 h por estación
    red_series.json    serie agregada de red por producto
    heatmap.json       patrón hora × día
    daily.json         resúmenes diarios
    stations.json      maestro geo
    health.json        salud por marca (frescura, antigüedad, alertas)
    history/YYYY-MM-DD.jsonl   histórico crudo particionado por día
.github/workflows/scrape.yml   cron cada 30 min: corre el scraper, commitea los datos y verifica salud
```

## Dashboard (5 secciones)

- **Resumen** — KPIs de la red con tendencia, estrés, stock total y comparación de combustibles.
- **Mapa** — estaciones georreferenciadas; la **forma** distingue la marca (Biopetrol círculo,
  Genex cuadrado) y el **color** el estado (o el tiempo a agotarse). Filtro de marca global.
- **Estaciones** — lista buscable + panel de detalle con **todos los indicadores explicados**
  y gráfico de saldo con recargas marcadas.
- **Patrones** — heatmap hora × día y tabla de resúmenes diarios.
- **Metodología** — diccionario de cada indicador y cómo se calcula.

Incluye además un **recomendador por ubicación** (📍 usa la geolocalización del navegador para
sugerir la estación con stock más cercana del combustible elegido, mezclando cercanía y
disponibilidad), un **mensaje de ayuda** descartable y litros abreviados en miles (`30,5k L`).

Tema claro premium con **modo oscuro**, tooltips de ayuda y auto-refresco cada 5 min.

## Uso local

```bash
python scraper/scrape.py            # extrae y actualiza docs/data/*
python -m http.server -d docs 8000  # http://localhost:8000
```

## Automatización

El Action `scrape.yml` corre **cada 30 minutos**, ejecuta el scraper, commitea los datos
(con reintentos + `pull --rebase` para no chocar con runs solapados) y verifica la salud.
El histórico se deduplica por medición real (un+producto+fecha). Pages se actualiza solo.
Se puede lanzar a mano desde **Actions → Run workflow**.

> El cron nativo de GitHub es poco fiable; el disparo real lo hace un **pinger externo**
> (cron-job.org → `workflow_dispatch`) cada 30 min. El cron del YAML queda como respaldo.
> ⏰ El PAT del pinger vence ~2026-09-01: regenerarlo antes o el monitor deja de actualizarse.

## Salud y alertas

Cada corrida escribe `docs/data/health.json` con, por marca, cuántas estaciones vinieron
frescas, la antigüedad del último dato real y si está en **alerta** (último dato real de más de
6 h → outage probable). El paso *Verificar salud de datos* del Action pone el run en **rojo**
(→ notificación de GitHub) cuando hay alerta, **después** de commitear los datos. El dashboard
muestra además un **banner** de aviso leyendo ese archivo. Así un outage o una migración de la
fuente se detecta en horas, no en semanas.

## Receta: si una fuente migra o cambia de formato

Es lo que pasó con Biopetrol en 2026-07 (cambió de host EC2 a `app9.biocloud.info` y de
formato). Señales típicas: el banner/`health.json` marca una marca en alerta, o sus estaciones
quedan congeladas como *dato viejo*. Pasos para repararlo (toca **un solo adaptador**):

1. **Conseguir la URL nueva** de la fuente (abrir su página en el navegador) y ver el HTML/JSON
   que sirve hoy.
2. **Actualizar el adaptador** de esa marca (`scraper/biopetrol.py` o `scraper/genex.py`):
   la URL base arriba y el parser (regex/estructura) según el formato nuevo. Cada adaptador es
   autónomo y devuelve el mismo esquema de record, así que no hay que tocar `scrape.py`.
3. **Mapear los nombres** de estación a los `un` **ya existentes** en su registro
   (`*_stations.json`) para **no romper el histórico** (indexado por `un`+producto). Estaciones
   nuevas: agregarlas con un `un` nuevo (no reutilizar). El scraper avisa por stderr si ve una
   estación que no está en el registro.
4. **Probar local**: `python scraper/biopetrol.py` (o `genex.py`) imprime lo que extrae; luego
   `python scraper/scrape.py` regenera todo y `health.json` debe quedar sin alertas.
5. **Push**. Si el repo local está atrasado, `git pull --rebase` antes (no toca `scraper/`).

Para no perder la carrera contra el scheduler al pushear a mano:
`gh workflow disable scrape.yml` → trabajar → push → `gh workflow enable scrape.yml`.

**Huecos en el histórico:** un período sin datos se muestra como **hueco** en las series (las
series de red no arrastran un valor congelado más de 6 h). Para rellenarlo si se consiguen los
datos, agregar las mediciones a `docs/data/history/YYYY-MM-DD.jsonl`
(`{"un","producto_id","fecha","saldo","vehiculos"}`, un objeto por línea) y el pipeline las
incorpora al regenerar.

## Notas

- Indicadores como despacho/ETA/recargas necesitan varias mediciones para poblarse; al
  inicio aparecen como “—” y se llenan con las horas.
- Estaciones sin embed de mapa en la fuente aparecen en lista y gráficos, pero no en el mapa.
- **GNV**: la fuente solo reporta disponible/agotado (sin litros), por eso se muestra como mapa
  de disponibilidad + cola, sin series ni semáforo de litros.
- **Genex** no publica mangueras → los indicadores que dependen de ellas (saldo por surtidor,
  capacidad teórica, saturación) no aplican a esa red y aparecen como “—”.
- Si Genex publica una estación nueva que no esté en `genex_stations.json`, el scraper la incluye
  sin geo y avisa por stderr para agregarla.
- Todo en **hora de Bolivia (UTC-4)**. Las estimaciones son aproximadas, no cifras oficiales.
