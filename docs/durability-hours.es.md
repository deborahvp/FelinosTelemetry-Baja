# Horas acumuladas y durabilidad (VG-02)

> Objetivo VG-02: **80 h acumuladas sin falla por fatiga**. Este documento explica cómo se
> cuentan esas horas en felinos-telemetry y por qué se usan varias medidas a la vez.

## El problema

"80 horas" no significa lo mismo si el carro pasea en un estacionamiento o salta en una pista de
endurance. La fatiga depende de **cuántos ciclos de carga** recibe la estructura y **qué tan
grandes** son, no solo del tiempo. Por eso se registran cuatro medidas, cada una con un uso.

## Las cuatro medidas

| Medida | Qué es | Para qué sirve | Limitación |
| --- | --- | --- | --- |
| **Horas activas** | Tiempo con el carro en movimiento: GPS > 3 km/h; si no hay GPS, vibración > 0.1 g RMS (1 s) | Es la medida literal de "80 h" y la más fácil de explicar. Barra de VG-02 en el dashboard | Trata igual una hora suave que una brutal |
| **Distancia (km)** | Suma de distancia GPS mientras se mueve | Desgaste de consumibles: banda de CVT, baleros, llantas, frenos | Solo con GPS; no refleja la severidad |
| **Horas equivalentes de daño** | Rainflow (ASTM E1049) de la aceleración vertical → pseudo-daño Σ nᵢ·Sᵢᵐ → dividido entre el daño de una "hora de referencia" | La medida correcta para **fatiga**: una hora en terreno duro puede valer 1.5 h equivalentes y una en estacionamiento 0.1 h | Necesita definir la hora de referencia; es **relativa**, no vida absoluta |
| **Impactos por severidad** | Conteo de picos > 2 g en bandas 2–3, 3–4, > 4 g, más saltos | Cargas de choque (sobrecarga, no fatiga); comparar pilotos, pistas y suspensiones | No es acumulable en horas |

### Por qué el exponente m

El pseudo-daño eleva cada ciclo a la potencia **m** (pendiente de la curva S-N). Con m = 3
(típico de uniones soldadas de acero, como el chasis) un ciclo del doble de amplitud cuenta
**8 veces** más; con m = 5 (componentes maquinados) cuenta **32 veces** más. Se reportan ambos.

### Qué NO es el pseudo-daño

No es la vida real de una pieza. Para eso se necesita FEA o galgas extensométricas y la curva S-N
del material. El pseudo-daño sirve para **comparar** (configuración A vs B, piloto 1 vs 2, pista
X vs Y) y para convertir horas de prueba en horas equivalentes de competencia.

## Cómo se usa

1. **En vivo (dashboard):** horas activas, km, impactos, saltos y frenadas fuertes por corrida y
   en la barra de VG-02 (todas las corridas guardadas en ese navegador). Son estimaciones.
2. **Oficial (Python), por corrida:**

   ```bash
   felinos analyze data/2026-11-08/R01_acceleration_susp-A_cvt-1
   ```

   Genera `results/summary.json`, `events.csv` y `report.md` con las cuatro medidas, los
   resultados de VG-04/05/06 y la calidad de datos.
3. **Acumulado de todas las corridas:**

   ```bash
   felinos usage data --csv data/usage.csv
   ```

   Tabla por corrida y total: horas activas vs 80 h, km, impactos y horas equivalentes.

## Definir la "hora de referencia" (pendiente)

1. Hacer una corrida representativa de competencia (la pista más dura disponible, ritmo de
   endurance, al menos 20–30 min).
2. `felinos analyze` → tomar `durability.damage_per_active_hour.m3` del `summary.json`.
3. Ponerlo en `config/analysis.yaml` → `durability.reference_damage_per_hour`.
4. A partir de ahí, `felinos usage` reporta **horas equivalentes**: cuántas "horas de
   competencia" ha consumido el carro.

## Las dos metas candidatas (4 o 2 competencias)

El brief menciona dos metas para VG-02 según el número de competencias. Cuando el equipo fije las
horas de prueba de cada una, se agregan como objetivos adicionales y `felinos usage` mostrará el
avance contra las dos. Mientras tanto se usa la meta de 80 h (`durability.target_hours`).

## Umbrales iniciales (calibrar con la primera prueba)

Todos viven en `config/analysis.yaml` y los usan igual el dashboard y Python (un test lo
verifica). Con la primera grabación real del iPhone se revisan los histogramas y se ajustan:

- Actividad sin GPS: 0.1 g RMS (en la grabación de prueba: ≈ 0.2 g en movimiento, ≈ 0.05 g detenido).
- Impacto: 2 g · salto: caída libre < 0.3 g por > 0.1 s · frenada fuerte: −0.5 g por > 0.2 s ·
  curva fuerte: 0.5 g por > 0.3 s.
