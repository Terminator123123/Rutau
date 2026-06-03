import json
import math
import time
from fastapi import WebSocket
from app.models import UserLocation

MAX_PASSENGERS = 4
ONBOARD_RADIUS_M = 50  # metros para considerar un estudiante "a bordo"


def haversine(lat1, lng1, lat2, lng2) -> float:
    """Distance in meters between two GPS coordinates."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class ConnectionManager:
    def __init__(self):
        self.active: dict[str, tuple[WebSocket, UserLocation | None]] = {}
        self.connected_at: dict[str, float] = {}

    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        self.active[user_id] = (websocket, None)
        self.connected_at[user_id] = time.time()

    def set_location(self, user_id: str, location: UserLocation) -> UserLocation:
        """Store location and recalculate onboard count if conductor."""
        if location.role == "conductor":
            location = self._update_conductor(location)
        ws, _ = self.active[user_id]
        self.active[user_id] = (ws, location)
        return location

    def _update_conductor(self, conductor: UserLocation) -> UserLocation:
        app_onboard = sum(
            1 for _, loc in self.active.values()
            if loc and loc.role == "estudiante"
            and haversine(conductor.lat, conductor.lng, loc.lat, loc.lng) <= ONBOARD_RADIUS_M
        )
        total = app_onboard + conductor.manual_passengers
        new_status = "lleno" if total >= MAX_PASSENGERS else conductor.status

        return conductor.model_copy(update={
            "onboard_count": total,
            "status": new_status,
        })

    def disconnect(self, user_id: str):
        self.active.pop(user_id, None)
        self.connected_at.pop(user_id, None)

    def get_connected_at(self, user_id: str) -> float:
        return self.connected_at.get(user_id, time.time())

    def get_all_locations(self) -> list[dict]:
        return [
            loc.model_dump()
            for _, loc in self.active.values()
            if loc is not None
        ]

    async def broadcast(self, payload: dict):
        message = json.dumps(payload)
        dead = []
        for uid, (ws, _) in self.active.items():
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(uid)
        for uid in dead:
            self.disconnect(uid)


manager = ConnectionManager()
