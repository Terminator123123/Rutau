import json
import uuid

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from app.database import get_db
from app.auth import get_user_from_cookie, COOKIE_NAME
from app.manager import manager, trip_manager
from app.models import ALLOWED_ZONES, QUICK_MESSAGES, LocationUpdate, UserLocation
from app.dependencies import require_admin
from app.routers import auth, conductor, trips, admin, google_auth

app = FastAPI(
    title="ColectivoU",
    description="API de coordinacion de transporte colectivo en tiempo real — Universidad de La Guajira",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
)

# ── Routers ───────────────────────────────────────────────────────────────────

app.include_router(auth.router)
app.include_router(conductor.router)
app.include_router(trips.router)
app.include_router(admin.router)
app.include_router(google_auth.router)

# ── Static files ──────────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory="static"), name="static")

# ── Protected docs ────────────────────────────────────────────────────────────

@app.get("/docs", include_in_schema=False)
async def docs(_=Depends(require_admin)):
    return get_swagger_ui_html(openapi_url="/openapi.json", title="ColectivoU · Docs")


@app.get("/openapi.json", include_in_schema=False)
async def openapi(_=Depends(require_admin)):
    return app.openapi()

# ── Static pages ──────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def index():
    return FileResponse("static/index.html")


@app.get("/dev", include_in_schema=False)
async def dev():
    return FileResponse("static/dev.html")


@app.get("/admin-panel", include_in_schema=False)
async def admin_panel_page():
    return FileResponse("static/admin.html")

# ── API endpoints ─────────────────────────────────────────────────────────────

@app.get("/health", tags=["API"])
async def health():
    return {"status": "ok", "app": "ColectivoU"}


@app.get("/usuarios/activos", tags=["API"])
async def usuarios_activos():
    usuarios = manager.get_all_locations()
    return {"total": len(usuarios), "usuarios": usuarios}


@app.get("/zones", tags=["API"])
async def get_zones():
    return {"zones": ALLOWED_ZONES}


@app.get("/stats", tags=["API"])
async def stats():
    usuarios = manager.get_all_locations()
    estudiantes = sum(1 for u in usuarios if u["role"] == "estudiante")
    conductores = sum(1 for u in usuarios if u["role"] == "conductor")
    return {"estudiantes_activos": estudiantes, "conductores_activos": conductores, "total": len(usuarios)}

# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, db: Session = Depends(get_db)):
    cookie = websocket.cookies.get(COOKIE_NAME)
    user = get_user_from_cookie(cookie, db)
    if not user:
        await websocket.close(code=4001)
        return
    if not user.is_verified:
        await websocket.close(code=4003)
        return

    session_id = str(uuid.uuid4())
    await manager.connect(websocket, session_id)

    await websocket.send_text(json.dumps({
        "type": "snapshot",
        "users": manager.get_all_locations(),
        "zones": ALLOWED_ZONES,
    }))

    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            msg_type = payload.get("type", "location")

            if msg_type == "location" or msg_type not in (
                "trip_request", "trip_cancel", "trip_accept", "trip_reject",
                "zone_set", "passenger_onboard", "passenger_dropoff", "quick_message",
            ):
                update = LocationUpdate(**{k: v for k, v in payload.items() if k != "type"})
                rating_avg = None
                if user.role == "conductor" and user.rating_count:
                    rating_avg = round(user.rating_sum / user.rating_count, 1)

                location = UserLocation(
                    id=session_id,
                    lat=update.lat,
                    lng=update.lng,
                    role=user.role,
                    name=user.name,
                    status=update.status,
                    manual_passengers=update.manual_passengers,
                    connected_at=manager.get_connected_at(session_id),
                    zone_destination=payload.get("zone_destination"),
                    conductor_db_id=user.id if user.role == "conductor" and user.conductor_status == "approved" else None,
                    rating_avg=rating_avg,
                )
                location = manager.set_location(session_id, location)
                await manager.broadcast({"type": "update", "user": location.model_dump()})

            elif msg_type == "trip_request":
                zone = payload.get("zone_destination", "")
                loc_data = manager.active.get(session_id, (None, None))[1]
                if not loc_data:
                    await manager.send_to(session_id, {"type": "trip_rejected", "reason": "no_location"})
                    continue
                request_id = await trip_manager.create_request(
                    student_session=session_id,
                    student_db_id=user.id,
                    student_name=user.name,
                    lat=loc_data.lat,
                    lng=loc_data.lng,
                    zone=zone,
                    db=db,
                )
                if not request_id:
                    await manager.send_to(session_id, {
                        "type": "trip_rejected",
                        "request_id": None,
                        "reason": "no_conductors",
                    })

            elif msg_type == "trip_cancel":
                await trip_manager.cancel_request(session_id)

            elif msg_type == "trip_accept":
                request_id = payload.get("request_id")
                if request_id:
                    await trip_manager.accept_request(session_id, request_id, db)

            elif msg_type == "trip_reject":
                request_id = payload.get("request_id")
                if request_id:
                    await trip_manager.reject_request(session_id, request_id)

            elif msg_type == "zone_set":
                zone = payload.get("zone", "")
                loc_data = manager.active.get(session_id, (None, None))[1]
                if loc_data:
                    updated = loc_data.model_copy(update={"zone_destination": zone})
                    manager.active[session_id] = (manager.active[session_id][0], updated)
                    await manager.broadcast({"type": "update", "user": updated.model_dump()})

            elif msg_type == "passenger_onboard":
                trip_id = payload.get("trip_id")
                if trip_id:
                    await trip_manager.mark_onboard(session_id, int(trip_id), db)

            elif msg_type == "passenger_dropoff":
                trip_id = payload.get("trip_id")
                student_db_id = payload.get("student_db_id", 0)
                if trip_id:
                    await trip_manager.mark_dropoff(session_id, int(trip_id), int(student_db_id), db)

            elif msg_type == "quick_message":
                trip_id = payload.get("trip_id")
                message_key = payload.get("message_key", "")
                if trip_id and message_key:
                    await trip_manager.send_quick_message(session_id, int(trip_id), message_key)

    except WebSocketDisconnect:
        await trip_manager.cancel_request(session_id)
        manager.disconnect(session_id)
        await manager.broadcast({"type": "remove", "id": session_id})
