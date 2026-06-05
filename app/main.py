import json
import os
import secrets as _secrets
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import (
    BackgroundTasks, FastAPI, File, HTTPException, Request,
    UploadFile, WebSocket, WebSocketDisconnect, Depends, status,
)
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from app.database import get_db, User, Trip, UPLOADS_DIR
from app.email_service import send_reset_email, send_verification_email
from app.manager import manager, trip_manager
from app.models import (
    ALLOWED_ZONES, QUICK_MESSAGES,
    ConductorProfileOut, ForgotPasswordRequest,
    LocationUpdate, LoginRequest, RegisterRequest,
    ResetPasswordRequest, TokenResponse, TripRatingRequest,
    UserLocation, UserOut,
)
from app.auth import (
    COOKIE_NAME, INFO_COOKIE_NAME, TOKEN_EXPIRE_DAYS,
    generate_token, get_approved_conductor, get_current_user,
    get_user_from_cookie, hash_password, verify_password, create_token,
)

_is_prod = os.getenv("DB_URL", "").startswith("postgresql")
_basic = HTTPBasic()

# Allowed file types for document uploads
_ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp", "application/pdf"}
_ALLOWED_EXT  = {".jpg", ".jpeg", ".png", ".webp", ".pdf"}
_MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_SIZE_MB", "5")) * 1024 * 1024

app = FastAPI(
    title="ColectivoU",
    description="API de coordinacion de transporte colectivo en tiempo real — Universidad de La Guajira",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
)


def _require_admin(credentials: HTTPBasicCredentials = Depends(_basic)):
    admin_user = os.getenv("ADMIN_USER", "admin")
    admin_pass = os.getenv("ADMIN_PASSWORD", "colectivou2026")
    ok = (
        _secrets.compare_digest(credentials.username.encode(), admin_user.encode()) and
        _secrets.compare_digest(credentials.password.encode(), admin_pass.encode())
    )
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            headers={"WWW-Authenticate": "Basic"},
            detail="Acceso denegado",
        )
    return credentials


app.mount("/static", StaticFiles(directory="static"), name="static")


# ── Protected docs ────────────────────────────────────────────────────────────

@app.get("/docs", include_in_schema=False)
async def docs(_=Depends(_require_admin)):
    return get_swagger_ui_html(openapi_url="/openapi.json", title="ColectivoU · Docs")


@app.get("/openapi.json", include_in_schema=False)
async def openapi(_=Depends(_require_admin)):
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


# ── Auth endpoints ────────────────────────────────────────────────────────────

@app.post("/register", response_model=UserOut, tags=["Auth"])
def register(body: RegisterRequest, background: BackgroundTasks, response: Response, db: Session = Depends(get_db)):
    if not body.terms_accepted:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Debes aceptar los términos y condiciones")
    if db.query(User).filter(User.email == body.email).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email ya registrado")

    ver_token = generate_token()
    user = User(
        name=body.name,
        email=body.email,
        hashed_password=hash_password(body.password),
        role=body.role,
        is_verified=False,
        verification_token=ver_token,
        terms_accepted_at=time.time(),
        conductor_status="pending" if body.role == "conductor" else None,
        rating_sum=0.0,
        rating_count=0,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    background.add_task(_send_verification, user.email, user.name, ver_token)

    return _user_out(user)


def _send_verification(email: str, name: str, token: str):
    try:
        send_verification_email(email, name, token)
    except Exception as e:
        print(f"[EMAIL] Error enviando verificación a {email}: {e}")


@app.get("/verify-email", include_in_schema=False)
def verify_email(token: str, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.verification_token == token).first()
    if not user:
        return HTMLResponse(_page("Token inválido", "El enlace de verificación no es válido o ya fue usado.", error=True))
    user.is_verified = True
    user.verification_token = None
    db.commit()
    return RedirectResponse(url="/dev?verified=1")


@app.post("/login", response_model=UserOut, tags=["Auth"])
def login(body: LoginRequest, response: Response, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == body.email).first()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciales incorrectas")
    if not user.is_verified:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cuenta no verificada. Revisa tu correo.")

    _max_age = TOKEN_EXPIRE_DAYS * 24 * 3600
    response.set_cookie(
        key=COOKIE_NAME, value=create_token(user),
        httponly=True, secure=_is_prod, samesite="lax", max_age=_max_age,
    )
    _info = urllib.parse.quote(json.dumps({
        "name": user.name,
        "role": user.role,
        "id": user.id,
        "conductor_status": user.conductor_status,
    }))
    response.set_cookie(
        key=INFO_COOKIE_NAME, value=_info,
        httponly=False, secure=_is_prod, samesite="lax", max_age=_max_age,
    )
    return _user_out(user)


@app.post("/logout", tags=["Auth"])
def logout(response: Response):
    response.delete_cookie(key=COOKIE_NAME)
    response.delete_cookie(key=INFO_COOKIE_NAME)
    return {"message": "Sesión cerrada"}


@app.get("/me", response_model=UserOut, tags=["Auth"])
def me(current_user: User = Depends(get_current_user)):
    return _user_out(current_user)


@app.delete("/me", tags=["Auth"])
def delete_me(response: Response, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.delete(current_user)
    db.commit()
    response.delete_cookie(key=COOKIE_NAME)
    response.delete_cookie(key=INFO_COOKIE_NAME)
    return {"message": "Cuenta eliminada"}


@app.post("/forgot-password", tags=["Auth"])
def forgot_password(body: ForgotPasswordRequest, background: BackgroundTasks, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == body.email).first()
    if user and user.is_verified:
        token = generate_token()
        user.reset_token = token
        user.reset_token_expires = datetime.now(timezone.utc).timestamp() + 1800
        db.commit()
        background.add_task(_send_reset, user.email, user.name, token)
    return {"message": "Si el email existe, recibirás un enlace para restablecer tu contraseña."}


def _send_reset(email: str, name: str, token: str):
    try:
        send_reset_email(email, name, token)
    except Exception as e:
        print(f"[EMAIL] Error enviando reset a {email}: {e}")


@app.get("/reset-password", include_in_schema=False)
def reset_password_page(token: str, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.reset_token == token).first()
    if not user or not user.reset_token_expires or datetime.now(timezone.utc).timestamp() > user.reset_token_expires:
        return HTMLResponse(_page("Enlace expirado", "Este enlace ya no es válido. Solicita uno nuevo.", error=True))

    html = f"""<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Nueva contraseña — ColectivoU</title>
    <style>*{{margin:0;padding:0;box-sizing:border-box}}
    body{{font-family:'Segoe UI',sans-serif;background:#0f172a;color:#f1f5f9;min-height:100vh;display:flex;align-items:center;justify-content:center}}
    .card{{background:#1e293b;border-radius:1.25rem;padding:2.5rem 2rem;max-width:360px;width:90%;text-align:center}}
    h1{{font-size:1.5rem;margin-bottom:.5rem;color:#818cf8}}
    p{{color:#94a3b8;margin-bottom:1.5rem;font-size:.9rem}}
    input{{width:100%;padding:.75rem 1rem;border-radius:.75rem;border:1px solid #334155;background:#0f172a;color:#f1f5f9;font-size:1rem;margin-bottom:1rem}}
    button{{width:100%;padding:.75rem;border-radius:.75rem;border:none;background:#6366f1;color:white;font-size:1rem;font-weight:600;cursor:pointer}}
    .msg{{margin-top:1rem;font-size:.9rem}}</style></head>
    <body><div class="card">
    <h1>Nueva contraseña</h1><p>Ingresa tu nueva contraseña para ColectivoU</p>
    <form id="form">
      <input type="password" id="pwd" placeholder="Nueva contraseña" required minlength="6">
      <input type="password" id="pwd2" placeholder="Confirmar contraseña" required minlength="6">
      <button type="submit">Guardar contraseña</button>
    </form>
    <div class="msg" id="msg"></div></div>
    <script>
    document.getElementById('form').onsubmit=async e=>{{
      e.preventDefault();
      const p=document.getElementById('pwd').value;
      const p2=document.getElementById('pwd2').value;
      const msg=document.getElementById('msg');
      if(p!==p2){{msg.textContent='Las contraseñas no coinciden';return}}
      const r=await fetch('/reset-password',{{method:'POST',headers:{{'Content-Type':'application/json'}},
        body:JSON.stringify({{token:'{token}',new_password:p}})}});
      const d=await r.json();
      if(r.ok){{msg.style.color='#4ade80';msg.textContent='¡Contraseña actualizada! Redirigiendo...';setTimeout(()=>location.href='/dev',2000)}}
      else{{msg.style.color='#f87171';msg.textContent=d.detail||'Error'}}
    }};
    </script></body></html>"""
    return HTMLResponse(html)


@app.post("/reset-password", tags=["Auth"])
def reset_password(body: ResetPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.reset_token == body.token).first()
    if not user or not user.reset_token_expires or datetime.now(timezone.utc).timestamp() > user.reset_token_expires:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Token inválido o expirado")
    user.hashed_password = hash_password(body.new_password)
    user.reset_token = None
    user.reset_token_expires = None
    db.commit()
    return {"message": "Contraseña actualizada correctamente"}


# ── Conductor document upload ─────────────────────────────────────────────────

def _validate_file(file: UploadFile, contents: bytes):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(400, f"Formato no permitido. Usa: {', '.join(_ALLOWED_EXT)}")
    if len(contents) > _MAX_UPLOAD_BYTES:
        raise HTTPException(400, f"Archivo demasiado grande. Máximo {_MAX_UPLOAD_BYTES // (1024*1024)} MB")
    # Check magic bytes
    magic = {
        b"\xff\xd8\xff": "jpg",
        b"\x89PNG": "png",
        b"RIFF": "webp",
        b"%PDF": "pdf",
    }
    valid = any(contents.startswith(sig) for sig in magic)
    if not valid:
        raise HTTPException(400, "El archivo no parece ser una imagen o PDF válido")


@app.post("/conductor/documents", tags=["Conductor"])
async def upload_documents(
    cedula:  UploadFile = File(...),
    selfie:  UploadFile = File(...),
    plate:   UploadFile = File(...),
    soat:    UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "conductor":
        raise HTTPException(403, "Solo conductores pueden subir documentos")
    if current_user.conductor_status == "approved":
        raise HTTPException(400, "Tu cuenta ya está aprobada")

    files = {"cedula": cedula, "selfie": selfie, "plate": plate, "soat": soat}
    paths = {}

    for doc_type, upload in files.items():
        contents = await upload.read()
        _validate_file(upload, contents)
        ext = Path(upload.filename or "file").suffix.lower() or ".jpg"
        filename = f"{doc_type}_{int(time.time())}{ext}"
        user_dir = os.path.join(UPLOADS_DIR, str(current_user.id))
        os.makedirs(user_dir, exist_ok=True)
        filepath = os.path.join(user_dir, filename)
        with open(filepath, "wb") as f:
            f.write(contents)
        paths[doc_type] = filepath

    user = db.query(User).filter(User.id == current_user.id).first()
    user.cedula_path = paths["cedula"]
    user.selfie_path = paths["selfie"]
    user.plate_path  = paths["plate"]
    user.soat_path   = paths["soat"]
    user.conductor_status = "pending"
    db.commit()

    return {"message": "Documentos recibidos. Tu cuenta será revisada pronto."}


@app.get("/conductor/status", tags=["Conductor"])
def conductor_status(current_user: User = Depends(get_current_user)):
    if current_user.role != "conductor":
        raise HTTPException(403, "Solo conductores")
    return {
        "conductor_status": current_user.conductor_status,
        "has_documents": bool(current_user.cedula_path),
    }


# ── Trip endpoints ────────────────────────────────────────────────────────────

@app.post("/trips/{trip_id}/rate", tags=["Trips"])
def rate_trip(
    trip_id: int,
    body: TripRatingRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not (1 <= body.rating <= 5):
        raise HTTPException(400, "Calificación debe ser entre 1 y 5")

    trip = db.query(Trip).filter(Trip.id == trip_id, Trip.student_id == current_user.id).first()
    if not trip:
        raise HTTPException(404, "Viaje no encontrado")
    if trip.rating is not None:
        raise HTTPException(400, "Ya calificaste este viaje")
    if trip.status != "completed":
        raise HTTPException(400, "El viaje no ha terminado aún")

    trip.rating = body.rating
    db.commit()

    # Update conductor rating
    conductor = db.query(User).filter(User.id == trip.conductor_id).first()
    if conductor:
        conductor.rating_sum = (conductor.rating_sum or 0) + body.rating
        conductor.rating_count = (conductor.rating_count or 0) + 1
        db.commit()

    return {"message": "Calificación guardada"}


@app.get("/conductors/{conductor_id}/profile", response_model=ConductorProfileOut, tags=["Trips"])
def conductor_profile(conductor_id: int, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == conductor_id, User.role == "conductor").first()
    if not user:
        raise HTTPException(404, "Conductor no encontrado")
    avg = None
    if user.rating_count and user.rating_count > 0:
        avg = round((user.rating_sum or 0) / user.rating_count, 1)
    return ConductorProfileOut(
        id=user.id, name=user.name,
        rating_avg=avg, rating_count=user.rating_count or 0,
    )


# ── Admin endpoints ───────────────────────────────────────────────────────────

@app.get("/admin/users", tags=["Admin"])
def admin_list_users(db: Session = Depends(get_db), _=Depends(_require_admin)):
    users = db.query(User).order_by(User.id).all()
    return [
        {
            "id": u.id, "name": u.name, "email": u.email,
            "role": u.role, "is_verified": u.is_verified,
            "conductor_status": u.conductor_status,
            "has_documents": bool(u.cedula_path),
            "rating_avg": round(u.rating_sum / u.rating_count, 1) if u.rating_count else None,
        }
        for u in users
    ]


@app.delete("/admin/users/{email}", tags=["Admin"])
def admin_delete_user(email: str, db: Session = Depends(get_db), _=Depends(_require_admin)):
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    db.delete(user)
    db.commit()
    return {"message": f"Usuario {email} eliminado"}


@app.post("/admin/users/{email}/verify", tags=["Admin"])
def admin_verify_user(email: str, db: Session = Depends(get_db), _=Depends(_require_admin)):
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    user.is_verified = True
    user.verification_token = None
    db.commit()
    return {"message": f"Usuario {email} verificado", "user": {"id": user.id, "name": user.name}}


@app.get("/admin/conductors/pending", tags=["Admin"])
def admin_pending_conductors(db: Session = Depends(get_db), _=Depends(_require_admin)):
    users = db.query(User).filter(
        User.role == "conductor",
        User.conductor_status == "pending",
    ).all()
    return [
        {
            "id": u.id, "name": u.name, "email": u.email,
            "is_verified": u.is_verified,
            "has_cedula": bool(u.cedula_path),
            "has_selfie": bool(u.selfie_path),
            "has_plate":  bool(u.plate_path),
            "has_soat":   bool(u.soat_path),
        }
        for u in users
    ]


@app.post("/admin/conductors/{user_id}/approve", tags=["Admin"])
def admin_approve_conductor(user_id: int, db: Session = Depends(get_db), _=Depends(_require_admin)):
    user = db.query(User).filter(User.id == user_id, User.role == "conductor").first()
    if not user:
        raise HTTPException(404, "Conductor no encontrado")
    user.conductor_status = "approved"
    db.commit()
    return {"message": f"Conductor {user.name} aprobado"}


@app.post("/admin/conductors/{user_id}/reject", tags=["Admin"])
def admin_reject_conductor(user_id: int, db: Session = Depends(get_db), _=Depends(_require_admin)):
    user = db.query(User).filter(User.id == user_id, User.role == "conductor").first()
    if not user:
        raise HTTPException(404, "Conductor no encontrado")
    user.conductor_status = "rejected"
    db.commit()
    return {"message": f"Conductor {user.name} rechazado"}


@app.get("/admin/documents/{user_id}/{filename}", tags=["Admin"])
def admin_get_document(user_id: int, filename: str, _=Depends(_require_admin)):
    # Sanitize filename to prevent path traversal
    safe_filename = Path(filename).name
    filepath = os.path.join(UPLOADS_DIR, str(user_id), safe_filename)
    if not os.path.exists(filepath):
        raise HTTPException(404, "Documento no encontrado")
    return FileResponse(filepath)


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

            # ── Location update (legacy / default) ──────────────────────────
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

            # ── Trip request ─────────────────────────────────────────────────
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

            # ── Cancel request ────────────────────────────────────────────────
            elif msg_type == "trip_cancel":
                await trip_manager.cancel_request(session_id)

            # ── Accept request (conductor) ────────────────────────────────────
            elif msg_type == "trip_accept":
                request_id = payload.get("request_id")
                if request_id:
                    await trip_manager.accept_request(session_id, request_id, db)

            # ── Reject request (conductor) ────────────────────────────────────
            elif msg_type == "trip_reject":
                request_id = payload.get("request_id")
                if request_id:
                    await trip_manager.reject_request(session_id, request_id)

            # ── Zone set (conductor declares destination) ──────────────────────
            elif msg_type == "zone_set":
                zone = payload.get("zone", "")
                loc_data = manager.active.get(session_id, (None, None))[1]
                if loc_data:
                    updated = loc_data.model_copy(update={"zone_destination": zone})
                    manager.active[session_id] = (manager.active[session_id][0], updated)
                    await manager.broadcast({"type": "update", "user": updated.model_dump()})

            # ── Passenger onboard (conductor marks student aboard) ─────────────
            elif msg_type == "passenger_onboard":
                trip_id = payload.get("trip_id")
                if trip_id:
                    await trip_manager.mark_onboard(session_id, int(trip_id), db)

            # ── Passenger dropoff (conductor marks student off) ────────────────
            elif msg_type == "passenger_dropoff":
                trip_id = payload.get("trip_id")
                student_db_id = payload.get("student_db_id", 0)
                if trip_id:
                    await trip_manager.mark_dropoff(session_id, int(trip_id), int(student_db_id), db)

            # ── Quick message (conductor → student) ───────────────────────────
            elif msg_type == "quick_message":
                trip_id = payload.get("trip_id")
                message_key = payload.get("message_key", "")
                if trip_id and message_key:
                    await trip_manager.send_quick_message(session_id, int(trip_id), message_key)

    except WebSocketDisconnect:
        await trip_manager.cancel_request(session_id)
        manager.disconnect(session_id)
        await manager.broadcast({"type": "remove", "id": session_id})


# ── Helpers ───────────────────────────────────────────────────────────────────

def _user_out(user: User) -> UserOut:
    count = user.rating_count or 0
    avg = round((user.rating_sum or 0) / count, 1) if count > 0 else None
    return UserOut(
        id=user.id, name=user.name, email=user.email,
        role=user.role, conductor_status=user.conductor_status,
        rating_avg=avg, rating_count=count,
    )


def _page(title: str, message: str, error: bool = False) -> str:
    color = "#f87171" if error else "#4ade80"
    return f"""<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <title>{title} — ColectivoU</title>
    <style>*{{margin:0;padding:0;box-sizing:border-box}}
    body{{font-family:'Segoe UI',sans-serif;background:#0f172a;color:#f1f5f9;min-height:100vh;display:flex;align-items:center;justify-content:center}}
    .card{{background:#1e293b;border-radius:1.25rem;padding:2.5rem 2rem;max-width:360px;width:90%;text-align:center}}
    h1{{font-size:1.5rem;margin-bottom:1rem;color:{color}}}
    a{{color:#818cf8}}</style></head>
    <body><div class="card"><h1>{title}</h1><p>{message}</p>
    <p style="margin-top:1.5rem"><a href="/dev">← Volver al inicio</a></p>
    </div></body></html>"""
