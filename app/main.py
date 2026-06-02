import json
import uuid
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.manager import manager
from app.models import LocationUpdate, UserLocation

app = FastAPI(title="RutaU")

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")


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
