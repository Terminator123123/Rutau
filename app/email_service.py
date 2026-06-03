import os
import resend

_public_domain = os.getenv("RAILWAY_PUBLIC_DOMAIN", "")
APP_URL = os.getenv("APP_URL") or (f"https://{_public_domain}" if _public_domain else "http://localhost:8000")

FROM_ADDRESS = "ColectivoU <onboarding@resend.dev>"


def _send(to: str, subject: str, html: str) -> None:
    api_key = os.getenv("RESEND_API_KEY", "")
    if not api_key:
        print(f"[EMAIL] Sin RESEND_API_KEY — correo no enviado a {to}")
        return

    resend.api_key = api_key
    try:
        r = resend.Emails.send({
            "from": FROM_ADDRESS,
            "to": [to],
            "subject": subject,
            "html": html,
        })
        print(f"[EMAIL] Enviado OK → {to} | id={r.get('id')}")
    except Exception as e:
        print(f"[EMAIL] Error Resend → {e}")
        raise


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
