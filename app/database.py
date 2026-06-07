import os
from sqlalchemy import create_engine, Column, Integer, String, Boolean, Float, text
from sqlalchemy.orm import declarative_base, sessionmaker
import time

_db_url = os.getenv("DB_URL", "sqlite:///./colectivou.db")

if _db_url.startswith("postgres://"):
    _db_url = "postgresql://" + _db_url[len("postgres://"):]

_is_sqlite = _db_url.startswith("sqlite")
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

engine = create_engine(_db_url, connect_args=_connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

UPLOADS_DIR = os.getenv("UPLOADS_DIR", "./uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)


class User(Base):
    __tablename__ = "users"

    id                  = Column(Integer, primary_key=True, index=True)
    name                = Column(String, nullable=False)
    email               = Column(String, unique=True, index=True, nullable=False)
    hashed_password     = Column(String, nullable=False)
    role                = Column(String, nullable=False)
    is_verified         = Column(Boolean, default=False, nullable=False, server_default="false")
    verification_token  = Column(String, nullable=True)
    reset_token         = Column(String, nullable=True)
    reset_token_expires = Column(Float, nullable=True)
    # Conductor verification
    conductor_status    = Column(String, nullable=True)   # 'pending'|'approved'|'rejected'
    cedula_path         = Column(String, nullable=True)
    selfie_path         = Column(String, nullable=True)
    plate_path          = Column(String, nullable=True)
    soat_path           = Column(String, nullable=True)
    # Terms & conditions
    terms_accepted_at   = Column(Float, nullable=True)
    # Rating (conductors only)
    rating_sum          = Column(Float, default=0.0, server_default="0")
    rating_count        = Column(Integer, default=0, server_default="0")
    # Wallet (conductors only)
    saldo               = Column(Float, default=0.0, server_default="0")
    # Conductor personal & vehicle info
    cedula_numero       = Column(String, nullable=True)
    telefono            = Column(String, nullable=True)
    placa_numero        = Column(String, nullable=True)
    color_carro         = Column(String, nullable=True)
    modelo_carro        = Column(String, nullable=True)


class Recarga(Base):
    __tablename__ = "recargas"

    id            = Column(Integer, primary_key=True, index=True)
    conductor_id  = Column(Integer, nullable=False, index=True)
    admin_id      = Column(Integer, nullable=False)
    monto         = Column(Float, nullable=False)
    registrada_en = Column(Float, nullable=False)
    notas         = Column(String, nullable=True)


class Trip(Base):
    __tablename__ = "trips"

    id               = Column(Integer, primary_key=True, index=True)
    conductor_id     = Column(Integer, nullable=False)
    student_id       = Column(Integer, nullable=False)
    zone_destination = Column(String, nullable=False)
    status           = Column(String, nullable=False, default="requested")
    started_at       = Column(Float, nullable=False)
    accepted_at      = Column(Float, nullable=True)
    onboard_at       = Column(Float, nullable=True)
    ended_at         = Column(Float, nullable=True)
    rating           = Column(Integer, nullable=True)


Base.metadata.create_all(bind=engine)

# Migrate existing tables — add new columns if missing
_user_columns = [
    ("is_verified",         "BOOLEAN NOT NULL DEFAULT FALSE" if not _is_sqlite else "INTEGER NOT NULL DEFAULT 0"),
    ("verification_token",  "VARCHAR"),
    ("reset_token",         "VARCHAR"),
    ("reset_token_expires", "REAL"),
    ("conductor_status",    "VARCHAR"),
    ("cedula_path",         "VARCHAR"),
    ("selfie_path",         "VARCHAR"),
    ("plate_path",          "VARCHAR"),
    ("soat_path",           "VARCHAR"),
    ("terms_accepted_at",   "REAL"),
    ("rating_sum",          "REAL DEFAULT 0"),
    ("rating_count",        "INTEGER DEFAULT 0"),
    ("saldo",               "REAL DEFAULT 0"),
    ("cedula_numero",       "VARCHAR"),
    ("telefono",            "VARCHAR"),
    ("placa_numero",        "VARCHAR"),
    ("color_carro",         "VARCHAR"),
    ("modelo_carro",        "VARCHAR"),
]

with engine.connect() as _conn:
    for _col, _def in _user_columns:
        try:
            if _is_sqlite:
                _conn.execute(text(f"ALTER TABLE users ADD COLUMN {_col} {_def}"))
            else:
                _conn.execute(text(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {_col} {_def}"))
            _conn.commit()
        except Exception:
            _conn.rollback()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
