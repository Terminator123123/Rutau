import json
import time
import uuid
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, Query, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db, User
from app.manager import manager
from app.models import LocationUpdate, UserLocation, RegisterRequest, LoginRequest, TokenResponse, UserOut
from app.auth import hash_password, verify_password, create_token, get_current_user, get_user_from_token_str

app = FastAPI(
    title="ColectivoU",
    description="API de coordinacion de transporte colectivo en tiempo real — Universidad de La Guajira",
    version="1.0.0",
)

app.mount("/static", StaticFiles(directory="static"), name="static")


# ── Static pages ──────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def index():
    return FileResponse("static/index.html")


@app.get("/dev", include_in_schema=False)
async def dev():
    return FileResponse("static/dev.html")


# ── Auth endpoints ────────────────────────────────────────────────────────────

@app.post("/register", response_model=TokenResponse, tags=["Auth"])
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    """Registra un nuevo usuario y devuelve un token JWT."""
    if db.query(User).filter(User.email == body.email).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email ya registrado")

    user = User(
        name=body.name,
        email=body.email,
        hashed_password=hash_password(body.password),
        role=body.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return TokenResponse(
        access_token=create_token(user),
        user=UserOut(id=user.id, name=user.name, email=user.email, role=user.role),
    )


@app.post("/login", response_model=TokenResponse, tags=["Auth"])
def login(body: LoginRequest, db: Session = Depends(get_db)):
    """Inicia sesion y devuelve un token JWT."""
    user = db.query(User).filter(User.email == body.email).first()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciales incorrectas")

    return TokenResponse(
        access_token=create_token(user),
        user=UserOut(id=user.id, name=user.name, email=user.email, role=user.role),
    )


@app.get("/me", response_model=UserOut, tags=["Auth"])
def me(current_user: User = Depends(get_current_user)):
    """Devuelve el perfil del usuario autenticado."""
    return UserOut(
        id=current_user.id,
        name=current_user.name,
        email=current_user.email,
        role=current_user.role,
    )


# ── API endpoints ─────────────────────────────────────────────────────────────

@app.get("/health", tags=["API"])
async def health():
    """Estado del servidor."""
    return {"status": "ok", "app": "ColectivoU"}


@app.get("/usuarios/activos", tags=["API"])
async def usuarios_activos():
    """Lista de usuarios conectados en este momento."""
    usuarios = manager.get_all_locations()
    return {"total": len(usuarios), "usuarios": usuarios}


@app.get("/stats", tags=["API"])
async def stats():
    """Conteo de estudiantes y conductores activos."""
    usuarios = manager.get_all_locations()
    estudiantes = sum(1 for u in usuarios if u["role"] == "estudiante")
    conductores = sum(1 for u in usuarios if u["role"] == "conductor")
    return {"estudiantes_activos": estudiantes, "conductores_activos": conductores, "total": len(usuarios)}


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str = Query(...),
    db: Session = Depends(get_db),
):
    user = get_user_from_token_str(token, db)
    if not user:
        await websocket.close(code=4001)
        return

    session_id = str(uuid.uuid4())
    await manager.connect(websocket, session_id)

    await websocket.send_text(json.dumps({
        "type": "snapshot",
        "users": manager.get_all_locations(),
    }))

    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            update = LocationUpdate(**payload)

            location = UserLocation(
                id=session_id,
                lat=update.lat,
                lng=update.lng,
                role=user.role,
                name=user.name,
                status=update.status,
                manual_passengers=update.manual_passengers,
                connected_at=manager.get_connected_at(session_id),
            )
            location = manager.set_location(session_id, location)

            await manager.broadcast({"type": "update", "user": location.model_dump()})
    except WebSocketDisconnect:
        manager.disconnect(session_id)
        await manager.broadcast({"type": "remove", "id": session_id})
