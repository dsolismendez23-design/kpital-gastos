# K-PITAL · Gastos

App para registrar y reportar los gastos de operación de K-PITAL. Funciona en el celular como una app (se puede "agregar a pantalla de inicio") y se sincroniza para todos los usuarios que tengan el link.

## Cómo funciona

No usa un servidor propio: los gastos se guardan como un archivo (`data/gastos.json`) dentro de este mismo repositorio de GitHub, y la app lo lee/escribe con la API de GitHub. GitHub Pages sirve la app como una página web gratuita. Cada celular/computadora se conecta una sola vez con un "token" (como una contraseña de acceso a este repositorio).

La lista se actualiza sola cada 20 segundos y también al volver a abrir la app o la pestaña, así todos ven los mismos datos.

## Puesta en marcha (una sola vez)

### 1. Crear el repositorio en GitHub
1. Entra a tu cuenta de GitHub y crea un repositorio nuevo, por ejemplo `kpital-gastos`. Puede ser **privado** (recomendado).
2. Sube todos los archivos de esta carpeta (`index.html`, `style.css`, `app.js`, `manifest.json`, `icon.svg`, la carpeta `data/`) a ese repositorio. Se puede hacer arrastrando los archivos desde la web de GitHub ("Add file → Upload files") o con git:

   ```bash
   cd kpital-gastos
   git init
   git add .
   git commit -m "K-PITAL: app de gastos"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/kpital-gastos.git
   git push -u origin main
   ```

### 2. Activar GitHub Pages
1. En el repositorio, entra a **Settings → Pages**.
2. En "Source" elige **Deploy from a branch**, rama `main`, carpeta `/ (root)`.
3. Guarda. En un par de minutos GitHub te dará un link público, algo como `https://TU-USUARIO.github.io/kpital-gastos/`. Ese es el link que compartes con el equipo.

### 3. Crear el token de acceso (para que la app pueda leer y guardar los gastos)
1. En GitHub ve a tu foto de perfil → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Ponle un nombre como "K-PITAL app".
3. En "Repository access" elige **Only select repositories** y selecciona `kpital-gastos`.
4. En "Permissions" busca **Contents** y ponlo en **Read and write**.
5. Genera el token y cópialo (empieza con `github_pat_...`). Guárdalo en un lugar seguro (por ejemplo, un gestor de contraseñas) — no se vuelve a mostrar.

> ⚠️ Este token da acceso de lectura/escritura **solo a este repositorio**. Aun así, no lo compartas por canales públicos; compáralo como si fuera una contraseña. Cualquier persona con el link de la app y este token podría ver y modificar los gastos.

### 4. Conectar cada dispositivo
1. Abre el link de la app en el celular o computadora.
2. La primera vez pedirá **Configuración**: ingresa el usuario/organización de GitHub, el nombre del repositorio (`kpital-gastos`), la rama (`main`) y pega el token.
3. Toca **Guardar y conectar**. Repite esto en cada celular del equipo (solo se hace una vez por dispositivo, luego queda guardado).
4. En el celular, se puede usar el botón "Agregar a pantalla de inicio" del navegador para que se vea como una app normal.

**Forma rápida para conectar un dispositivo nuevo:** en un dispositivo ya conectado, entra a Configuración y toca **"Copiar configuración para otro dispositivo"** — copia un código de texto (usuario|repositorio|rama|token). Envíalo por un canal privado (ej. WhatsApp) a la persona que necesita conectar un celular nuevo. Esa persona pega el código en el campo de arriba en Configuración y toca **"Usar este código y conectar"**, sin tener que escribir los 4 campos a mano.

## Uso

- **Gastos**: botón "+" para registrar un gasto nuevo (fecha, proveedor, monto de la factura y "Pagado por"). Tocar un gasto de la lista lo abre para editarlo o eliminarlo.
- **Reportes**: elige un período (o usa los atajos "Este mes", "Mes pasado", "Este año", "Todo") y consulta el total general, el desglose por proveedor y el desglose por "Pagado por".

## Notas

- Si dos personas guardan un gasto casi al mismo tiempo, la app reintenta automáticamente para no perder ninguno.
- Si el token se revoca, vence o se pierde el acceso, hay que generar uno nuevo (paso 3) y volver a conectar el dispositivo desde Configuración.
- "Desconectar este dispositivo" (dentro de Configuración) borra la conexión guardada en ese celular/computadora únicamente; no borra ningún gasto.
