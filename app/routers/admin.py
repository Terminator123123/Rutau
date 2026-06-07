import os
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db, User, Recarga, UPLOADS_DIR
from app.dependencies import require_admin
from app.models import RecargaRequest, RecargaOut

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


@router.get("/admin/conductors")
def admin_all_conductors(db: Session = Depends(get_db), _=Depends(require_admin)):
    users = db.query(User).filter(User.role == "conductor").order_by(User.id).all()
    return [
        {
            "id": u.id, "name": u.name, "email": u.email,
            "conductor_status": u.conductor_status,
            "is_verified": u.is_verified,
            "has_cedula":    bool(u.cedula_path),
            "has_selfie":    bool(u.selfie_path),
            "has_plate":     bool(u.plate_path),
            "has_soat":      bool(u.soat_path),
            "cedula_numero": u.cedula_numero,
            "telefono":      u.telefono,
            "placa_numero":  u.placa_numero,
            "color_carro":   u.color_carro,
            "modelo_carro":  u.modelo_carro,
            "rating_avg":    round(u.rating_sum / u.rating_count, 1) if u.rating_count else None,
            "rating_count":  u.rating_count,
        }
        for u in users
    ]


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


@router.get("/admin/conductors/{user_id}/doc/{doc_type}")
def admin_get_conductor_doc(user_id: int, doc_type: str, db: Session = Depends(get_db), _=Depends(require_admin)):
    """Sirve un documento de conductor por tipo (cedula, selfie, plate, soat)."""
    if doc_type not in ("cedula", "selfie", "plate", "soat"):
        raise HTTPException(400, "Tipo de documento inválido")
    user = db.query(User).filter(User.id == user_id, User.role == "conductor").first()
    if not user:
        raise HTTPException(404, "Conductor no encontrado")
    path_map = {"cedula": user.cedula_path, "selfie": user.selfie_path, "plate": user.plate_path, "soat": user.soat_path}
    filepath = path_map[doc_type]
    if not filepath or not os.path.exists(filepath):
        raise HTTPException(404, "Documento no disponible")
    return FileResponse(filepath)


@router.post("/admin/conductors/{user_id}/recarga", response_model=RecargaOut)
def admin_registrar_recarga(
    user_id: int,
    body: RecargaRequest,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    conductor = db.query(User).filter(User.id == user_id, User.role == "conductor").first()
    if not conductor:
        raise HTTPException(404, "Conductor no encontrado")
    if body.monto <= 0:
        raise HTTPException(400, "El monto debe ser mayor a 0")

    conductor.saldo = (conductor.saldo or 0.0) + body.monto

    recarga = Recarga(
        conductor_id=user_id,
        admin_id=0,
        monto=body.monto,
        registrada_en=time.time(),
        notas=body.notas,
    )
    db.add(recarga)
    db.commit()
    db.refresh(recarga)
    return recarga


@router.get("/admin/conductors/{user_id}/recargas", response_model=list[RecargaOut])
def admin_historial_recargas(
    user_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    conductor = db.query(User).filter(User.id == user_id, User.role == "conductor").first()
    if not conductor:
        raise HTTPException(404, "Conductor no encontrado")
    recargas = db.query(Recarga).filter(Recarga.conductor_id == user_id).order_by(Recarga.registrada_en.desc()).all()
    return recargas


@router.get("/admin/conductors/{user_id}/saldo")
def admin_ver_saldo_conductor(
    user_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    conductor = db.query(User).filter(User.id == user_id, User.role == "conductor").first()
    if not conductor:
        raise HTTPException(404, "Conductor no encontrado")
    saldo = conductor.saldo or 0.0
    return {"conductor_id": user_id, "name": conductor.name, "saldo": saldo, "deuda": saldo < 0}


@router.get("/admin/documents/{user_id}/{filename}")
def admin_get_document(user_id: int, filename: str, _=Depends(require_admin)):
    safe_filename = Path(filename).name
    filepath = os.path.join(UPLOADS_DIR, str(user_id), safe_filename)
    if not os.path.exists(filepath):
        raise HTTPException(404, "Documento no encontrado")
    return FileResponse(filepath)
