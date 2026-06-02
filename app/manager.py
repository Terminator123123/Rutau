import json
from fastapi import WebSocket
from app.models import UserLocation


class ConnectionManager:
    def __init__(self):
        self.active: dict[str, tuple[WebSocket, UserLocation]] = {}

    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        self.active[user_id] = (websocket, None)

    def set_location(self, user_id: str, location: UserLocation):
        ws, _ = self.active[user_id]
        self.active[user_id] = (ws, location)

    def disconnect(self, user_id: str):
        self.active.pop(user_id, None)

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
