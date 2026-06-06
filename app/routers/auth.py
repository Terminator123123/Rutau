import json
import time
import urllib.parse
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from sqlalchemy.orm import Session

from app.auth import (
    COOKIE_NAME, INFO_COOKIE_NAME, TOKEN_EXPIRE_DAYS,
    generate_token, get_current_user, hash_password, verify_password, create_token,
)
from app.database import get_db, User
from app.email_service import send_reset_email, send_verification_email
from app.models import (
    ForgotPasswordRequest, LoginRequest, RegisterRequest,
    ResetPasswordRequest, UserOut,
)
from app.utils import _user_out, _page, _is_prod

router = APIRouter(tags=["Auth"])


@router.post("/register", response_model=UserOut)
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


@router.get("/verify-email", include_in_schema=False)
def verify_email(token: str, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.verification_token == token).first()
    if not user:
        return HTMLResponse(_page("Token inválido", "El enlace de verificación no es válido o ya fue usado.", error=True))
    user.is_verified = True
    user.verification_token = None
    db.commit()
    return RedirectResponse(url="/dev?verified=1")


@router.post("/login", response_model=UserOut)
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


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(key=COOKIE_NAME)
    response.delete_cookie(key=INFO_COOKIE_NAME)
    return {"message": "Sesión cerrada"}


@router.get("/me", response_model=UserOut)
def me(current_user: User = Depends(get_current_user)):
    return _user_out(current_user)


@router.delete("/me")
def delete_me(response: Response, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.delete(current_user)
    db.commit()
    response.delete_cookie(key=COOKIE_NAME)
    response.delete_cookie(key=INFO_COOKIE_NAME)
    return {"message": "Cuenta eliminada"}


@router.patch("/me", response_model=UserOut)
def update_me(body: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    new_name = (body.get("name") or "").strip()
    new_pass = body.get("password") or ""
    if not new_name and not new_pass:
        raise HTTPException(status_code=400, detail="Nada que actualizar")
    if new_name:
        current_user.name = new_name
    if new_pass:
        if len(new_pass) < 6:
            raise HTTPException(status_code=400, detail="La contraseña debe tener al menos 6 caracteres")
        current_user.hashed_password = hash_password(new_pass)
    db.commit()
    db.refresh(current_user)
    return _user_out(current_user)


@router.post("/forgot-password")
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


@router.get("/reset-password", include_in_schema=False)
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


@router.post("/reset-password")
def reset_password(body: ResetPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.reset_token == body.token).first()
    if not user or not user.reset_token_expires or datetime.now(timezone.utc).timestamp() > user.reset_token_expires:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Token inválido o expirado")
    user.hashed_password = hash_password(body.new_password)
    user.reset_token = None
    user.reset_token_expires = None
    db.commit()
    return {"message": "Contraseña actualizada correctamente"}
