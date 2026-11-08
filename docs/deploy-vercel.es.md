# Publicar el dashboard en Vercel

> El dashboard es una página estática: Vercel la sirve gratis y queda disponible siempre, sin
> abrir la terminal. `felinos ingest` **no** va en Vercel (necesita estar conectado todo el
> tiempo); sigue corriendo en la laptop cuando quieras el respaldo `.ndjson`.

## Qué se publica y qué no

- Se publica la carpeta `dashboard/` tal como está en GitHub.
- **No** se publican contraseñas: `dashboard/config.js` está en `.gitignore`. En la página
  publicada, cada persona escribe la conexión una sola vez en la ventana **Conexión** (clic en
  el estado de conexión, arriba a la derecha). Se guarda solo en su navegador.
- No se publica la imagen de la pista (`assets/track.json`, `*.jpg`) ni el demo (`*.ndjson`).

## Pasos (una sola vez)

1. Entrar a [vercel.com](https://vercel.com) con la cuenta de GitHub (plan **Hobby**, gratis).
2. **Add New → Project** → importar el repositorio `deborahvp/FelinosTelemetry-Baja`
   (si no aparece, dar permiso a Vercel sobre ese repo en *Adjust GitHub App Permissions*).
3. En la configuración del proyecto:
   - **Root Directory:** `dashboard`
   - **Framework Preset:** `Other`
   - **Build Command:** vacío · **Output Directory:** vacío (o `.`) · **Install Command:** vacío
4. **Deploy**. Vercel da una dirección tipo `felinos-telemetry.vercel.app`.
5. Abrir la dirección → clic en **Sin configuración** (arriba a la derecha) → escribir:
   - URL: `wss://<tu-cluster>.hivemq.cloud:8884/mqtt`
   - Usuario y contraseña: el usuario **dashboard** (solo lectura)
   - Topic: `felinos/#`
6. **Guardar y conectar.** Debe decir **Conectado**.

Cada `git push` a `main` vuelve a publicar la página sola.

## Seguridad

- La dirección de Vercel es pública: cualquiera que la tenga ve la página, pero **sin la
  contraseña del usuario dashboard no ve datos**.
- La contraseña queda guardada en el navegador de cada dispositivo donde se escribió. Usa
  siempre el usuario de **solo lectura**; nunca el del teléfono. Si un dispositivo se pierde,
  cambia esa contraseña en HiveMQ.
- En un celular prestado, al terminar: Conexión → **Olvidar**.
