import json
import os
import secrets as _secrets
import time
import urllib.parse
import uuid
from datetime import datetime, timezone

from fastapi import BackgroundTasks, FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, Request, status
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from app.database import get_db, User
from app.email_service import send_reset_email, send_verification_email
from app.manager import manager
from app.models import (
    ForgotPasswordRequest,
    LocationUpdate,
    LoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
    TokenResponse,
    UserLocation,
    UserOut,
)
from app.auth import (
    COOKIE_NAME,
    INFO_COOKIE_NAME,
    TOKEN_EXPIRE_DAYS,
    generate_token,
    get_current_user,
    get_user_from_cookie,
    hash_password,
    verify_password,
    create_token,
)

_is_prod = os.getenv("DB_URL", "").startswith("postgresql")
_basic = HTTPBasic()

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


# ── Admin endpoints ───────────────────────────────────────────────────────────

@app.get("/admin/users", tags=["Admin"])
def admin_list_users(db: Session = Depends(get_db), _=Depends(_require_admin)):
    """Lista todos los usuarios registrados."""
    users = db.query(User).order_by(User.id).all()
    return [
        {
            "id": u.id,
            "name": u.name,
            "email": u.email,
            "role": u.role,
            "is_verified": u.is_verified,
            "has_reset_token": bool(u.reset_token),
        }
        for u in users
    ]


@app.delete("/admin/users/{email}", tags=["Admin"])
def admin_delete_user(email: str, db: Session = Depends(get_db), _=Depends(_require_admin)):
    """Elimina un usuario por email."""
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    db.delete(user)
    db.commit()
    return {"message": f"Usuario {email} eliminado"}


@app.post("/admin/users/{email}/verify", tags=["Admin"])
def admin_verify_user(email: str, db: Session = Depends(get_db), _=Depends(_require_admin)):
    """Verifica manualmente la cuenta de un usuario."""
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    user.is_verified = True
    user.verification_token = None
    db.commit()
    return {"message": f"Usuario {email} verificado", "user": {"id": user.id, "name": user.name}}


# ── Static pages ──────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def index():
    return FileResponse("static/index.html")


@app.get("/dev", include_in_schema=False)
async def dev():
    return FileResponse("static/dev.html")


# ── Auth endpoints ────────────────────────────────────────────────────────────

@app.post("/register", response_model=UserOut, tags=["Auth"])
def register(body: RegisterRequest, background: BackgroundTasks, response: Response, db: Session = Depends(get_db)):
    """Registra un nuevo usuario. Envía email de verificación antes de permitir el acceso."""
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
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    background.add_task(_send_verification, user.email, user.name, ver_token)

    return UserOut(id=user.id, name=user.name, email=user.email, role=user.role)


def _send_verification(email: str, name: str, token: str):
    try:
        send_verification_email(email, name, token)
    except Exception as e:
        print(f"[EMAIL] Error enviando verificación a {email}: {e}")


@app.get("/verify-email", include_in_schema=False)
def verify_email(token: str, db: Session = Depends(get_db)):
    """Verifica el email del usuario mediante el token enviado por correo."""
    user = db.query(User).filter(User.verification_token == token).first()
    if not user:
        return HTMLResponse(_page("Token inválido", "El enlace de verificación no es válido o ya fue usado.", error=True))

    user.is_verified = True
    user.verification_token = None
    db.commit()
    return RedirectResponse(url="/?verified=1")


@app.post("/login", response_model=UserOut, tags=["Auth"])
def login(body: LoginRequest, response: Response, db: Session = Depends(get_db)):
    """Inicia sesión. Establece cookie de sesión por 7 días."""
    user = db.query(User).filter(User.email == body.email).first()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciales incorrectas")
    if not user.is_verified:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cuenta no verificada. Revisa tu correo.")

    _max_age = TOKEN_EXPIRE_DAYS * 24 * 3600

    # Cookie segura (HttpOnly) con JWT — la usa el servidor para autenticar WebSocket
    response.set_cookie(
        key=COOKIE_NAME,
        value=create_token(user),
        httponly=True,
        secure=_is_prod,
        samesite="lax",
        max_age=_max_age,
    )
    # Cookie legible por JS con nombre y rol — el frontend la lee directo sin llamar al servidor
    _info = urllib.parse.quote(json.dumps({"name": user.name, "role": user.role, "id": user.id}))
    response.set_cookie(
        key=INFO_COOKIE_NAME,
        value=_info,
        httponly=False,
        secure=_is_prod,
        samesite="lax",
        max_age=_max_age,
    )
    return UserOut(id=user.id, name=user.name, email=user.email, role=user.role)


@app.post("/logout", tags=["Auth"])
def logout(response: Response):
    """Cierra sesión eliminando las cookies de sesión."""
    response.delete_cookie(key=COOKIE_NAME)
    response.delete_cookie(key=INFO_COOKIE_NAME)
    return {"message": "Sesión cerrada"}


@app.get("/me", response_model=UserOut, tags=["Auth"])
def me(current_user: User = Depends(get_current_user)):
    """Devuelve el perfil del usuario autenticado."""
    return UserOut(id=current_user.id, name=current_user.name, email=current_user.email, role=current_user.role)


def _send_reset(email: str, name: str, token: str):
    try:
        send_reset_email(email, name, token)
    except Exception as e:
        print(f"[EMAIL] Error enviando reset a {email}: {e}")


@app.post("/forgot-password", tags=["Auth"])
def forgot_password(body: ForgotPasswordRequest, background: BackgroundTasks, db: Session = Depends(get_db)):
    """Envía un email con enlace para restablecer contraseña."""
    user = db.query(User).filter(User.email == body.email).first()
    # Respuesta genérica para no revelar si el email existe
    if user and user.is_verified:
        token = generate_token()
        user.reset_token = token
        user.reset_token_expires = datetime.now(timezone.utc).timestamp() + 1800  # 30 min
        db.commit()
        background.add_task(_send_reset, user.email, user.name, token)

    return {"message": "Si el email existe, recibirás un enlace para restablecer tu contraseña."}


@app.get("/reset-password", include_in_schema=False)
def reset_password_page(token: str, db: Session = Depends(get_db)):
    """Muestra el formulario para restablecer contraseña."""
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
      if(r.ok){{msg.style.color='#4ade80';msg.textContent='¡Contraseña actualizada! Redirigiendo...';setTimeout(()=>location.href='/',2000)}}
      else{{msg.style.color='#f87171';msg.textContent=d.detail||'Error'}}
    }};
    </script></body></html>"""
    return HTMLResponse(html)


@app.post("/reset-password", tags=["Auth"])
def reset_password(body: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Restablece la contraseña usando el token enviado por email."""
    user = db.query(User).filter(User.reset_token == body.token).first()
    if not user or not user.reset_token_expires or datetime.now(timezone.utc).timestamp() > user.reset_token_expires:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Token inválido o expirado")

    user.hashed_password = hash_password(body.new_password)
    user.reset_token = None
    user.reset_token_expires = None
    db.commit()
    return {"message": "Contraseña actualizada correctamente"}


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
    db: Session = Depends(get_db),
):
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


# ── Helpers ───────────────────────────────────────────────────────────────────

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
    <p style="margin-top:1.5rem"><a href="/">← Volver al inicio</a></p>
    </div></body></html>"""
