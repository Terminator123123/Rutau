import os
import secrets as _secrets

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

_basic = HTTPBasic()


def require_admin(credentials: HTTPBasicCredentials = Depends(_basic)):
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
