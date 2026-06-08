import asyncio
import json
import math
import time
import uuid
from dataclasses import dataclass, field
from fastapi import WebSocket
from app.models import UserLocation, QUICK_MESSAGES

MAX_PASSENGERS   = 4
ONBOARD_RADIUS_M = 50
REQUEST_TIMEOUT_S = 40
BATCH_SIZE       = 3
GRACE_PERIOD_S   = 45


def haversine(lat1, lng1, lat2, lng2) -> float:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@dataclass
class TripRequest:
    request_id:       str
    student_session:  str
    student_db_id:    int
    student_name:     str
    lat:              float
    lng:              float
    zone_destination: str
    created_at:       float
    candidates:       list            # ordered list of conductor session IDs
    notified:         set  = field(default_factory=set)   # currently notified batch
    batch_start:      int  = 0                             # next unsent index in candidates
    timeout_task:     object = field(default=None, repr=False)


class ConnectionManager:
    def __init__(self):
        self.active: dict[str, tuple[WebSocket, UserLocation | None]] = {}
        self.connected_at: dict[str, float] = {}

    async def connect(self, websocket: WebSocket, session_id: str):
        await websocket.accept()
        self.active[session_id] = (websocket, None)
        self.connected_at[session_id] = time.time()

    def set_location(self, session_id: str, location: UserLocation) -> UserLocation:
        if location.role == "conductor":
            location = self._update_conductor(location)
        ws, _ = self.active[session_id]
        self.active[session_id] = (ws, location)
        return location

    def _update_conductor(self, conductor: UserLocation) -> UserLocation:
        app_onboard = sum(
            1 for _, loc in self.active.values()
            if loc and loc.role == "estudiante"
            and haversine(conductor.lat, conductor.lng, loc.lat, loc.lng) <= ONBOARD_RADIUS_M
        )
        total = app_onboard + conductor.manual_passengers
        new_status = "lleno" if total >= MAX_PASSENGERS else conductor.status
        return conductor.model_copy(update={"onboard_count": total, "status": new_status})

    def disconnect(self, session_id: str):
        self.active.pop(session_id, None)
        self.connected_at.pop(session_id, None)

    def get_connected_at(self, session_id: str) -> float:
        return self.connected_at.get(session_id, time.time())

    def get_all_locations(self) -> list[dict]:
        return [loc.model_dump() for _, loc in self.active.values() if loc is not None]

    def get_approved_conductors_sorted(self, lat: float, lng: float) -> list[tuple[str, UserLocation]]:
        result = []
        for sid, (_, loc) in self.active.items():
            if loc and loc.role == "conductor" and loc.status != "lleno":
                dist = haversine(lat, lng, loc.lat, loc.lng)
                result.append((sid, loc, dist))
        result.sort(key=lambda x: x[2])
        return [(sid, loc) for sid, loc, _ in result]

    async def send_to(self, session_id: str, payload: dict):
        if session_id in self.active:
            ws, _ = self.active[session_id]
            try:
                await ws.send_text(json.dumps(payload))
            except Exception:
                self.disconnect(session_id)

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


class TripManager:
    def __init__(self, conn: ConnectionManager):
        self.conn = conn
        self.pending: dict[str, TripRequest] = {}
        self.by_student: dict[str, str] = {}
        self.active_trips: dict[str, int] = {}
        # Grace-period reconnect state
        self.user_to_trip: dict[int, int] = {}          # user_db_id → trip_id
        self.trip_parties: dict[int, dict] = {}         # trip_id → party sessions/ids
        self.reconnect_tasks: dict[int, asyncio.Task] = {}

    async def create_request(self, student_session: str, student_db_id: int,
                              student_name: str, lat: float, lng: float,
                              zone: str, db) -> str | None:
        await self.cancel_request(student_session)

        candidates_raw = self.conn.get_approved_conductors_sorted(lat, lng)
        candidate_map = {sid: loc for sid, loc in candidates_raw if loc.conductor_db_id is not None}
        if candidate_map:
            from app.database import User
            db_ids = [loc.conductor_db_id for loc in candidate_map.values()]
            solvent_ids = {
                u.id for u in db.query(User).filter(
                    User.id.in_(db_ids), User.saldo > 0
                ).all()
            }
            candidates = [sid for sid, loc in candidate_map.items() if loc.conductor_db_id in solvent_ids]
        else:
            candidates = []

        if not candidates:
            return None

        request_id = str(uuid.uuid4())
        req = TripRequest(
            request_id=request_id,
            student_session=student_session,
            student_db_id=student_db_id,
            student_name=student_name,
            lat=lat,
            lng=lng,
            zone_destination=zone,
            created_at=time.time(),
            candidates=candidates,
        )
        self.pending[request_id] = req
        self.by_student[student_session] = request_id

        await self._send_batch(req)
        return request_id

    async def _send_batch(self, req: TripRequest):
        if req.timeout_task:
            req.timeout_task.cancel()

        if req.batch_start >= len(req.candidates):
            await self.conn.send_to(req.student_session, {
                "type": "trip_rejected",
                "request_id": req.request_id,
                "reason": "no_conductors",
            })
            self._cleanup(req.request_id)
            return

        end = min(req.batch_start + BATCH_SIZE, len(req.candidates))
        batch = req.candidates[req.batch_start:end]
        req.batch_start = end
        req.notified = set(batch)

        for conductor_session in batch:
            conductor_loc = None
            if conductor_session in self.conn.active:
                _, conductor_loc = self.conn.active[conductor_session]
            dist = 0
            if conductor_loc:
                dist = int(haversine(req.lat, req.lng, conductor_loc.lat, conductor_loc.lng))
            await self.conn.send_to(conductor_session, {
                "type": "trip_request_incoming",
                "request_id": req.request_id,
                "student": {
                    "name": req.student_name,
                    "lat": req.lat,
                    "lng": req.lng,
                },
                "zone_destination": req.zone_destination,
                "distance_m": dist,
            })

        req.timeout_task = asyncio.create_task(self._timeout(req.request_id))

    async def _timeout(self, request_id: str):
        await asyncio.sleep(REQUEST_TIMEOUT_S)
        if request_id not in self.pending:
            return
        req = self.pending[request_id]
        req.notified = set()
        await self._send_batch(req)

    async def accept_request(self, conductor_session: str, request_id: str, db) -> int | None:
        # Pop immediately — prevents race condition when two batch conductors accept simultaneously
        req = self.pending.pop(request_id, None)
        if not req:
            await self.conn.send_to(conductor_session, {
                "type": "trip_already_taken",
                "request_id": request_id,
            })
            return None
        self.by_student.pop(req.student_session, None)

        if req.timeout_task:
            req.timeout_task.cancel()

        conductor_loc = None
        conductor_db_id = None
        if conductor_session in self.conn.active:
            _, conductor_loc = self.conn.active[conductor_session]
            if conductor_loc:
                conductor_db_id = conductor_loc.conductor_db_id

        from app.database import Trip
        trip = Trip(
            conductor_id=conductor_db_id or 0,
            student_id=req.student_db_id,
            zone_destination=req.zone_destination,
            status="accepted",
            started_at=req.created_at,
            accepted_at=time.time(),
        )
        db.add(trip)
        db.commit()
        db.refresh(trip)

        self.active_trips[conductor_session] = trip.id
        self.active_trips[req.student_session] = trip.id

        self.trip_parties[trip.id] = {
            "conductor_sid":  conductor_session,
            "student_sid":    req.student_session,
            "conductor_db_id": conductor_db_id or 0,
            "student_db_id":  req.student_db_id,
        }

        # Tell other notified conductors the trip is gone
        for other_sid in req.notified:
            if other_sid != conductor_session:
                await self.conn.send_to(other_sid, {
                    "type": "trip_taken",
                    "request_id": request_id,
                })

        # Query conductor vehicle info and rating
        vehicle_info = {}
        rating_count = 0
        if conductor_db_id:
            from app.database import User as DbUser
            conductor_user = db.query(DbUser).filter(DbUser.id == conductor_db_id).first()
            if conductor_user:
                vehicle_info = {
                    "placa":  conductor_user.placa_numero  or "",
                    "color":  conductor_user.color_carro   or "",
                    "modelo": conductor_user.modelo_carro  or "",
                }
                rating_count = conductor_user.rating_count or 0

        eta_seconds = None
        if conductor_loc:
            dist_m = haversine(req.lat, req.lng, conductor_loc.lat, conductor_loc.lng)
            eta_seconds = max(60, int(dist_m / 6.94))

        conductor_info = {}
        if conductor_loc:
            conductor_info = {
                "lat":          conductor_loc.lat,
                "lng":          conductor_loc.lng,
                "name":         conductor_loc.name,
                "zone":         conductor_loc.zone_destination,
                "rating":       conductor_loc.rating_avg,
                "rating_count": rating_count,
                "eta_seconds":  eta_seconds,
                **vehicle_info,
            }

        await self.conn.send_to(req.student_session, {
            "type":       "trip_accepted",
            "request_id": request_id,
            "trip_id":    trip.id,
            "conductor":  conductor_info,
        })

        await self.conn.send_to(conductor_session, {
            "type":         "trip_accept_confirmed",
            "trip_id":      trip.id,
            "student_name": req.student_name,
        })

        return trip.id

    async def reject_request(self, conductor_session: str, request_id: str):
        if request_id not in self.pending:
            return
        req = self.pending[request_id]
        req.notified.discard(conductor_session)
        if not req.notified:
            if req.timeout_task:
                req.timeout_task.cancel()
            await self._send_batch(req)

    async def cancel_request(self, student_session: str):
        request_id = self.by_student.get(student_session)
        if not request_id or request_id not in self.pending:
            return
        req = self.pending[request_id]
        if req.timeout_task:
            req.timeout_task.cancel()
        for conductor_sid in req.notified:
            await self.conn.send_to(conductor_sid, {
                "type": "trip_cancelled",
                "request_id": request_id,
            })
        # Clear student location so they vanish from map
        if student_session in self.conn.active:
            ws, _ = self.conn.active[student_session]
            self.conn.active[student_session] = (ws, None)
        await self.conn.broadcast({"type": "remove", "id": student_session})
        self._cleanup(request_id)

    async def cancel_active_trip(self, session_id: str, db):
        trip_id = self.active_trips.get(session_id)
        if not trip_id:
            return

        from app.database import Trip
        trip = db.query(Trip).filter(Trip.id == trip_id).first()
        if trip and trip.status == "accepted":
            trip.status = "cancelled"
            db.commit()

        parties = self.trip_parties.pop(trip_id, {})
        student_sid = parties.get("student_sid")

        for sid, tid in list(self.active_trips.items()):
            if tid == trip_id and sid != session_id:
                await self.conn.send_to(sid, {"type": "trip_cancelled_active", "trip_id": trip_id})
                del self.active_trips[sid]
                break

        self.active_trips.pop(session_id, None)

        # Null student location so they disappear from map
        if student_sid and student_sid in self.conn.active:
            ws, _ = self.conn.active[student_sid]
            self.conn.active[student_sid] = (ws, None)
            await self.conn.broadcast({"type": "remove", "id": student_sid})

    async def handle_disconnect(self, session_id: str, user_db_id: int, db):
        """Called on WS disconnect — starts a grace period for active-trip users."""
        trip_id = self.active_trips.get(session_id)
        if not trip_id:
            return

        parties = self.trip_parties.get(trip_id, {})
        other_sid = None
        if parties.get("conductor_sid") == session_id:
            other_sid = parties.get("student_sid")
        elif parties.get("student_sid") == session_id:
            other_sid = parties.get("conductor_sid")

        self.active_trips.pop(session_id, None)
        self.user_to_trip[user_db_id] = trip_id

        if other_sid:
            await self.conn.send_to(other_sid, {
                "type": "trip_partner_disconnected",
                "trip_id": trip_id,
            })

        if user_db_id in self.reconnect_tasks:
            self.reconnect_tasks[user_db_id].cancel()
        self.reconnect_tasks[user_db_id] = asyncio.create_task(
            self._grace_expire(user_db_id, trip_id, other_sid)
        )

    async def _grace_expire(self, user_db_id: int, trip_id: int, other_sid: str | None):
        await asyncio.sleep(GRACE_PERIOD_S)
        if user_db_id not in self.user_to_trip:
            return  # Already reconnected

        self.user_to_trip.pop(user_db_id, None)
        self.reconnect_tasks.pop(user_db_id, None)
        self.trip_parties.pop(trip_id, None)

        # Use a fresh DB session — the original WS session is already closed
        from app.database import SessionLocal, Trip
        _db = SessionLocal()
        try:
            trip = _db.query(Trip).filter(Trip.id == trip_id).first()
            if trip and trip.status in ("accepted", "onboard"):
                trip.status = "cancelled"
                _db.commit()
        finally:
            _db.close()

        if other_sid:
            await self.conn.send_to(other_sid, {
                "type": "trip_cancelled_active",
                "trip_id": trip_id,
                "reason": "partner_disconnected",
            })
            self.active_trips.pop(other_sid, None)

    async def try_reconnect_trip(self, new_session: str, user_db_id: int) -> int | None:
        """If the user had an active trip when they disconnected, restore it."""
        if user_db_id not in self.user_to_trip:
            return None

        trip_id = self.user_to_trip.pop(user_db_id)

        task = self.reconnect_tasks.pop(user_db_id, None)
        if task:
            task.cancel()

        self.active_trips[new_session] = trip_id

        parties = self.trip_parties.get(trip_id)
        if parties:
            if parties.get("conductor_db_id") == user_db_id:
                parties["conductor_sid"] = new_session
                other_sid = parties.get("student_sid")
            else:
                parties["student_sid"] = new_session
                other_sid = parties.get("conductor_sid")
        else:
            other_sid = None

        if other_sid:
            await self.conn.send_to(other_sid, {
                "type": "trip_partner_reconnected",
                "trip_id": trip_id,
            })

        return trip_id

    async def mark_onboard(self, conductor_session: str, trip_id: int, db):
        if self.active_trips.get(conductor_session) != trip_id:
            return
        from app.database import Trip, User
        trip = db.query(Trip).filter(Trip.id == trip_id).first()
        if trip:
            trip.status = "onboard"
            trip.onboard_at = time.time()
            conductor = db.query(User).filter(User.id == trip.conductor_id).first()
            if conductor:
                conductor.saldo = (conductor.saldo or 0.0) - 100
            db.commit()
        for sid, tid in self.active_trips.items():
            if tid == trip_id and sid != conductor_session:
                await self.conn.send_to(sid, {"type": "onboard_confirmed", "trip_id": trip_id})
                break

    async def mark_dropoff(self, conductor_session: str, trip_id: int, student_db_id: int, db):
        if self.active_trips.get(conductor_session) != trip_id:
            return
        from app.database import Trip, User
        trip = db.query(Trip).filter(Trip.id == trip_id).first()
        if trip:
            trip.status = "completed"
            trip.ended_at = time.time()
            db.commit()

        conductor_name = ""
        conductor_db_id = None
        if conductor_session in self.conn.active:
            _, loc = self.conn.active[conductor_session]
            if loc:
                conductor_name = loc.name
                conductor_db_id = loc.conductor_db_id

        for sid, tid in list(self.active_trips.items()):
            if tid == trip_id and sid != conductor_session:
                await self.conn.send_to(sid, {
                    "type": "rate_prompt",
                    "trip_id": trip_id,
                    "conductor_id": conductor_db_id,
                    "conductor_name": conductor_name,
                })
                if sid in self.conn.active:
                    ws, _ = self.conn.active[sid]
                    self.conn.active[sid] = (ws, None)
                await self.conn.broadcast({"type": "remove", "id": sid})
                del self.active_trips[sid]
                break

        self.active_trips.pop(conductor_session, None)
        self.trip_parties.pop(trip_id, None)

        if conductor_session in self.conn.active:
            ws, conductor_loc = self.conn.active[conductor_session]
            if conductor_loc:
                updated = self.conn._update_conductor(conductor_loc)
                self.conn.active[conductor_session] = (ws, updated)
                await self.conn.broadcast({"type": "update", "user": updated.model_dump()})

    async def send_quick_message(self, conductor_session: str, trip_id: int, message_key: str):
        if message_key not in QUICK_MESSAGES:
            return
        conductor_name = ""
        if conductor_session in self.conn.active:
            _, loc = self.conn.active[conductor_session]
            if loc:
                conductor_name = loc.name

        for sid, tid in self.active_trips.items():
            if tid == trip_id and sid != conductor_session:
                await self.conn.send_to(sid, {
                    "type": "quick_message",
                    "message_key": message_key,
                    "message_text": QUICK_MESSAGES[message_key],
                    "from_name": conductor_name,
                })
                break

    def _cleanup(self, request_id: str):
        req = self.pending.pop(request_id, None)
        if req:
            self.by_student.pop(req.student_session, None)


manager = ConnectionManager()
trip_manager = TripManager(manager)
