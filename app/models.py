from pydantic import BaseModel, EmailStr
from typing import Literal, Optional


# ── Auth schemas ──────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    name: str
    email: EmailStr
    password: str
    role: Literal["estudiante", "conductor"]


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: int
    name: str
    email: str
    role: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ── Location schemas ──────────────────────────────────────────────────────────

class LocationUpdate(BaseModel):
    lat: float
    lng: float
    status: Optional[Literal["disponible", "lleno", "en camino"]] = None
    manual_passengers: int = 0


class UserLocation(BaseModel):
    id: str
    lat: float
    lng: float
    role: Literal["estudiante", "conductor"]
    name: str
    status: Optional[Literal["disponible", "lleno", "en camino"]] = None
    connected_at: float
    manual_passengers: int = 0
    onboard_count: int = 0
