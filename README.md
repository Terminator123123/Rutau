# ColectivoU

Aplicación web de coordinación de transporte colectivo en tiempo real para estudiantes y conductores de la Universidad de La Guajira, Riohacha.

## Problema que resuelve

Los estudiantes de la UniGuajira dependen de colectivos informales sin saber si hay uno disponible cerca ni en qué dirección va. Los conductores tampoco saben dónde se concentra la demanda. ColectivoU conecta en tiempo real a ambos actores en un mapa interactivo: el estudiante ve los colectivos disponibles, solicita un viaje y el conductor lo acepta o rechaza desde la misma app.

## Funcionalidades principales

- **Autenticación completa:** registro, inicio de sesión con JWT, verificación de correo electrónico, recuperación de contraseña
- **Mapa en tiempo real:** ubicaciones actualizadas vía WebSocket, marcadores diferenciados por rol (estudiante = círculo azul, conductor = ícono verde/rojo según disponibilidad)
- **Flujo de viaje:** el estudiante solicita un colectivo, el conductor más cercano recibe la solicitud con temporizador de 40 s y puede aceptarla o rechazarla
- **Verificación de conductores:** el conductor sube documentos (cédula, selfie, placa, SOAT) y un administrador los aprueba o rechaza
- **Sistema de calificaciones:** al finalizar el viaje, el estudiante califica al conductor con estrellas (1-5)
- **Panel de administrador:** gestión de usuarios, aprobación de conductores, visualización de estadísticas en tiempo real
- **Editar perfil:** cambio de nombre y contraseña desde el menú lateral
- **Contador de pasajeros:** el conductor registra pasajeros y cambia su estado (disponible / lleno / en camino)

## Tecnologías

| Capa | Tecnología |
|------|-----------|
| Backend | Python 3.12 + FastAPI + WebSockets |
| Base de datos | PostgreSQL (producción) / SQLite (desarrollo) |
| ORM | SQLAlchemy |
| Autenticación | JWT + cookies httponly |
| Email | Brevo API (transaccional) |
| Frontend | HTML + CSS + JavaScript vanilla |
| Mapas | Leaflet.js + OpenStreetMap |
| Despliegue | Railway |

## Estructura del proyecto

```
rutau/
├── app/
│   ├── main.py          # Rutas FastAPI y WebSocket
│   ├── database.py      # Modelos SQLAlchemy y conexión DB
│   ├── models.py        # Esquemas Pydantic (request/response)
│   ├── auth.py          # JWT, cookies, hashing de contraseñas
│   ├── manager.py       # Gestor de conexiones WebSocket y viajes
│   └── email_service.py # Envío de emails via Brevo
├── static/
│   ├── dev.html         # App principal
│   ├── admin.html       # Panel de administrador
│   ├── app.js           # Lógica frontend
│   └── style.css        # Estilos
├── Procfile             # Configuración Railway
├── requirements.txt
└── .env                 # Variables de entorno (no subir al repo)
```

## Instalación y ejecución local

```bash
# 1. Clonar el repositorio
git clone https://github.com/Terminator123123/Rutau.git
cd Rutau

# 2. Crear entorno virtual
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # Mac/Linux

# 3. Instalar dependencias
pip install -r requirements.txt

# 4. Crear archivo .env con las variables necesarias
# (ver sección Variables de entorno)

# 5. Correr la app
uvicorn app.main:app --reload
```

Abrir en el navegador: http://localhost:8000/dev

## Variables de entorno

Crear un archivo `.env` en la raíz del proyecto:

```env
DB_URL=postgresql://usuario:contraseña@host/db   # sin esto usa SQLite local
BREVO_API_KEY=tu_clave_brevo
BASE_URL=http://localhost:8000
SECRET_KEY=una_clave_secreta_larga
ADMIN_USER=admin
ADMIN_PASSWORD=tu_contraseña_admin
```

## Uso de IA

**Claude Code (Anthropic)** fue la herramienta principal de IA utilizada a lo largo de todo el desarrollo. Su uso incluyó:

- Diseño de la arquitectura: FastAPI + WebSockets + SQLAlchemy + PostgreSQL
- Sistema de autenticación JWT con cookies httponly y verificación de email
- Gestor de conexiones WebSocket en tiempo real (`manager.py`)
- Flujo completo de solicitud y aceptación de viajes entre estudiante y conductor
- Diseño del frontend (HTML/CSS/JS) con mapa interactivo y menú lateral


Todo el código fue revisado y comprendido durante el desarrollo. El autor puede explicar cualquier parte del sistema en la sustentación.

## Integrantes

- Shalem Shaged Rolón Oviedo
