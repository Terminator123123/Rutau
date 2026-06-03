# ColectivoU

Aplicación web de coordinación de transporte colectivo entre conductores y estudiantes de la Universidad de La Guajira.

## Problema que resuelve

Los estudiantes dependen de colectivos informales sin saber si hay uno disponible cerca. Los conductores tampoco saben dónde hay demanda concentrada. ColectivoU conecta en tiempo real a ambos actores en un mapa interactivo.

## Funcionalidades

- Selección de rol (Estudiante o Conductor) sin registro ni contraseña
- Compartir ubicación GPS en tiempo real vía WebSocket
- Mapa interactivo (Leaflet.js) con marcadores diferenciados por rol
- Los marcadores desaparecen automáticamente cuando el usuario cierra la app

## Tecnologías

- **Backend:** Python 3.12 + FastAPI + WebSockets
- **Frontend:** HTML/CSS/JS + Leaflet.js
- **Mapa base:** CartoDB Dark Matter (OpenStreetMap)

## Instalación y ejecución

```bash
# 1. Clonar el repositorio
git clone <url-del-repo>
cd rutau

# 2. Crear entorno virtual e instalar dependencias
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # Mac/Linux

pip install -r requirements.txt

# 3. (Opcional) Copiar .env.example
copy .env.example .env

# 4. Correr la app
uvicorn app.main:app --reload
```

Abrir en el navegador: http://localhost:8000

## Uso de IA

Claude Code (Anthropic) fue utilizado para generar la estructura inicial del proyecto, el backend FastAPI con WebSockets y el frontend con Leaflet.js. Todo el código fue revisado y comprendido por el integrante del grupo durante el desarrollo.

## Integrantes

- Shalem Shaged Rolon Oviedo
