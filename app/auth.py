import os
import secrets
from datetime import datetime, timedelta, timezone
from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.database import get_db, User

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    import sys
    print("[WARNING] SECRET_KEY no está configurada. Usando clave de desarrollo insegura. ¡Configura SECRET_KEY en producción!", file=sys.stderr)
    SECRET_KEY = "colectivou-dev-secret-2026"
ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 7
COOKIE_NAME = "cu_session"
INFO_COOKIE_NAME = "cu_info"

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def generate_token() -> str:
    return secrets.token_hex(32)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_token(user: User) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS)
    return jwt.encode(
        {"sub": str(user.id), "exp": expire},
        SECRET_KEY,
        algorithm=ALGORITHM,
    )


def decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])


def get_current_user(
    cu_session: str = Cookie(None),
    db: Session = Depends(get_db),
) -> User:
    if not cu_session:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No autenticado")
    try:
        payload = decode_token(cu_session)
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesion invalida")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuario no encontrado")
    if not user.is_verified:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cuenta no verificada. Revisa tu correo.")
    return user


def get_approved_conductor(user: User = Depends(get_current_user)) -> User:
    """Dependencia para endpoints exclusivos de conductores aprobados."""
    if user.role != "conductor":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo conductores pueden acceder a esto")
    if user.conductor_status != "approved":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tu cuenta de conductor está pendiente de aprobación"
        )
    return user


def get_user_from_cookie(cookie_value: str | None, db: Session) -> User | None:
    """Used by WebSocket — reads token from cookie value."""
    if not cookie_value:
        return None
    try:
        payload = decode_token(cookie_value)
        user_id = int(payload["sub"])
        return db.query(User).filter(User.id == user_id).first()
    except Exception:
        return None
