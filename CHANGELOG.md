# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Dashboard libraries (MQTT.js 5.10.1, uPlot 1.6.31, Leaflet 1.9.4) are vendored in
  `dashboard/vendor/` instead of loaded from a CDN, so the page opens without internet.
- Map centers on the actual test site at La Salle Bajío.

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
