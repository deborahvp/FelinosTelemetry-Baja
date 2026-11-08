# Vendored libraries

Copied unmodified from jsDelivr so the dashboard loads without internet (live data still needs
the broker). Update by downloading the same paths for a newer pinned version.

| File | Library | Version | License | Source |
| --- | --- | --- | --- | --- |
| `mqtt.min.js` | MQTT.js | 5.10.1 | MIT | https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js |
| `uPlot.iife.min.js`, `uPlot.min.css` | uPlot | 1.6.31 | MIT | https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/ |
| `leaflet.js`, `leaflet.css` | Leaflet | 1.9.4 | BSD-2-Clause | https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/ |

Leaflet's marker and layer-control images are not included: the dashboard draws its own
markers and has no layer control.
