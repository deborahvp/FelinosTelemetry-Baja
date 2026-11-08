# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Dashboard libraries (MQTT.js 5.10.1, uPlot 1.6.31, Leaflet 1.9.4) are vendored in
  `dashboard/vendor/` instead of loaded from a CDN, so the page opens without internet.
- Map centers on the actual test area in León (21.0894, −101.6987).
- iPhone support in the live view: sign and unit conventions are detected automatically
  (gravity direction against the mounted vertical axis, gravity magnitude for g vs m/s²).
  Default device model is now iPhone 15.
- Optional online satellite basemap (Esri World Imagery, on by default, `satellite: false` to
  disable); the offline track image still works on top of it or alone.
- `felinos dashboard` sends `Cache-Control: no-cache` so updated code is picked up after `git pull`.

### Added

- Run log in the dashboard: each new Sensor Logger recording becomes a new run with the next
  run ID (R01 → R02), keeping test type and configuration. Table with duration and maxima,
  per-run `meta.yaml` download (validated against `RunMeta`) and CSV export. Driver field in
  the run dialog.
- Connection dialog (click the connection status): broker URL and read-only user saved per
  browser, overriding `config.js`, so the dashboard can be hosted (e.g. Vercel) with no
  credentials in its files. `dashboard/vercel.json` and a Spanish deploy guide.
- Live analysis in the dashboard: active time, distance, impacts (severity bins), jumps,
  hard braking and cornering at the full IMU rate; standing-start launches (time to 100 ft and
  150 ft) and steady turns (R = v/omega). The goals panel now shows today's VG-04/05/06 results
  (best per run, mean over runs, n/3 runs, pass/fail), event counts, active time and the VG-02
  progress toward 80 active hours; the run log stores and exports them per run.
- Mount dialog: pick how the phone is mounted (5 presets + invert forward) from any browser,
  applied live with automatic re-leveling, so a last-minute change needs no computer.

## [0.1.0] - 2026-11-07

MVP for the first field tests (La Salle Bajío, weekend of 2026-11-08).

### Added

- Repository skeleton: packaging (`src/` layout), ruff, mypy (strict), pytest, pre-commit,
  GitHub Actions CI (Python 3.11/3.12 + dashboard tests on Node 22), MIT license.
- `RunMeta`, `VehicleConfig` and `Requirement` models with `templates/meta.yaml`,
  `config/vehicles/felinos-2027.yaml` and `config/requirements.yaml` (VG-04, VG-05, VG-06).
- Sensor Logger parser for live MQTT messages and CSV exports (folder or zip) into one long
  schema; repairs spreadsheet-damaged timestamps. Tested against a real message and a real
  60 s export from the Galaxy Note 10.
- NDJSON stream backup format, `Sink` interface and `NdjsonSink` (one file per session).
- `felinos ingest`: MQTT over WebSocket/TLS subscriber with reconnect/backoff and a status line
  (msg/s, last message, missing messages, lag).
- `felinos check`, `felinos simulate` (replay an export as Sensor Logger messages) and
  `felinos dashboard` (local server).
- Live dashboard following the approved mockup: status KPIs, speed, acceleration and yaw/grade
  charts, offline map with optional track image, G-G diagram, goals panel placeholder,
  EN | ES with English default, light/dark theme, responsive layout, `?demo=` playback.
- Spanish field guide and Sensor Logger/HiveMQ setup guide; architecture, data format and ADRs.

[Unreleased]: https://github.com/deborahvp/FelinosTelemetry-Baja/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/deborahvp/FelinosTelemetry-Baja/releases/tag/v0.1.0
