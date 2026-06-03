import os
from sqlalchemy import create_engine, Column, Integer, String, Boolean, Float, text
from sqlalchemy.orm import declarative_base, sessionmaker

_db_url = os.getenv("DB_URL", "sqlite:///./colectivou.db")

if _db_url.startswith("postgres://"):
    _db_url = "postgresql://" + _db_url[len("postgres://"):]

_is_sqlite = _db_url.startswith("sqlite")
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

engine = create_engine(_db_url, connect_args=_connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    role = Column(String, nullable=False)
    is_verified = Column(Boolean, default=False, nullable=False, server_default="false")
    verification_token = Column(String, nullable=True)
    reset_token = Column(String, nullable=True)
    reset_token_expires = Column(Float, nullable=True)


Base.metadata.create_all(bind=engine)

# Migrate existing tables: add new columns if they don't exist
_new_columns = [
    ("is_verified", "BOOLEAN NOT NULL DEFAULT FALSE" if not _is_sqlite else "INTEGER NOT NULL DEFAULT 0"),
    ("verification_token", "VARCHAR"),
    ("reset_token", "VARCHAR"),
    ("reset_token_expires", "REAL"),
]
with engine.connect() as _conn:
    for _col, _def in _new_columns:
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
