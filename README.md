# Monitor de Combustibles · Santa Cruz

Scraper + **dashboard de indicadores** que monitorea los **saldos de combustible**
(gasolina especial y diésel) de las estaciones Biopetrol en Santa Cruz, Bolivia, con
**georreferencia**. Los datos se extraen **cada 15 minutos**, se almacenan y se publican
en un dashboard navegable con mapa, series temporales e indicadores derivados.

🌐 **https://centro-de-estudios-populi.github.io/monitor-combustibles-scz/**

> Centro de Estudios POPULI · scraper Python → JSON → mapa Leaflet + ECharts → GitHub Pages.

## Fuente

`http://ec2-3-22-240-207.us-east-2.compute.amazonaws.com/guiasaldos/main/donde/<producto_id>`
(solo HTTP) · `134` = Gasolina Especial, `132` = Diésel.

Por estación se captura: nombre, dirección, **lat/lng**, saldo (L), hora de medición,
mangueras, carga promedio y autonomía en vehículos. La fuente publica mediciones nuevas
cada ~10–15 minutos, por eso el scraper corre cada 15.

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
  scrape.py        Orquesta fetch + parse + almacenamiento + genera todos los JSON
  metrics.py       Motor de indicadores (funciones puras, solo stdlib)
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
- **Mapa** — estaciones georreferenciadas, color por estado o por tiempo a agotarse.
- **Estaciones** — lista buscable + panel de detalle con **todos los indicadores explicados**
  y gráfico de saldo con recargas marcadas.
- **Patrones** — heatmap hora × día y tabla de resúmenes diarios.
- **Metodología** — diccionario de cada indicador y cómo se calcula.

Tema claro premium con **modo oscuro**, tooltips de ayuda, búsqueda y auto-refresco cada 5 min.

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
- Todo en **hora de Bolivia (UTC-4)**. Las estimaciones son aproximadas, no cifras oficiales.
