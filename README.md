# Monitor de Saldos de Combustible · Santa Cruz

Scraper + dashboard que monitorea los **saldos de combustible** (gasolina especial y diésel)
de las estaciones Biopetrol en Santa Cruz, Bolivia, con **georreferencia**. Los datos se
extraen **cada hora** de la Guía Biopetrol y se publican en un dashboard con mapa y series
temporales.

> Centro de Estudios POPULI · patrón habitual: scraper Python → JSON → mapa Leaflet + ECharts → GitHub Pages.

## Fuente

`http://ec2-3-22-240-207.us-east-2.compute.amazonaws.com/guiasaldos/main/donde/<producto_id>`

| producto_id | combustible       |
|-------------|-------------------|
| 134         | Gasolina Especial |
| 132         | Diésel            |

Por cada estación se captura: nombre, dirección, **lat/lng**, saldo en litros, fecha de la
medición, mangueras, carga promedio y vehículos que alcanza (estimación de la fuente).

## Estructura

```
scraper/scrape.py        Scraper (solo stdlib de Python, sin dependencias)
docs/                    Dashboard (GitHub Pages, source = /docs)
  index.html, app.js, style.css
  data/
    latest.json          Estado actual de cada estación (se sobreescribe)
    stations.json        Maestro geo: un → {nombre, dirección, lat, lng}
    history.jsonl        Una línea por MEDICIÓN nueva (dedup por un+producto+fecha)
    series.json          Series temporales compactas para los gráficos
.github/workflows/scrape.yml   Cron horario que corre el scraper y commitea los datos
```

## Uso local

```bash
python scraper/scrape.py            # extrae y actualiza docs/data/*
python -m http.server -d docs 8000  # abre http://localhost:8000
```

## Publicar

1. Crear repo en GitHub y `git push`.
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, carpeta `/docs`.
3. El Action `Scrape saldos` corre cada hora (minuto 5 UTC) y actualiza los datos solos.
   Se puede lanzar a mano desde la pestaña **Actions → Run workflow**.

## Notas

- El histórico se **deduplica por medición real**: si la fuente no reportó una medición nueva
  en esa hora, no se duplica la fila. Las series crecen a medida que la fuente publica datos.
- Estaciones sin embed de mapa en la fuente (p. ej. LUCYFER) aparecen en la lista y los
  gráficos, pero no en el mapa hasta que la fuente publique sus coordenadas.
