from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db, User, Trip
from app.models import ConductorProfileOut, TripRatingRequest

router = APIRouter(tags=["Trips"])


@router.post("/trips/{trip_id}/rate")
def rate_trip(
    trip_id: int,
    body: TripRatingRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not (1 <= body.rating <= 5):
        raise HTTPException(400, "Calificación debe ser entre 1 y 5")

    trip = db.query(Trip).filter(Trip.id == trip_id, Trip.student_id == current_user.id).first()
    if not trip:
        raise HTTPException(404, "Viaje no encontrado")
    if trip.rating is not None:
        raise HTTPException(400, "Ya calificaste este viaje")
    if trip.status != "completed":
        raise HTTPException(400, "El viaje no ha terminado aún")

    trip.rating = body.rating
    db.commit()

    conductor = db.query(User).filter(User.id == trip.conductor_id).first()
    if conductor:
        conductor.rating_sum = (conductor.rating_sum or 0) + body.rating
        conductor.rating_count = (conductor.rating_count or 0) + 1
        db.commit()

    return {"message": "Calificación guardada"}


@router.get("/conductors/{conductor_id}/profile", response_model=ConductorProfileOut)
def conductor_profile(conductor_id: int, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == conductor_id, User.role == "conductor").first()
    if not user:
        raise HTTPException(404, "Conductor no encontrado")
    avg = None
    if user.rating_count and user.rating_count > 0:
        avg = round((user.rating_sum or 0) / user.rating_count, 1)
    return ConductorProfileOut(
        id=user.id, name=user.name,
        rating_avg=avg, rating_count=user.rating_count or 0,
    )
