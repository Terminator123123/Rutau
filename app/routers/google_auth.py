import json
import os
import secrets
import time
import urllib.parse
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.auth import COOKIE_NAME, INFO_COOKIE_NAME, TOKEN_EXPIRE_DAYS, create_token, hash_password
from app.database import User, get_db
from app.utils import _is_prod, check_rate_limit

router = APIRouter(tags=["Google Auth"])

_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID")
_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
_REDIRECT_URI  = os.getenv(
    "GOOGLE_REDIRECT_URI",
    "https://rutau-api-production.up.railway.app/auth/google/callback",
)

_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_USER_URL  = "https://www.googleapis.com/oauth2/v3/userinfo"


@router.get("/auth/google", include_in_schema=False)
async def google_login():
    state  = secrets.token_urlsafe(24)
    params = urlencode({
        "client_id":     _CLIENT_ID,
        "redirect_uri":  _REDIRECT_URI,
        "response_type": "code",
        "scope":         "openid email profile",
        "state":         state,
        "access_type":   "online",
        "prompt":        "select_account",
    })
    response = RedirectResponse(f"{_AUTH_URL}?{params}")
    response.set_cookie("oauth_state", state, httponly=True, max_age=300, samesite="lax", secure=_is_prod)
    return response


@router.get("/auth/google/callback", include_in_schema=False)
async def google_callback(
    request: Request,
    code:  str = None,
    state: str = None,
    error: str = None,
    db:    Session = Depends(get_db),
):
    check_rate_limit(f"oauth:{request.client.host}", max_attempts=20, window_s=300)
    stored_state = request.cookies.get("oauth_state")
    if error or not code or not state or not stored_state:
        return RedirectResponse("/dev?google_error=1")
    if not secrets.compare_digest(state, stored_state):
        return RedirectResponse("/dev?google_error=1")

    async with httpx.AsyncClient() as client:
        token_res = await client.post(_TOKEN_URL, data={
            "code":          code,
            "client_id":     _CLIENT_ID,
            "client_secret": _CLIENT_SECRET,
            "redirect_uri":  _REDIRECT_URI,
            "grant_type":    "authorization_code",
        })
        if token_res.status_code != 200:
            return RedirectResponse("/dev?google_error=1")

        access_token = token_res.json().get("access_token")

        user_res = await client.get(
            _USER_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if user_res.status_code != 200:
            return RedirectResponse("/dev?google_error=1")
        g = user_res.json()

    email = g.get("email")
    name  = g.get("name") or (email or "").split("@")[0]
    if not email:
        return RedirectResponse("/dev?google_error=1")

    # Find or create user
    user = db.query(User).filter(User.email == email).first()
    if not user:
        user = User(
            name=name,
            email=email,
            hashed_password=hash_password(secrets.token_hex(32)),
            role="estudiante",
            is_verified=True,
            terms_accepted_at=time.time(),
            rating_sum=0.0,
            rating_count=0,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    elif not user.is_verified:
        user.is_verified = True
        db.commit()

    _max_age = TOKEN_EXPIRE_DAYS * 24 * 3600
    _info    = urllib.parse.quote(json.dumps({
        "name":             user.name,
        "role":             user.role,
        "id":               user.id,
        "conductor_status": user.conductor_status,
    }))

    response = RedirectResponse("/dev")
    response.set_cookie(
        key=COOKIE_NAME, value=create_token(user),
        httponly=True, secure=_is_prod, samesite="lax", max_age=_max_age,
    )
    response.set_cookie(
        key=INFO_COOKIE_NAME, value=_info,
        httponly=False, secure=_is_prod, samesite="lax", max_age=_max_age,
    )
    response.delete_cookie("oauth_state")
    return response
