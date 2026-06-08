import os
import time
from collections import defaultdict
from fastapi import HTTPException, Request

from app.database import User
from app.models import UserOut

# ── Simple in-memory rate limiter ─────────────────────────────────────────────
_rl_buckets: dict[str, list[float]] = defaultdict(list)

def check_rate_limit(key: str, max_attempts: int = 10, window_s: int = 60):
    now = time.time()
    _rl_buckets[key] = [t for t in _rl_buckets[key] if now - t < window_s]
    if len(_rl_buckets[key]) >= max_attempts:
        raise HTTPException(status_code=429, detail="Demasiados intentos. Espera un momento e intenta de nuevo.")
    _rl_buckets[key].append(now)

_is_prod = os.getenv("DB_URL", "").startswith("postgresql")


def _user_out(user: User) -> UserOut:
    count = user.rating_count or 0
    avg = round((user.rating_sum or 0) / count, 1) if count > 0 else None
    return UserOut(
        id=user.id, name=user.name, email=user.email,
        role=user.role, conductor_status=user.conductor_status,
        rating_avg=avg, rating_count=count,
    )


def _page(title: str, message: str, error: bool = False) -> str:
    color = "#f87171" if error else "#4ade80"
    return f"""<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <title>{title} — ColectivoU</title>
    <style>*{{margin:0;padding:0;box-sizing:border-box}}
    body{{font-family:'Segoe UI',sans-serif;background:#0f172a;color:#f1f5f9;min-height:100vh;display:flex;align-items:center;justify-content:center}}
    .card{{background:#1e293b;border-radius:1.25rem;padding:2.5rem 2rem;max-width:360px;width:90%;text-align:center}}
    h1{{font-size:1.5rem;margin-bottom:1rem;color:{color}}}
    a{{color:#818cf8}}</style></head>
    <body><div class="card"><h1>{title}</h1><p>{message}</p>
    <p style="margin-top:1.5rem"><a href="/dev">← Volver al inicio</a></p>
    </div></body></html>"""
