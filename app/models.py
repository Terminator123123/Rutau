from pydantic import BaseModel
from typing import Literal, Optional


class LocationUpdate(BaseModel):
    lat: float
    lng: float
    role: Literal["estudiante", "conductor"]
    name: str
    status: Optional[Literal["disponible", "lleno", "en camino"]] = None
    manual_passengers: int = 0  # pasajeros sin app reportados por el conductor


class UserLocation(BaseModel):
    id: str
    lat: float
    lng: float
    role: Literal["estudiante", "conductor"]
    name: str
    status: Optional[Literal["disponible", "lleno", "en camino"]] = None
    connected_at: float
    manual_passengers: int = 0
    onboard_count: int = 0      # calculado por el servidor (app + manuales)
