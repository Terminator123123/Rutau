import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db, User, UPLOADS_DIR
from app.dependencies import require_admin

router = APIRouter(tags=["Admin"])


@router.get("/admin/users")
def admin_list_users(db: Session = Depends(get_db), _=Depends(require_admin)):
    users = db.query(User).order_by(User.id).all()
    return [
        {
            "id": u.id, "name": u.name, "email": u.email,
            "role": u.role, "is_verified": u.is_verified,
            "conductor_status": u.conductor_status,
            "has_documents": bool(u.cedula_path),
            "rating_avg": round(u.rating_sum / u.rating_count, 1) if u.rating_count else None,
        }
        for u in users
    ]


@router.delete("/admin/users/{email}")
def admin_delete_user(email: str, db: Session = Depends(get_db), _=Depends(require_admin)):
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    db.delete(user)
    db.commit()
    return {"message": f"Usuario {email} eliminado"}


@router.post("/admin/users/{email}/verify")
def admin_verify_user(email: str, db: Session = Depends(get_db), _=Depends(require_admin)):
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    user.is_verified = True
    user.verification_token = None
    db.commit()
    return {"message": f"Usuario {email} verificado", "user": {"id": user.id, "name": user.name}}


@router.get("/admin/conductors/pending")
def admin_pending_conductors(db: Session = Depends(get_db), _=Depends(require_admin)):
    users = db.query(User).filter(
        User.role == "conductor",
        User.conductor_status == "pending",
    ).all()
    return [
        {
            "id": u.id, "name": u.name, "email": u.email,
            "is_verified": u.is_verified,
            "has_cedula": bool(u.cedula_path),
            "has_selfie": bool(u.selfie_path),
            "has_plate":  bool(u.plate_path),
            "has_soat":   bool(u.soat_path),
        }
        for u in users
    ]


@router.post("/admin/conductors/{user_id}/approve")
def admin_approve_conductor(user_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    user = db.query(User).filter(User.id == user_id, User.role == "conductor").first()
    if not user:
        raise HTTPException(404, "Conductor no encontrado")
    user.conductor_status = "approved"
    db.commit()
    return {"message": f"Conductor {user.name} aprobado"}


@router.post("/admin/conductors/{user_id}/reject")
def admin_reject_conductor(user_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    user = db.query(User).filter(User.id == user_id, User.role == "conductor").first()
    if not user:
        raise HTTPException(404, "Conductor no encontrado")
    user.conductor_status = "rejected"
    db.commit()
    return {"message": f"Conductor {user.name} rechazado"}


@router.get("/admin/documents/{user_id}/{filename}")
def admin_get_document(user_id: int, filename: str, _=Depends(require_admin)):
    safe_filename = Path(filename).name
    filepath = os.path.join(UPLOADS_DIR, str(user_id), safe_filename)
    if not os.path.exists(filepath):
        raise HTTPException(404, "Documento no encontrado")
    return FileResponse(filepath)
