from pydantic import BaseModel
from typing import Literal


class LocationUpdate(BaseModel):
    lat: float
    lng: float
    role: Literal["estudiante", "conductor"]


class UserLocation(BaseModel):
    id: str
    lat: float
    lng: float
    role: Literal["estudiante", "conductor"]
