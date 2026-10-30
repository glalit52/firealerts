"""Web Push (PWA notifications): RFC 8291 message encryption + RFC 8292 VAPID, using `cryptography`.

VAPID keys come from VAPID_PRIVATE_KEY (base64url raw P-256 scalar) or are derived
deterministically from SECRET_KEY, so every API/worker process signs with the
same key without extra configuration.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import time
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from ..config import settings

_P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def vapid_private_key() -> ec.EllipticCurvePrivateKey:
    raw = settings.vapid_private_key
    if raw:
        value = int.from_bytes(b64u_decode(raw), "big")
    else:
        value = int.from_bytes(hashlib.sha256(("firealerts-vapid:" + settings.secret_key).encode()).digest(), "big") % (_P256_ORDER - 1) + 1
    return ec.derive_private_key(value, ec.SECP256R1())


def _raw_public(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def vapid_public_key() -> str:
    return b64u(_raw_public(vapid_private_key().public_key()))


def vapid_header(endpoint: str, subject: str, ttl_s: int = 12 * 3600) -> str:
    u = urlparse(endpoint)
    header = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64u(json.dumps({"aud": f"{u.scheme}://{u.netloc}", "exp": int(time.time()) + ttl_s, "sub": subject}, separators=(",", ":")).encode())
    signing_input = f"{header}.{claims}".encode()
    r, s = decode_dss_signature(vapid_private_key().sign(signing_input, ec.ECDSA(hashes.SHA256())))
    token = f"{header}.{claims}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
    return f"vapid t={token}, k={vapid_public_key()}"


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def encrypt(payload: bytes, p256dh: str, auth: str, salt: bytes | None = None, server_key: ec.EllipticCurvePrivateKey | None = None, record_size: int = 4096) -> bytes:
    """aes128gcm content coding (RFC 8188) with the Web Push key derivation of RFC 8291."""
    ua_public = b64u_decode(p256dh)
    auth_secret = b64u_decode(auth)
    salt = salt or os.urandom(16)
    server_key = server_key or ec.generate_private_key(ec.SECP256R1())
    as_public = _raw_public(server_key.public_key())
    shared = server_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public))
    ikm = _hkdf(auth_secret, shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    if len(payload) + 1 + 16 > record_size:
        raise ValueError("push payload too large")
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)  # 0x02 = last-record delimiter
    header = salt + struct.pack("!IB", record_size, len(as_public)) + as_public
    return header + ciphertext


def decrypt(body: bytes, ua_private: ec.EllipticCurvePrivateKey, auth: str) -> bytes:
    """Receiver side (used in tests to check the encryption end to end)."""
    salt, rs, idlen = body[:16], *struct.unpack("!IB", body[16:21])
    as_public = body[21 : 21 + idlen]
    ciphertext = body[21 + idlen :]
    ua_public = _raw_public(ua_private.public_key())
    shared = ua_private.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))
    ikm = _hkdf(b64u_decode(auth), shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    plain = AESGCM(cek).decrypt(nonce, ciphertext, None)
    return plain.rstrip(b"\x00")[:-1]


async def send(client: httpx.AsyncClient, endpoint: str, p256dh: str, auth: str, data: dict, ttl: int = 3600, urgency: str = "high") -> int:
    """POST one notification. Returns the push service's status code (404/410 = subscription gone)."""
    body = encrypt(json.dumps(data, separators=(",", ":")).encode(), p256dh, auth)
    subject = settings.vapid_subject or f"mailto:{settings.smtp_from}"
    r = await client.post(
        endpoint,
        content=body,
        headers={"Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": str(ttl), "Urgency": urgency, "Authorization": vapid_header(endpoint, subject)},
    )
    return r.status_code
