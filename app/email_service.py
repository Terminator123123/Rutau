import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")

_public_domain = os.getenv("RAILWAY_PUBLIC_DOMAIN", "")
APP_URL = os.getenv("APP_URL") or (f"https://{_public_domain}" if _public_domain else "http://localhost:8000")


def _send(to: str, subject: str, html: str) -> None:
    if not SMTP_USER or not SMTP_PASSWORD:
        print(f"[EMAIL] Sin SMTP configurado — no se envió correo a {to}")
        return

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"ColectivoU <{SMTP_USER}>"
    msg["To"] = to
    msg.attach(MIMEText(html, "html", "utf-8"))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as server:
        server.starttls()
        server.login(SMTP_USER, SMTP_PASSWORD)
        server.sendmail(SMTP_USER, to, msg.as_string())
        print(f"[EMAIL] Enviado OK → {to}")


def send_verification_email(to: str, name: str, token: str) -> None:
    link = f"{APP_URL}/verify-email?token={token}"
    _send(
        to=to,
        subject="Verifica tu cuenta en ColectivoU",
        html=f"""
        <div style="font-family:sans-serif;background:#0f172a;color:#f1f5f9;padding:2rem;border-radius:1rem;max-width:480px;margin:auto">
          <h2 style="color:#818cf8">¡Hola, {name}!</h2>
          <p>Gracias por registrarte en <strong>ColectivoU</strong>.</p>
          <p style="margin:1.5rem 0">Haz clic para activar tu cuenta:</p>
          <a href="{link}"
             style="background:#6366f1;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold">
            Verificar cuenta
          </a>
          <p style="margin-top:1.5rem;font-size:0.85rem;color:#94a3b8">
            El enlace expira en 24 horas. Si no creaste esta cuenta, ignora este correo.
          </p>
        </div>
        """,
    )


def send_reset_email(to: str, name: str, token: str) -> None:
    link = f"{APP_URL}/reset-password?token={token}"
    _send(
        to=to,
        subject="Recupera tu contraseña — ColectivoU",
        html=f"""
        <div style="font-family:sans-serif;background:#0f172a;color:#f1f5f9;padding:2rem;border-radius:1rem;max-width:480px;margin:auto">
          <h2 style="color:#818cf8">¡Hola, {name}!</h2>
          <p>Recibimos una solicitud para restablecer tu contraseña en <strong>ColectivoU</strong>.</p>
          <p style="margin:1.5rem 0">Haz clic para crear una nueva contraseña:</p>
          <a href="{link}"
             style="background:#6366f1;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold">
            Restablecer contraseña
          </a>
          <p style="margin-top:1.5rem;font-size:0.85rem;color:#94a3b8">
            Este enlace expira en <strong>30 minutos</strong>. Si no solicitaste esto, ignora este correo.
          </p>
        </div>
        """,
    )
