# Configuración de Sensor Logger y HiveMQ Cloud — paso a paso

> Guía para el equipo Felinos Racing. Imprimible. Versión de la app probada: Sensor Logger 1.68 (Android, Galaxy Note 10 / SM-N975F).
> Los nombres exactos de los menús pueden variar un poco entre versiones de la app.

## 1. Broker MQTT (HiveMQ Cloud, plan gratuito) — se hace una sola vez

1. Crear cuenta en HiveMQ Cloud y un cluster **Serverless (Free)**.
2. En la página del cluster anotar:
   - **Host** del cluster (algo como `abc123.s1.eu.hivemq.cloud`).
   - Puerto **8884** = MQTT sobre WebSocket + TLS (lo usan el teléfono, el dashboard y `felinos ingest`).
3. En **Access Management** crear **tres usuarios**, cada uno con su contraseña:

   | Usuario | Lo usa | Permiso |
   | --- | --- | --- |
   | `phone` | Sensor Logger en el Note 10 | Publicar |
   | `ingest` | `felinos ingest` en la laptop de pits | Suscribirse |
   | `dashboard` | `dashboard/config.js` | **Solo suscribirse** (su contraseña queda visible en el navegador) |

   ⚠ Verificar en la consola que el plan gratuito permite permisos por usuario. Si no, al menos usar contraseñas distintas y no compartir la del teléfono.

4. **Nunca** subir contraseñas a git. Van solo en `.env` (laptop) y `dashboard/config.js`, que están en `.gitignore`.

## 2. Sensor Logger en el teléfono

### 2.1 Sensores (pantalla principal → activar)

| Sensor | ¿Activar? | Frecuencia |
| --- | --- | --- |
| Accelerometer | ✅ | 100 Hz |
| Gravity | ✅ (necesario para nivelar ejes y pendiente) | 100 Hz |
| Gyroscope | ✅ | 100 Hz |
| Orientation | ✅ | 100 Hz |
| Location | ✅ | máxima disponible (≈ 1 Hz) |
| Barometer | ✅ | por defecto |
| Battery | ✅ (para el indicador de batería del dashboard) | por defecto |
| Uncalibrated / Magnetometer / Compass | opcional (más datos, más consumo) | — |

### 2.2 Grabación — la grabación local es la fuente de verdad

- **Skip Writing: APAGADO, siempre.** Si se enciende, la app solo transmite y no guarda nada en el teléfono.
- Formato de export: **CSV** (sale un `.zip` con un CSV por sensor).

### 2.3 Data Streaming → MQTT (requiere Sensor Logger Pro)

| Campo | Valor |
| --- | --- |
| Enable / Habilitar | ✅ |
| Broker / Host | host del cluster (sin `wss://`) |
| Port | `8884` |
| Transport | WebSocket |
| TLS | ✅ |
| Path (si lo pide) | `/mqtt` |
| Username / Password | usuario `phone` |
| Topic | `felinos/${deviceId}/${sessionId}` |
| Batch Period | **1 s** |
| QoS | 0 |

- Si la app **no sustituye** `${deviceId}` / `${sessionId}`, usar un topic fijo como `felinos/note10/live`. El sistema toma el `sessionId` del cuerpo del mensaje, así que funciona igual.
- Usar **Test Publish** y confirmar que en la laptop `felinos ingest` cuenta el mensaje.

### 2.4 Teléfono

- Modo ahorro de batería: **apagado**. Excluir Sensor Logger de la optimización de batería.
- Pantalla: tiempo de apagado largo o mantener encendida durante la corrida.
- Datos móviles encendidos (chip prepago). Consumo estimado con IMU a 100 Hz: **70–110 MB/h** — verificar en la primera prueba.
- Batería cargada al 100 % y power bank en la caja de pits.

## 3. Laptop de pits

```powershell
git clone <repo> ; cd felinos-telemetry
python -m venv .venv ; .venv\Scripts\activate
pip install -e ".[dev]"
copy .env.example .env                      # llenar MQTT_HOST, usuario ingest y contraseña
copy dashboard\config.example.js dashboard\config.js   # llenar url wss://<host>:8884/mqtt y usuario dashboard
```

Probar todo sin el carro (ensayo):

```powershell
felinos dashboard                            # abre el dashboard en el navegador
felinos ingest                               # en otra terminal
felinos simulate tests\fixtures\sample_export --publish   # en otra terminal: "reproduce" 60 s reales
```

Sin internet / sin broker: `felinos simulate tests\fixtures\sample_export --out dashboard\assets\demo.ndjson` y abrir `http://localhost:8000/?demo=assets/demo.ndjson`.

## 4. Pendientes por verificar en la primera prueba

- [ ] El Note 10 (Android) tiene las mismas opciones de streaming que se vieron en iOS.
- [ ] La app sustituye `${deviceId}` y `${sessionId}` en el topic.
- [ ] Nombre de los campos del sensor Battery (el dashboard acepta `batteryLevel` 0–1 o 0–100).
- [ ] Rango máximo del acelerómetro (¿se satura en aterrizajes?) y frecuencia máxima real.
- [ ] Consumo real de datos por hora.
- [ ] Permisos por usuario en HiveMQ Cloud gratuito.
