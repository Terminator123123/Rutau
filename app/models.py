from pydantic import BaseModel, EmailStr
from typing import Literal, Optional


# ── Auth schemas ──────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    name:             str
    email:            EmailStr
    password:         str
    role:             Literal["estudiante", "conductor"]
    terms_accepted:   bool


class LoginRequest(BaseModel):
    email:    EmailStr
    password: str


class UserOut(BaseModel):
    id:               int
    name:             str
    email:            str
    role:             str
    conductor_status: Optional[str] = None
    rating_avg:       Optional[float] = None


class TokenResponse(BaseModel):
    access_token: str
    token_type:   str = "bearer"
    user:         UserOut


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token:        str
    new_password: str


# ── Location schemas ──────────────────────────────────────────────────────────

class LocationUpdate(BaseModel):
    lat:               float
    lng:               float
    status:            Optional[Literal["disponible", "lleno", "en camino"]] = None
    manual_passengers: int = 0


class UserLocation(BaseModel):
    id:                str
    lat:               float
    lng:               float
    role:              Literal["estudiante", "conductor"]
    name:              str
    status:            Optional[Literal["disponible", "lleno", "en camino"]] = None
    connected_at:      float
    manual_passengers: int = 0
    onboard_count:     int = 0
    zone_destination:  Optional[str] = None
    conductor_db_id:   Optional[int] = None
    rating_avg:        Optional[float] = None


# ── Trip schemas ──────────────────────────────────────────────────────────────

class TripRatingRequest(BaseModel):
    rating: int   # 1-5


class ConductorProfileOut(BaseModel):
    id:          int
    name:        str
    rating_avg:  Optional[float]
    rating_count: int


# ── Conductor document upload ─────────────────────────────────────────────────

ALLOWED_ZONES = [
    "Rompoi",
    "Centro",
    "Simón Bolívar",
    "Villa Martín",
    "Invasión",
    "AV del Estudiante",
    "Barrio Olímpico",
    "El Esfuerzo",
    "Cuestecita",
    "Galerías",
    "Boca Grande",
    "Las Palmas",
    "Otro",
]

QUICK_MESSAGES = {
    "coming":    "Ya voy, espérate",
    "2min":      "Estoy a 2 minutos",
    "arrived":   "Llegué, estoy afuera",
    "cant_pick": "No puedo recogerte, busca otro",
}
