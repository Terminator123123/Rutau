import os
from sqlalchemy import create_engine, Column, Integer, String
from sqlalchemy.orm import declarative_base, sessionmaker

_db_url = os.getenv("DB_URL", "sqlite:///./colectivou.db")

# Railway provides postgres:// but SQLAlchemy needs postgresql://
if _db_url.startswith("postgres://"):
    _db_url = "postgresql://" + _db_url[len("postgres://"):]

_connect_args = {"check_same_thread": False} if _db_url.startswith("sqlite") else {}

_db_type = "postgresql" if _db_url.startswith("postgresql") else "sqlite"
print(f"[DB] Connecting to: {_db_type}", flush=True)

engine = create_engine(_db_url, connect_args=_connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    role = Column(String, nullable=False)  # "estudiante" | "conductor"


try:
    Base.metadata.create_all(bind=engine)
    print(f"[DB] Tables created/verified OK ({_db_type})", flush=True)
except Exception as e:
    print(f"[DB] ERROR creating tables: {e}", flush=True)
    raise


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
