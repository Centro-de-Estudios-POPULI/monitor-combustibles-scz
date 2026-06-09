# Monitor de Combustibles · Santa Cruz

Scraper + **dashboard de indicadores** que monitorea los **saldos de combustible** de las
redes **Biopetrol** y **Genex** en Santa Cruz y Montero, Bolivia, con **georreferencia**:
gasolina especial, gasolina premium, diésel y GNV. Los datos se extraen **cada 15 minutos**,
se almacenan y se publican en un dashboard navegable con mapa, series temporales e
indicadores derivados, con **filtro de marca** y vista unificada de ambas redes.

🌐 **https://centro-de-estudios-populi.github.io/monitor-combustibles-scz/**

> Centro de Estudios POPULI · scraper Python → JSON → mapa Leaflet + ECharts → GitHub Pages.

## Fuentes

El monitor unifica dos redes (campo `marca` en todos los datos):

- **Biopetrol** — `http://ec2-3-22-240-207.us-east-2.compute.amazonaws.com/guiasaldos/main/donde/<producto_id>`
  (solo HTTP) · `134` = Gasolina Especial, `132` = Diésel. Trae mangueras, carga promedio y
  georreferencia embebida.
- **Genex** — `https://genex.com.bo/estaciones/...` (tabla WooCommerce renderizada en servidor).
  Productos: gasolina especial, **premium** (`200`), diésel y **GNV** (`300`). Aporta además la
  **cola de vehículos** reportada. No publica mangueras ni coordenadas: las estaciones se
  resuelven una vez a `scraper/genex_stations.json` (`un` sintético + lat/lng + ciudad).

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
  scrape.py            Orquesta ambas fuentes + parse + almacenamiento + genera todos los JSON
  genex.py             Adaptador de la red Genex (fetch HTTPS + parse de la tabla)
  genex_stations.json  Registro estático de estaciones Genex (un sintético, lat/lng, ciudad)
  metrics.py           Motor de indicadores (funciones puras, solo stdlib)
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
    history/YYYY-MM-DD.jsonl   histórico crudo particionado por día
.github/workflows/scrape.yml   cron cada 15 min: corre el scraper y commitea los datos
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

El Action `scrape.yml` corre **cada 15 minutos** (UTC), ejecuta el scraper y commitea los
datos. El histórico se deduplica por medición real (un+producto+fecha). Pages se actualiza
solo. Se puede lanzar a mano desde **Actions → Run workflow**.

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
