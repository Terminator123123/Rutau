from pydantic import BaseModel
from typing import Literal, Optional


class LocationUpdate(BaseModel):
    lat: float
    lng: float
    role: Literal["estudiante", "conductor"]
    name: str
    status: Optional[Literal["disponible", "lleno", "en camino"]] = None


class UserLocation(BaseModel):
    id: str
    lat: float
    lng: float
    role: Literal["estudiante", "conductor"]
    name: str
    status: Optional[Literal["disponible", "lleno", "en camino"]] = None
    connected_at: float
