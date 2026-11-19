# Guía de campo — pruebas con telemetría

> Felinos Racing · Baja SAE · Imprimir y llevar a pits.
> Lugar de la primera prueba: **zona en León, Gto. (aprox. 21.0894, −101.6987)**; la pista exacta se define en sitio.
> Regla de oro: **la grabación del teléfono es la fuente de verdad.** El dashboard en vivo es solo para monitorear.

## 1. Antes de salir (checklist)

- [ ] Teléfono al 100 %, power bank cargado, cable.
- [ ] Sensor Logger configurado según `sensorlogger-setup.es.md`. **Skip Writing apagado.**
- [ ] Chip con datos y saldo.
- [ ] Laptop cargada, con `.env` y `dashboard/config.js` llenos. `felinos --help` funciona.
- [ ] Ensayo hecho en casa con `felinos simulate … --publish` (dashboard e ingest reciben datos).
- [ ] Soporte del teléfono, cinchos, cinta, trapo para limpiar.
- [ ] Hojas de `meta.yaml` impresas o la plantilla `templates/meta.yaml` en la laptop.
- [ ] Cinta métrica / flexómetro y conos (100 ft = 30.48 m; 150 ft = 45.72 m).

## 2. Montaje del teléfono y ejes (`axisMap`)

El teléfono debe ir **rígido** al chasis (sin vibrar suelto ni girar). Tomar una foto del montaje.

> **Tranquilidad:** si el montaje queda mal configurado, **los datos no se pierden ni se dañan**. Solo se ve raro el dashboard en vivo; la grabación del teléfono guarda los ejes crudos y el análisis los orienta después.

**Cómo configurarlo (sin computadora):** en el dashboard, botón **Montaje** (junto a "Nivelar") → elegir la posición → **Guardar** → carro detenido en plano 2 s (se nivela solo). Funciona desde cualquier celular que abra el dashboard (por ejemplo la versión de Vercel) y se guarda en ese navegador. Si cambias la posición del teléfono a último momento, solo repite esto.

Ejes del teléfono (iPhone y Android igual): **x** hacia la derecha de la pantalla, **y** hacia arriba de la pantalla, **z** saliendo de la pantalla.

| Montaje (opción en el dashboard) | `axisMap` equivalente |
| --- | --- |
| Acostado, pantalla arriba, parte de arriba del teléfono hacia el frente | `{x: 'lateral', y: 'longitudinal', z: 'vertical'}` |
| Vertical en tubo, **pantalla hacia afuera del lado DERECHO** del carro | `{x: 'longitudinal', y: 'vertical', z: 'lateral'}` |
| Vertical en tubo, **pantalla hacia afuera del lado IZQUIERDO** del carro | `{x: '-longitudinal', y: 'vertical', z: 'lateral'}` |
| Vertical, pantalla hacia el piloto (hacia atrás) | `{x: 'lateral', y: 'vertical', z: '-longitudinal'}` |
| Vertical, pantalla hacia el frente | `{x: 'lateral', y: 'vertical', z: 'longitudinal'}` |

"Vertical" = el teléfono parado con la parte de arriba hacia el cielo. Si va de cabeza o de lado, elegir la opción más parecida y hacer la prueba de 30 s:

1. Carro detenido en piso plano → **Nivelar** (espera 2 s).
2. Empujar o acelerar suave hacia adelante → **a longitudinal debe ser positiva** y en el G-G el punto debe subir hacia "Acelera".
3. Si sale negativa: **Montaje** → marcar **Invertir el frente** → Guardar.

El dashboard detecta solo si el teléfono es iPhone o Android (signos y unidades distintos); no hay que configurar nada por eso. Anotar la opción elegida en `notes` del `meta.yaml`.

## 3. Al llegar a la pista

1. Montar teléfono, anotar orientación y foto del montaje.
2. Laptop: abrir dos terminales.
   - Terminal 1: `felinos ingest` → debe decir `connected` y `waiting for messages`.
   - Terminal 2: `felinos dashboard` → se abre el navegador. Indicador arriba: **Conectado**.
3. En el dashboard: clic en "Corrida …" (arriba a la derecha) → llenar ID de corrida, tipo de prueba, suspensión, CVT y lugar.
4. Revisar **Precisión GPS**: idealmente ≤ 5 m ("Buena"). Si dice "Mala", esperar 1–2 min al aire libre.

## 4. En cada corrida

**Regla: una grabación de Sensor Logger = una corrida.** Detener la grabación cierra la corrida; iniciar otra abre la siguiente. El dashboard le asigna el siguiente ID solo (R01 → R02) y la agrega a la **Bitácora de corridas** (abajo en el dashboard).

| Paso | Quién | Qué |
| --- | --- | --- |
| 1 | Datos | Antes de grabar: en el dashboard, clic en "Corrida …" (arriba a la derecha) y revisar tipo de prueba, suspensión, CVT y piloto. El ID se pone solo. |
| 2 | Piloto | **Iniciar grabación** en Sensor Logger. En la bitácora aparece la corrida con la marca **EN VIVO**. |
| 3 | Piloto | Carro **detenido 5 s** en plano (sirve para nivelar ejes y quitar bias). |
| 4 | Datos | En el dashboard confirmar: datos llegando, "Último mensaje" < 2 s, "Sin huecos". |
| 5 | Piloto | Hacer la prueba. |
| 6 | Piloto | Al terminar, **5 s detenido** y **detener grabación**. |
| 7 | Datos | En la bitácora, botón **meta.yaml** de esa corrida → se descarga ya llenado. Completar presión de llantas, clima y observaciones (`notes`). |

**Cronómetro** (botón ⏱ abajo a la derecha, o la **barra espaciadora**): iniciar al arrancar, detener al terminar. El tiempo se guarda en la corrida que se está grabando y aparece en la bitácora. En aceleración y ascenso se muestra también el tiempo **automático** que midió el carro (100 ft / 150 ft); el manual incluye ~0.2 s de reacción humana, el automático no. Se pueden tomar varios tiempos por corrida.

**Corregir datos o agregar notas:** en la bitácora, botón **Editar** de cualquier corrida → cambiar ID, tipo de prueba, suspensión, CVT, piloto o lugar, escribir **notas** (clima, fallas, comentarios del piloto) y borrar tiempos de cronómetro equivocados. Si la corrida se está grabando, también se actualiza el encabezado. **Eliminar corrida** borra una corrida de prueba de la bitácora (no borra la grabación del teléfono).

Al final del día usa **Exportar CSV** para guardar la bitácora completa (incluye notas y tiempos de cronómetro).

Pruebas sugeridas para esta primera salida (también sirven para calibrar umbrales en v0.2):

- **Aceleración (VG-04):** salida desde parado, 100 ft medidos con conos. 3 corridas por configuración.
- **Radio de giro (VG-05):** círculos a ~5 mph (8 km/h) con volante a tope, ≥ 3 vueltas estables, en ambos sentidos.
- **Libre:** recorrido por la zona de pruebas con frenadas y curvas para tener histograma de eventos.

## 5. Después de cada corrida

1. En Sensor Logger: exportar la grabación en **CSV** (zip) y pasarla a la laptop.
2. Guardar en la carpeta de la corrida:

   ```
   data/2026-11-08/R01_acceleration_susp-A_cvt-1/
     meta.yaml          ← el descargado de la bitácora, renombrado a meta.yaml
     sensorlogger.zip
     stream.ndjson      ← copiar de data/stream/<sessionId>.ndjson
   ```

3. Revisión rápida: `felinos check data/2026-11-08/R01_acceleration_susp-A_cvt-1/sensorlogger.zip`
   y análisis oficial: `felinos analyze data/2026-11-08/R01_acceleration_susp-A_cvt-1` (genera `results/report.md`).
   → todos los sensores con frecuencia esperada (≈ 100 Hz IMU, ≈ 1 Hz GPS) y duración correcta.
4. ⚠ **Nunca abrir y guardar los CSV con Excel**: redondea la columna `time` a `1.79342E+18` y se pierde la precisión. Si alguien lo hizo, el parser intenta recuperarla, pero es mejor no arriesgar.

## 6. Al final del día

- [ ] `felinos usage data` → horas activas acumuladas, km e impactos (avance de VG-02).
- [ ] Copiar toda la carpeta `data/` a **dos lugares** (USB + nube del equipo).
- [ ] Anotar consumo de datos del chip y batería usada por hora.
- [ ] Anotar pendientes de la sección 4 de `sensorlogger-setup.es.md`.

## 7. Ver de nuevo una prueba (Repetición)

1. En el dashboard, botón **Repetición** (arriba, junto a "En vivo").
2. **Abrir carpeta…** → elegir la carpeta del día de pruebas (una subcarpeta por export de Sensor Logger, p. ej. `resultadosPruebas171126`). También sirven respaldos `.ndjson` con **Abrir .ndjson…**. No se sube nada: todo se lee en tu navegador.
3. Elegir la corrida en la lista → aparece el **resumen** (duración, velocidad máxima, tiempo a 100 ft / 150 ft, frenada máxima, eventos, tiempo activo).
4. **▶** (o barra espaciadora) para reproducir, velocidades **1× 2× 5× 10×** y la barra para saltar a cualquier momento. Gráficas, mapa, G-G, indicadores y el panel de objetivos muestran la corrida como ocurrió.
5. **Montaje** debe coincidir con cómo iba el teléfono (el 16 de noviembre: *Vertical, pantalla hacia el frente*); si se cambia, la repetición se recalcula sola.
6. **En vivo** regresa al modo normal. La repetición no agrega nada a la bitácora.

## 8. Mapa

- **Con internet:** el mapa muestra imagen satelital de la zona (Esri) y encima la traza GPS. No hay que hacer nada.
- **Sin internet (respaldo):** una captura satelital propia en `dashboard/assets/`:
  1. En Google Earth (o Google Maps vista satélite), **con el norte hacia arriba**, encuadrar la zona amplia de pruebas. Sugerencia: de **21.0867, −101.7016** (esquina inferior izquierda) a **21.0921, −101.6958** (esquina superior derecha), unos 600 m × 600 m.
  2. Tomar la captura y guardarla como `dashboard/assets/track.jpg`.
  3. Anotar las coordenadas reales de la **esquina inferior izquierda** y la **superior derecha** de la captura (clic derecho en el mapa → copiar coordenadas).
  4. Copiar `assets/track.example.json` → `assets/track.json` y poner esas dos esquinas en `bounds` (`[[sur, oeste], [norte, este]]`).
  - La captura no se sube a GitHub (está en `.gitignore`) porque la imagen tiene derechos de Google.

## 9. Problemas comunes

| Síntoma | Causa probable | Qué hacer |
| --- | --- | --- |
| Dashboard: "Sin configuración" | Falta `dashboard/config.js` | Copiar `config.example.js` → `config.js` y llenarlo, o clic en el aviso y escribir la conexión |
| Dashboard: "Reconectando" | Sin internet o URL mal | Revisar datos de la laptop; URL `wss://<host>:8884/mqtt` |
| "El broker rechazó la conexión" | Usuario o contraseña | Revisar `config.js` / `.env` |
| Conectado pero sin datos | Teléfono no transmite | ¿Streaming activado? ¿Test Publish? ¿Datos móviles? ¿Topic empieza con `felinos/`? |
| "N perdidos" en Último mensaje | Mala cobertura | No pasa nada: la grabación local tiene todo |
| Pendiente marca ≠ 0 en plano | Nivel tomado en movimiento | Detener en plano → **Nivelar** |
| a longitudinal al revés | Signo de `axisMap` | Ver sección 2 |
| Mapa sin imagen | Sin internet y sin `assets/track.json` | La traza se ve igual; para tener fondo sin internet, ver sección 8 |
| `felinos ingest`: `MQTT_HOST is not set` | Falta `.env` | Copiar `.env.example` → `.env` |
