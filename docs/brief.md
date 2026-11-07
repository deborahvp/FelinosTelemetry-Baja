# felinos-telemetry — Brief para Claude Code

> Especificación para construir el repositorio desde cero en Claude Code.
> Copia este archivo a la raíz del repo como `docs/brief.md` y pide a Claude Code que lo lea antes de empezar.
> Idioma: código, nombres, commits y README en **inglés** (portafolio/CV); guía de campo para el equipo en **español**.

---

## 1. Contexto

- Equipo: **Felinos Racing**, Baja SAE, Universidad La Salle Bajío. Próxima competencia: Baja SAE México, 3–6 dic 2026.
- Hasta ahora el equipo no tenía datos ni base de datos de pruebas. Este proyecto es la primera pieza de una plataforma de datos del equipo.
- Fuente de datos inicial: un **Samsung Galaxy Note 10** con la app **Sensor Logger** (con Pro para MQTT) y chip prepago con datos, montado en el vehículo.
- A futuro: PCB de telemetría propia (ESP32 + LoRa, entradas de RPM, freno, acelerador, temperatura, acelerómetro ADXL345) que debe integrarse al mismo sistema.
- Objetivos del vehículo que los datos deben validar:

| ID | Objetivo | Valor |
| --- | --- | --- |
| VG-01 | Resultado global | Top 3 en Endurance |
| VG-02 | Durabilidad | 80 h acumuladas sin falla por fatiga |
| VG-03 | Peso en orden de marcha (con combustible) | ≤ 375 lb (meta 170 kg; anterior Thundercat 190 kg) |
| VG-04 | Aceleración | ≤ 4.3 s en 100 ft |
| VG-05 | Maniobrabilidad | Radio de giro 6 ft (medido sobre la línea de la llanta interior) a ~5 mph |
| VG-06 | Ascenso | 150 ft a 30° desde parado en < 20 s |
| VG-07 | Obstáculos | Superar ~10 in |

Para VG-02 se manejan dos metas candidatas: una para 4 competencias y otra para 2, cada una con sus horas de prueba.

## 2. Decisiones ya tomadas

1. **Transporte en vivo:** Sensor Logger → **MQTT** (WebSocket + TLS, puerto 8884) → broker administrado (**HiveMQ Cloud**, plan gratuito) → clientes en pits.
2. **La grabación local en el teléfono es la fuente de verdad.** "Skip Writing" siempre apagado. El streaming es para monitorear.
3. **Batch period:** 1 s. Topic: `felinos/${deviceId}/${sessionId}`. Dashboard suscrito a `felinos/#`.
4. **Formatos:** JSON en vivo; respaldo NDJSON en laptop; export CSV de la app para análisis; Parquet opcional para lo acumulado.
5. **Dashboard:** HTML estático sin backend (MQTT.js + uPlot + Leaflet), modos **Live** y **Replay**. Mapa sin conexión con imagen satelital georreferenciada (`L.imageOverlay`).
6. **Análisis principal offline** en Python sobre la grabación completa. Los contadores en vivo son un extra.
7. **Escalabilidad:** misma interfaz para datos en vivo en la plataforma futura, pero el servicio de ingesta va aparte. El logger se diseña como servicio de ingesta (hoy NDJSON, mañana también base de datos).

## 3. Arquitectura

```
Note 10 (Sensor Logger) ──MQTT/WSS──▶ HiveMQ Cloud ──▶ dashboard/ (Live)
        │                                   └────────▶ ingest (Python) ──▶ stream.ndjson
        └── grabación local ──export CSV──▶ analysis (Python) ──▶ reportes + DVP&R
                                                     ▲
                       dashboard/ (Replay) ◀─────────┘ (CSV / NDJSON)
Futuro: PCB ESP32+LoRa ──▶ gateway en pits ──MQTT──▶ mismo broker
```

## 4. Stack y convenciones

- **Python ≥ 3.11**, layout `src/`, paquete `felinos_telemetry`, gestión con `uv` (o pip + venv). Dependencias: `numpy`, `pandas`, `scipy`, `pyyaml`, `pydantic` (v2), `paho-mqtt` (v2), `matplotlib`, `typer`. Dev: `pytest`, `pytest-cov`, `ruff`, `mypy`, `pre-commit`.
- **Dashboard:** JavaScript con ES modules, sin paso de build. Librerías por CDN con versión fija (MQTT.js 5.x, uPlot 1.6.x, Leaflet 1.9.x). Configuración en `dashboard/config.js` (no versionado), con `config.example.js` versionado.
- **Calidad:** `ruff` (lint + format), `mypy` en `src/`, tests con cobertura ≥ 80 % en `analysis/`.
- **Git:** rama `main` protegida; ramas `feat/…`, `fix/…`, `docs/…`; **Conventional Commits**; versionado **SemVer** con tags (`v0.1.0` = MVP para pruebas); `CHANGELOG.md` en formato Keep a Changelog.
- **CI (GitHub Actions):** lint + type check + tests en cada push/PR (matriz Python 3.11 y 3.12).
- **Secretos:** credenciales del broker solo en `.env` / `config.js` locales, nunca en el repo. `.env.example` con nombres de variables.
- **Licencia:** MIT.
- Unidades SI internamente (m, s, m/s², rad/s); conversión a g, km/h, ft, mph solo en reportes. Tiempos en UTC (ns desde época, como Sensor Logger).

## 5. Estructura del repositorio

```
felinos-telemetry/
├── README.md                  # inglés: qué es, arquitectura, quickstart, capturas, roadmap
├── LICENSE
├── CHANGELOG.md
├── CONTRIBUTING.md
├── pyproject.toml
├── .env.example
├── .gitignore                 # data/, *.ndjson, config.js, .env, __pycache__, .venv
├── .pre-commit-config.yaml
├── .github/
│   ├── workflows/ci.yml
│   ├── pull_request_template.md
│   └── ISSUE_TEMPLATE/{bug.md,feature.md}
├── config/
│   ├── vehicles/felinos-2027.yaml   # masa, vía (track), distancia entre ejes, montaje del teléfono
│   ├── requirements.yaml            # objetivos → requisitos → pruebas (DVP&R)
│   └── analysis.yaml                # umbrales de eventos, bins de rainflow, etc.
├── templates/
│   └── meta.yaml                    # plantilla por corrida
├── src/felinos_telemetry/
│   ├── __init__.py
│   ├── cli.py                       # `felinos ingest|import|analyze|report|dvpr`
│   ├── models.py                    # pydantic: RunMeta, VehicleConfig, Requirement, Event…
│   ├── io/
│   │   ├── sensorlogger.py          # parseo de mensajes MQTT y del export CSV/zip
│   │   ├── ndjson.py
│   │   └── runs.py                  # descubrir y cargar carpetas de corrida
│   ├── ingest/
│   │   └── mqtt_logger.py           # suscriptor → NDJSON (rotación por sessionId)
│   ├── processing/
│   │   ├── resample.py              # alinear sensores a una base de tiempo común
│   │   ├── frames.py                # ejes teléfono → ejes vehículo
│   │   ├── quality.py               # huecos, frecuencia real, saturación (clipping)
│   │   └── gps.py                   # haversine, distancia acumulada, proyección local ENU
│   ├── analysis/
│   │   ├── acceleration.py          # VG-04
│   │   ├── turning.py               # VG-05
│   │   ├── climb.py                 # VG-06
│   │   ├── events.py                # impactos, saltos, frenadas, curvas fuertes
│   │   ├── fatigue.py               # rainflow + perfil de uso + extrapolación 80 h (VG-02)
│   │   └── spectral.py              # PSD (Welch): frecuencias de suspensión, entrada para vibración aleatoria
│   └── reporting/
│       ├── run_report.py            # reporte por corrida (Markdown/HTML + PNG)
│       └── dvpr.py                  # tabla DVP&R agregada
├── dashboard/
│   ├── index.html
│   ├── app.js  mqtt.js  charts.js  map.js  replay.js  state.js
│   ├── styles.css
│   ├── config.example.js
│   └── assets/track.example.json    # imagen + coordenadas de esquinas
├── tests/
│   ├── fixtures/                    # mensaje MQTT de ejemplo, mini export CSV
│   ├── test_sensorlogger.py
│   ├── test_frames.py
│   ├── test_acceleration.py
│   ├── test_turning.py
│   ├── test_events.py
│   └── test_fatigue.py
├── docs/
│   ├── brief.md                     # este archivo
│   ├── architecture.md              # con diagrama Mermaid
│   ├── data-format.md               # diccionario de datos
│   ├── field-guide.es.md            # guía de campo y checklist (español, imprimible)
│   ├── sensorlogger-setup.es.md     # configuración de la app paso a paso
│   └── adr/                         # Architecture Decision Records (0001-mqtt.md, 0002-local-recording-source-of-truth.md…)
└── data/                            # ignorado por git; estructura de corridas (abajo)
```

## 6. Formatos de datos

### 6.1 Carpeta por corrida

```
data/
  2026-11-08/
    R01_acceleration_susp-A_cvt-1/
      meta.yaml
      sensorlogger.zip     # export de la app (CSV por sensor)
      stream.ndjson        # respaldo del streaming
      video.mp4            # opcional
      results/             # generado por `felinos analyze`
```

### 6.2 `meta.yaml` (validado con pydantic; campos fijos pensando en la plataforma futura)

```yaml
schema_version: 1
vehicle_id: felinos-2027          # o thundercat
date: 2026-11-08
session_id: 2026-11-08_puerto-interior
run_id: R01
sensorlogger_session_id: null     # se llena al importar
test_type: acceleration           # acceleration | turning | climb | obstacles | endurance | free
requirement_ids: [VG-04]
driver: ""
configuration:
  suspension: susp-A
  cvt: cvt-1
  tire_pressure_psi: {front: 0, rear: 0}
  ballast_kg: 0
track: ""
weather: {temp_c: null, surface: dry}  # dry | wet | mud | sand
device:
  model: Galaxy Note 10
  mounting: "tubo del chasis junto al asiento, pantalla hacia afuera"
  axis_map: {x: lateral, y: longitudinal, z: vertical}   # con signo, p. ej. "-lateral"
notes: ""
```

### 6.3 Mensajes de Sensor Logger (streaming)

Estructura esperada — **confirmar con "Test Publish" y guardar el mensaje real en `tests/fixtures/` antes de escribir el parser**:

```json
{
  "messageId": 12,
  "sessionId": "…",
  "deviceId": "…",
  "payload": [
    {"name": "accelerometer", "time": 1731050000123456789, "values": {"x": 0.1, "y": -0.2, "z": 0.05}},
    {"name": "location", "time": 1731050000000000000, "values": {"latitude": 20.9, "longitude": -101.4, "altitude": 1800, "speed": 3.2, "bearing": 90, "horizontalAccuracy": 4}}
  ]
}
```

El parser debe ser tolerante: ignorar sensores desconocidos, aceptar campos faltantes, y devolver un `DataFrame` largo (`time_ns, sensor, field, value`) más una función para pivotear por sensor.

### 6.4 Export CSV

Un CSV por sensor dentro del zip (p. ej. `Accelerometer.csv`, `Gyroscope.csv`, `Location.csv`, `Orientation.csv`, `Barometer.csv`, `Metadata.csv`). Detectar los nombres reales con un export de prueba; mapear a los mismos nombres de sensor que el streaming para que el análisis no dependa del origen.

## 7. Especificación de componentes

### 7.1 Ingesta (`felinos ingest`)
- Se suscribe a `felinos/#` con paho-mqtt v2 sobre WebSocket/TLS.
- Escribe cada mensaje crudo + `received_at` en NDJSON, un archivo por `sessionId`, con `flush` por línea.
- Reconexión automática con backoff; log a consola del estado (mensajes/s, último mensaje, huecos).
- Interfaz `Sink` (NDJSON hoy; `PostgresSink` después) para escalar sin reescribir.

### 7.2 Dashboard (`dashboard/`)
- **Live:** conexión MQTT.js por WSS; ventana deslizante de 60 s; buffer completo en memoria para scroll.
- **Replay:** cargar `stream.ndjson` o el zip CSV; controles play/pausa/velocidad (1×, 2×, 5×) y barra de tiempo.
- **Paneles:** estado (último mensaje, latencia, batería, precisión GPS, sessionId) · mapa con traza coloreada por velocidad · velocidad (km/h) · aceleración longitudinal/lateral (g) · diagrama G-G · yaw rate (°/s) y pendiente (°).
- Decimar a ~25 Hz solo para graficar.
- Mapa: `L.imageOverlay` con imagen local de la pista y coordenadas de dos esquinas (`assets/track.json`); sin tiles en línea por defecto.
- Usuario MQTT del dashboard **solo lectura**.
- Diseño responsivo (laptop y teléfono), tema oscuro para usar al sol con buen contraste.

### 7.3 Procesamiento
- `quality.py`: frecuencia real por sensor, huecos > 3× periodo nominal, detección de saturación (muestras pegadas en el máximo del rango, ventanas planas en picos), precisión GPS. Todo reporte incluye una sección de calidad de datos.
- `frames.py`: aplicar `axis_map` y corregir la inclinación del montaje con el vector de gravedad promedio en la ventana inicial en reposo (5 s). Salida: `a_long`, `a_lat`, `a_vert`, `yaw_rate`, `pitch`, `roll`.
- `resample.py`: interpolar todos los sensores a una base común (p. ej. 100 Hz) sin extrapolar huecos.

### 7.4 Análisis (cada función devuelve un resultado tipado con valor, incertidumbre y bandera pass/fail contra el requisito)
- **VG-04 Aceleración (`acceleration.py`):** detectar arranque (a_long > 0.1 g sostenido ≥ 100 ms). Distancia = doble integración de a_long con bias quitado en reposo, corregida con velocidad GPS (filtro complementario simple). Tiempo a 30.48 m. Reportar también el resultado solo-GPS y la diferencia como incertidumbre.
- **VG-05 Radio de giro (`turning.py`):** segmentos en estado estable (|ω_z| y velocidad estables ≥ 2 s). R_cg = v / ω_z, y como verificación ajuste de círculo (Kasa) a la traza GPS en coordenadas ENU. Radio de la llanta interior = R_cg − vía/2 (vía desde `config/vehicles`). Reportar velocidad media del segmento (meta ~5 mph).
- **VG-06 Ascenso (`climb.py`):** tiempo desde arranque hasta 45.72 m recorridos; pendiente media desde `pitch` y desde altitud barométrica; pass si < 20 s.
- **Eventos (`events.py`):** umbrales en `config/analysis.yaml` (se calibran con el histograma de la primera prueba, no se fijan a ciegas):
  - impacto: |a_vert − 1 g| > umbral; registrar pico, duración, posición GPS.
  - salto: |a| < 0.3 g por > 100 ms seguido de un pico (aterrizaje); estimar tiempo en el aire.
  - frenada fuerte: a_long < −umbral por > 200 ms.
  - curva fuerte: |a_lat| > umbral por > 300 ms.
  - Salida: tabla de eventos + eventos por hora por severidad.
- **VG-02 Fatiga / perfil de uso (`fatigue.py`):**
  - Rainflow según **ASTM E1049** (implementación propia, validada en tests contra el ejemplo del estándar y contra la librería `rainflow` como dependencia solo de tests).
  - Histograma de ciclos por amplitud y por hora → extrapolación a 80 h y a las dos metas candidatas (4 y 2 competencias).
  - **Pseudo-daño** relativo (Σ nᵢ·Sᵢᵐ, con m configurable, p. ej. 3–5) para comparar configuraciones, pilotos y pistas. Dejar claro en el reporte que es comparativo, no vida absoluta: para vida de componentes se requiere FEA o galgas.
- **Espectral (`spectral.py`):** PSD por Welch de a_vert (y otros ejes) → frecuencias dominantes de suspensión por configuración; exportar PSD en formato tabla (Hz, g²/Hz) para usar como entrada del **análisis de vibración aleatoria** en SolidWorks. Límite útil: hasta fs/2.

### 7.5 Reportes
- `felinos analyze <run_dir>`: genera `results/` con `summary.json`, `events.csv`, figuras PNG y `report.md`.
- `felinos dvpr data/`: recorre todas las corridas, cruza con `config/requirements.yaml` y genera la tabla **DVP&R** (Design Verification Plan & Report): requisito, método, criterio, corridas, resultado medio ± desviación, estado (pass / fail / sin evidencia).

Ejemplo de `config/requirements.yaml`:

```yaml
- id: VG-04
  title: Acceleration 100 ft
  metric: time_100ft_s
  criterion: {op: "<=", value: 4.3}
  method: acceleration
  min_runs: 3
- id: VG-05
  title: Turning radius at ~5 mph (inner tire line)
  metric: turning_radius_inner_ft
  criterion: {op: "<=", value: 6.0}
  method: turning
  min_runs: 3
```

## 8. Aprovechamiento para V&LE y los subsistemas (prácticas reales de la industria)

| Idea | Práctica en la industria | Subsistema | Cuándo |
| --- | --- | --- | --- |
| DVP&R automático y trazabilidad objetivo → requisito → prueba → evidencia | Modelo en V, DVP&R (APQP) | V&LE | MVP |
| Perfil de uso medido y ciclo de durabilidad propio para las 80 h | Customer usage profile, correlación con pista de pruebas | V&LE, chasis | MVP (rainflow) |
| Cargas medidas como casos de carga para FEA y comparación medido vs simulado | Correlación CAE–prueba | Chasis, suspensión | v0.2 |
| PSD medida como entrada de vibración aleatoria | Road load data acquisition (RLDA) | Chasis, electrónica (caja de la PCB) | v0.2 |
| Comparación de configuraciones con varias corridas (media ± desviación) | DOE / pruebas A/B | Suspensión, CVT | MVP |
| Frecuencias de suspensión y respuesta a impactos por configuración | Ride & handling | Suspensión | v0.2 |
| Curvas de aceleración y velocidad máxima; con RPM de la PCB: relación CVT vs velocidad | Calibración de tren motriz | Transmisión/CVT | v0.2 / con PCB |
| Desaceleración máxima y distancia de frenado | Pruebas de frenado | Frenos | v0.2 |
| Yaw rate y radio de giro contra ángulo de volante | Handling | Dirección | v0.2 |
| Vibración en el asiento según ISO 2631-1 (RMS ponderada, VDV) | Ergonomía / NVH | Ergonomía, piloto | v0.3 |
| G-G, consistencia de vueltas y comparación de pilotos | Ingeniería de datos en motorsport | Piloto, Endurance | v0.3 |
| Detección de anomalías en vivo (temperatura, vibración fuera de rango) | Monitoreo de condición | Todos | Con PCB |

Cada gráfica que entre al reporte de diseño o a la presentación de V&LE debe citar los IDs de corrida de donde sale.

## 9. Estrategia de pruebas

- Datos sintéticos con resultado conocido:
  - aceleración constante → tiempo a 100 ft analítico (t = √(2d/a));
  - círculo de radio conocido a velocidad constante → R = v/ω;
  - secuencia del ejemplo ASTM E1049 → conteo rainflow conocido;
  - señal con caída libre + pico → un salto detectado;
  - señal saturada → bandera de clipping.
- Fixture con un mensaje MQTT real y un mini export CSV reales del teléfono.
- Test de humo del dashboard con Playwright en modo Replay (carga un NDJSON de fixture y verifica que se dibujen mapa y gráficas).

## 10. Plan de trabajo (orden sugerido para Claude Code)

**v0.1.0 — para las pruebas de este fin de semana**
1. Esqueleto del repo, `pyproject.toml`, ruff/mypy/pytest, pre-commit, CI, LICENSE, README inicial.
2. `models.py` + `templates/meta.yaml` + validación.
3. Parser de Sensor Logger (streaming y CSV) con fixtures reales.
4. `felinos ingest` (MQTT → NDJSON).
5. Dashboard Live con estado, mapa (imageOverlay), velocidad y aceleraciones.
6. `docs/field-guide.es.md` y `docs/sensorlogger-setup.es.md` imprimibles.
7. Tag `v0.1.0`.

**v0.2.0 — análisis (después de las pruebas, con datos reales)**
8. `quality.py`, `frames.py`, `resample.py`.
9. Análisis VG-04, VG-05, VG-06, eventos y rainflow; calibrar umbrales con los datos de la prueba.
10. Reporte por corrida y `felinos dvpr`.
11. Dashboard Replay y diagrama G-G.
12. PSD y exportación para vibración aleatoria.

**v0.3.0 y después**
13. Base de datos (PostgreSQL/Supabase) con `PostgresSink` e importador de corridas.
14. Plataforma web del equipo: historial por vehículo, pruebas, competencias, scoresheets PDF, feedback en txt, vista en vivo.
15. Integración de la PCB (gateway LoRa → MQTT).
16. Asistente de IA sobre métricas, feedback y scoresheets.

## 11. Pendientes por verificar

**Mientras no se pague Sensor Logger Pro:** se puede avanzar con todo. El parser se escribe contra la estructura esperada (sección 6.3) en un fixture marcado como `tests/fixtures/assumed_message.json`, aislado detrás de una sola función (`parse_message`) para que el cambio al formato real toque un solo archivo. Formas gratuitas de obtener el formato real antes de pagar:

- **Export CSV:** grabar 1–2 min con el teléfono y exportar en CSV (la grabación y el export no requieren Pro). Guardarlo como `tests/fixtures/sample_export.zip`.
- **HTTP Push a un inspector de requests** (p. ej. webhook.site) con Batch Period de 1 s, si ese periodo no está bloqueado: muestra el JSON exacto que manda la app. Según la descripción de la app, HTTP Push y MQTT envían el mismo arreglo JSON por lotes. Solo con datos de prueba, porque el inspector es un servicio de terceros.

- [ ] Estructura exacta del JSON con "Test Publish" (o HTTP Push al inspector) y nombres de los CSV del export.
- [ ] Que el Note 10 (Android) tenga las mismas opciones de streaming que se vieron en iOS.
- [ ] Rango máximo del acelerómetro del Note 10 (posible saturación en aterrizajes) y frecuencia máxima disponible.
- [ ] Consumo real de datos por hora con IMU a 100 Hz (estimado 70–110 MB/h).
- [ ] Vía (track) del vehículo para el cálculo del radio de la llanta interior.
- [ ] Imagen satelital de la pista de pruebas y coordenadas de dos esquinas.

## 12. Para el README (portafolio)

- Una línea de valor: *"End-to-end vehicle data acquisition and verification pipeline for a Baja SAE off-road prototype: live telemetry, automated test analysis and requirements traceability (DVP&R)."*
- Diagrama de arquitectura, captura/GIF del dashboard, ejemplo de reporte DVP&R, badges de CI y cobertura, roadmap, y sección "Engineering decisions" enlazando a los ADR.
