import asyncio
import json
import math
import time
import uuid
from dataclasses import dataclass, field
from fastapi import WebSocket
from app.models import UserLocation, QUICK_MESSAGES

MAX_PASSENGERS = 4
ONBOARD_RADIUS_M = 50
REQUEST_TIMEOUT_S = 40


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
    candidates:       list   # ordered list of conductor session IDs
    current_idx:      int = 0
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
        """Returns list of (session_id, location) for approved conductors with available seats, sorted by distance."""
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
        # request_id → TripRequest
        self.pending: dict[str, TripRequest] = {}
        # student_session → request_id (max one active request per student)
        self.by_student: dict[str, str] = {}
        # session_id → trip_id (for active onboard trips)
        self.active_trips: dict[str, int] = {}

    async def create_request(self, student_session: str, student_db_id: int,
                              student_name: str, lat: float, lng: float,
                              zone: str, db) -> str | None:
        # Cancel any existing request from this student
        await self.cancel_request(student_session)

        # Get approved conductors sorted by distance
        # Only include conductors that have been approved (conductor_status == 'approved')
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

        await self._notify_next(req)
        return request_id

    async def _notify_next(self, req: TripRequest):
        if req.current_idx >= len(req.candidates):
            # No more candidates — notify student
            await self.conn.send_to(req.student_session, {
                "type": "trip_rejected",
                "request_id": req.request_id,
                "reason": "no_conductors",
            })
            self._cleanup(req.request_id)
            return

        conductor_session = req.candidates[req.current_idx]

        # Get conductor location for distance info
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

        # Start timeout
        if req.timeout_task:
            req.timeout_task.cancel()
        req.timeout_task = asyncio.create_task(self._timeout(req.request_id))

    async def _timeout(self, request_id: str):
        await asyncio.sleep(REQUEST_TIMEOUT_S)
        if request_id not in self.pending:
            return
        req = self.pending[request_id]
        req.current_idx += 1
        await self._notify_next(req)

    async def accept_request(self, conductor_session: str, request_id: str, db) -> int | None:
        """Returns trip_id if accepted successfully."""
        if request_id not in self.pending:
            return None
        req = self.pending[request_id]

        # Cancel timeout
        if req.timeout_task:
            req.timeout_task.cancel()

        conductor_loc = None
        conductor_db_id = None
        if conductor_session in self.conn.active:
            _, conductor_loc = self.conn.active[conductor_session]
            if conductor_loc:
                conductor_db_id = conductor_loc.conductor_db_id

        # Create trip in DB
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

        self._cleanup(request_id)

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

        # Calculate ETA (assume 25 km/h urban avg = 6.94 m/s)
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

        # Notify conductor with trip_id so they can reference it for onboard/dropoff
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
        if req.timeout_task:
            req.timeout_task.cancel()
        req.current_idx += 1
        await self._notify_next(req)

    async def cancel_request(self, student_session: str):
        request_id = self.by_student.get(student_session)
        if not request_id or request_id not in self.pending:
            return
        req = self.pending[request_id]
        if req.timeout_task:
            req.timeout_task.cancel()
        # Notify current conductor if any
        if req.current_idx < len(req.candidates):
            await self.conn.send_to(req.candidates[req.current_idx], {
                "type": "trip_cancelled",
                "request_id": request_id,
            })
        self._cleanup(request_id)

    async def cancel_active_trip(self, session_id: str, db):
        """Cancel an accepted trip (before onboard) by either party."""
        trip_id = self.active_trips.get(session_id)
        if not trip_id:
            return
        from app.database import Trip
        trip = db.query(Trip).filter(Trip.id == trip_id).first()
        if trip and trip.status == "accepted":
            trip.status = "cancelled"
            db.commit()
        for sid, tid in list(self.active_trips.items()):
            if tid == trip_id and sid != session_id:
                await self.conn.send_to(sid, {"type": "trip_cancelled_active", "trip_id": trip_id})
                del self.active_trips[sid]
                break
        self.active_trips.pop(session_id, None)

    async def mark_onboard(self, conductor_session: str, trip_id: int, db):
        from app.database import Trip, User
        trip = db.query(Trip).filter(Trip.id == trip_id).first()
        if trip:
            trip.status = "onboard"
            trip.onboard_at = time.time()
            conductor = db.query(User).filter(User.id == trip.conductor_id).first()
            if conductor:
                conductor.saldo = (conductor.saldo or 0.0) - 100
            db.commit()
        # Find student session for this trip
        for sid, tid in self.active_trips.items():
            if tid == trip_id and sid != conductor_session:
                await self.conn.send_to(sid, {"type": "onboard_confirmed", "trip_id": trip_id})
                break

    async def mark_dropoff(self, conductor_session: str, trip_id: int, student_db_id: int, db):
        from app.database import Trip
        from app.database import User
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

        # Find student session, send rate prompt, and clear their location
        for sid, tid in list(self.active_trips.items()):
            if tid == trip_id and sid != conductor_session:
                await self.conn.send_to(sid, {
                    "type": "rate_prompt",
                    "trip_id": trip_id,
                    "conductor_id": conductor_db_id,
                    "conductor_name": conductor_name,
                })
                # Remove student location so they disappear from map and proximity count
                if sid in self.conn.active:
                    ws, _ = self.conn.active[sid]
                    self.conn.active[sid] = (ws, None)
                await self.conn.broadcast({"type": "remove", "id": sid})
                del self.active_trips[sid]
                break

        self.active_trips.pop(conductor_session, None)

        # Recalculate conductor onboard count (student is now gone) and broadcast
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
