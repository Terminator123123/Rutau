import os
import secrets as _secrets

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

# auto_error=False: FastAPI no lanza 401 automáticamente con WWW-Authenticate: Basic.
# Chrome intercepta ese header y abre su diálogo nativo de credenciales, rompiendo el
# flujo del panel admin que ya tiene su propio formulario de login.
_basic = HTTPBasic(auto_error=False)


def require_admin(credentials: HTTPBasicCredentials | None = Depends(_basic)):
    admin_user = os.getenv("ADMIN_USER", "admin")
    admin_pass = os.getenv("ADMIN_PASSWORD", "colectivou2026")

    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Acceso denegado")

    ok = (
        _secrets.compare_digest(credentials.username.encode(), admin_user.encode()) and
        _secrets.compare_digest(credentials.password.encode(), admin_pass.encode())
    )
    if not ok:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Acceso denegado")
    return credentials
