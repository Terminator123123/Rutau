import os
import time
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db, User, Recarga, UPLOADS_DIR
from app.models import SaldoOut

router = APIRouter(tags=["Conductor"])

_ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp", "application/pdf"}
_ALLOWED_EXT  = {".jpg", ".jpeg", ".png", ".webp", ".pdf"}
_MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_SIZE_MB", "5")) * 1024 * 1024


def _validate_file(file: UploadFile, contents: bytes):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(400, f"Formato no permitido. Usa: {', '.join(_ALLOWED_EXT)}")
    if len(contents) > _MAX_UPLOAD_BYTES:
        raise HTTPException(400, f"Archivo demasiado grande. Máximo {_MAX_UPLOAD_BYTES // (1024*1024)} MB")
    magic = {
        b"\xff\xd8\xff": "jpg",
        b"\x89PNG": "png",
        b"RIFF": "webp",
        b"%PDF": "pdf",
    }
    if not any(contents.startswith(sig) for sig in magic):
        raise HTTPException(400, "El archivo no parece ser una imagen o PDF válido")


@router.post("/conductor/documents")
async def upload_documents(
    cedula_numero: str          = Form(default=None),
    telefono:      str          = Form(default=None),
    placa_numero:  str          = Form(default=None),
    color_carro:   str          = Form(default=None),
    modelo_carro:  str          = Form(default=None),
    cedula:        UploadFile   = File(...),
    selfie:        UploadFile   = File(...),
    plate:         UploadFile   = File(...),
    soat:          UploadFile   = File(...),
    current_user:  User         = Depends(get_current_user),
    db:            Session      = Depends(get_db),
):
    if current_user.conductor_status == "approved":
        raise HTTPException(400, "Tu cuenta de conductor ya está aprobada")

    files = {"cedula": cedula, "selfie": selfie, "plate": plate, "soat": soat}
    paths = {}

    for doc_type, upload in files.items():
        contents = await upload.read()
        _validate_file(upload, contents)
        ext = Path(upload.filename or "file").suffix.lower() or ".jpg"
        filename = f"{doc_type}_{int(time.time())}{ext}"
        user_dir = os.path.join(UPLOADS_DIR, str(current_user.id))
        os.makedirs(user_dir, exist_ok=True)
        filepath = os.path.join(user_dir, filename)
        with open(filepath, "wb") as f:
            f.write(contents)
        paths[doc_type] = filepath

    user = db.query(User).filter(User.id == current_user.id).first()
    user.cedula_path   = paths["cedula"]
    user.selfie_path   = paths["selfie"]
    user.plate_path    = paths["plate"]
    user.soat_path     = paths["soat"]
    if cedula_numero: user.cedula_numero = cedula_numero.strip()
    if telefono:      user.telefono      = telefono.strip()
    if placa_numero:  user.placa_numero  = placa_numero.strip().upper()
    if color_carro:   user.color_carro   = color_carro.strip()
    if modelo_carro:  user.modelo_carro  = modelo_carro.strip()
    user.role             = "conductor"
    user.conductor_status = "pending"
    db.commit()

    return {"message": "Documentos recibidos. Tu cuenta será revisada pronto."}


@router.get("/conductor/saldo", response_model=SaldoOut)
def conductor_saldo(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "conductor":
        raise HTTPException(403, "Solo conductores")
    user = db.query(User).filter(User.id == current_user.id).first()
    saldo = user.saldo or 0.0
    return SaldoOut(saldo=saldo, deuda=saldo < 0)


@router.get("/conductor/status")
def conductor_status(current_user: User = Depends(get_current_user)):
    if current_user.role != "conductor":
        raise HTTPException(403, "Solo conductores")
    return {
        "conductor_status": current_user.conductor_status,
        "has_documents": bool(current_user.cedula_path),
    }
