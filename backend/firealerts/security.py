"""Passwords, opaque tokens and encryption of stored secrets."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets

from cryptography.fernet import Fernet, InvalidToken

from .config import settings

log = logging.getLogger(__name__)
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    return "scrypt${n}${r}${p}${salt}${hash}".format(**_SCRYPT, salt=base64.b64encode(salt).decode(), hash=base64.b64encode(digest).decode())


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        calc = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), dklen=32, n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(calc, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


def sha256(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def new_token(prefix: str = "", nbytes: int = 32) -> str:
    return prefix + secrets.token_urlsafe(nbytes)


def _fernet() -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(("firealerts-secrets:" + settings.secret_key).encode()).digest())
    return Fernet(key)


def encrypt_json(data: dict) -> str:
    return _fernet().encrypt(json.dumps(data).encode()).decode()


def decrypt_json(token: str) -> dict:
    if not token:
        return {}
    try:
        return json.loads(_fernet().decrypt(token.encode()))
    except InvalidToken:
        log.error("cannot decrypt a stored secret: SECRET_KEY changed since it was saved")
        return {}


def sign(secret: str, payload: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


def insecure_secret_key() -> bool:
    return settings.secret_key in ("", "dev-insecure-change-me") or len(settings.secret_key) < 16
