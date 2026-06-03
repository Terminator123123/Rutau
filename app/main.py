import json
import uuid
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.manager import manager
from app.models import LocationUpdate, UserLocation

app = FastAPI(
    title="ColectivoU",
    description="API de coordinación de transporte colectivo en tiempo real — Universidad de La Guajira",
    version="1.0.0",
)

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse("static/index.html")


@app.get("/dev", include_in_schema=False)
async def dev():
    return FileResponse("static/dev.html")


@app.get("/health", tags=["API"])
async def health():
    """Estado del servidor."""
    return {"status": "ok", "app": "ColectivoU"}


@app.get("/usuarios/activos", tags=["API"])
async def usuarios_activos():
    """Lista de usuarios conectados en este momento con su rol y ubicación."""
    usuarios = manager.get_all_locations()
    return {
        "total": len(usuarios),
        "usuarios": usuarios,
    }


@app.get("/stats", tags=["API"])
async def stats():
    """Conteo de estudiantes y conductores activos en tiempo real."""
    usuarios = manager.get_all_locations()
    estudiantes = sum(1 for u in usuarios if u["role"] == "estudiante")
    conductores = sum(1 for u in usuarios if u["role"] == "conductor")
    return {
        "estudiantes_activos": estudiantes,
        "conductores_activos": conductores,
        "total": len(usuarios),
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    user_id = str(uuid.uuid4())
    await manager.connect(websocket, user_id)

    # send current state to new user
    await websocket.send_text(json.dumps({
        "type": "snapshot",
        "users": manager.get_all_locations()
    }))

    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            update = LocationUpdate(**payload)

            location = UserLocation(id=user_id, **update.model_dump())
            manager.set_location(user_id, location)

            await manager.broadcast({
                "type": "update",
                "user": location.model_dump()
            })
    except WebSocketDisconnect:
        manager.disconnect(user_id)
        await manager.broadcast({
            "type": "remove",
            "id": user_id
        })
