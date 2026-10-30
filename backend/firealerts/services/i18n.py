"""Server-side translations for alerts and e-mails (English, Spanish, Brazilian Portuguese).

Alerts use the organisation's language (org settings ``language``); account
e-mails (verification, reset) use the user's own language.
"""

from __future__ import annotations

LANGUAGES = ("en", "es", "pt")

T: dict[str, dict[str, str]] = {
    # ---- detection alerts
    "det.where_inside": {"en": "inside {asset}", "es": "dentro de {asset}", "pt": "dentro de {asset}"},
    "det.where_near": {"en": "{km} km from {asset}", "es": "a {km} km de {asset}", "pt": "a {km} km de {asset}"},
    "det.title.one": {"en": "1 fire detection {where}", "es": "1 foco de calor {where}", "pt": "1 foco de calor {where}"},
    "det.title.other": {"en": "{n} fire detections {where}", "es": "{n} focos de calor {where}", "pt": "{n} focos de calor {where}"},
    "det.text": {
        "en": "Satellites detected active fire {where}.\n\nNearest pixel: {lat}, {lon} ({source}, {time} UTC){frp}",
        "es": "Los satélites detectaron fuego activo {where}.\n\nPíxel más cercano: {lat}, {lon} ({source}, {time} UTC){frp}",
        "pt": "Os satélites detectaram fogo ativo {where}.\n\nPixel mais próximo: {lat}, {lon} ({source}, {time} UTC){frp}",
    },
    "det.frp": {"en": ", radiative power up to {frp} MW.", "es": ", potencia radiativa de hasta {frp} MW.", "pt": ", potência radiativa de até {frp} MW."},
    # ---- threat alerts
    "threat.title.likely": {"en": "Fire may reach {asset} within ~{h} h", "es": "El fuego podría llegar a {asset} en ~{h} h", "pt": "O fogo pode chegar a {asset} em ~{h} h"},
    "threat.title.possible": {
        "en": "Fire could reach {asset} within {h} h (worst case)",
        "es": "El fuego podría llegar a {asset} en {h} h (peor escenario)",
        "pt": "O fogo poderia chegar a {asset} em {h} h (pior cenário)",
    },
    "threat.text.likely": {
        "en": "An active fire {km} km away (bearing {bearing}°, {pixels} pixels, {frp} MW) is forecast to reach the asset in about {h} hours (median of the ensemble).",
        "es": "Un incendio activo a {km} km (rumbo {bearing}°, {pixels} píxeles, {frp} MW) podría alcanzar el área en unas {h} horas (mediana del ensamble).",
        "pt": "Um incêndio ativo a {km} km (rumo {bearing}°, {pixels} pixels, {frp} MW) pode alcançar a área em cerca de {h} horas (mediana do conjunto).",
    },
    "threat.text.possible": {
        "en": "An active fire {km} km away (bearing {bearing}°, {pixels} pixels, {frp} MW) could reach the asset within {h} hours (P90 envelope).",
        "es": "Un incendio activo a {km} km (rumbo {bearing}°, {pixels} píxeles, {frp} MW) podría alcanzar el área en {h} horas (envolvente P90).",
        "pt": "Um incêndio ativo a {km} km (rumo {bearing}°, {pixels} pixels, {frp} MW) poderia alcançar a área em {h} horas (envoltória P90).",
    },
    "threat.note": {
        "en": "Forecast: Canadian FBP rate of spread with ensemble weather; suppression not included.",
        "es": "Pronóstico: velocidad de propagación FBP canadiense con ensamble meteorológico; no incluye combate.",
        "pt": "Previsão: taxa de propagação FBP canadense com conjunto meteorológico; não inclui combate.",
    },
    # ---- risk alerts
    "risk.title": {"en": "{danger} fire danger forecast for {asset} on {date}", "es": "Peligro de incendio {danger} pronosticado para {asset} el {date}", "pt": "Perigo de incêndio {danger} previsto para {asset} em {date}"},
    "risk.text": {
        "en": "Fire Weather Index {fwi} ({danger}) is forecast for {date}{p}.\n\nWeather that day: {temp}°C, {rh}% humidity, wind {wind} km/h. Consider readiness measures and restricting burning.",
        "es": "Se pronostica un Índice Meteorológico de Incendios de {fwi} ({danger}) para el {date}{p}.\n\nTiempo previsto: {temp}°C, {rh}% de humedad, viento de {wind} km/h. Considere reforzar la preparación y restringir las quemas.",
        "pt": "Previsto Índice Meteorológico de Incêndio de {fwi} ({danger}) para {date}{p}.\n\nTempo previsto: {temp}°C, {rh}% de umidade, vento de {wind} km/h. Considere reforçar a prontidão e restringir queimadas.",
    },
    "risk.p": {
        "en": ", with an estimated {p}% chance of a satellite-detected fire in the area",
        "es": ", con una probabilidad estimada del {p}% de un foco detectado por satélite en la zona",
        "pt": ", com probabilidade estimada de {p}% de um foco detectado por satélite na região",
    },
    "danger.very_low": {"en": "very low", "es": "muy bajo", "pt": "muito baixo"},
    "danger.low": {"en": "low", "es": "bajo", "pt": "baixo"},
    "danger.moderate": {"en": "moderate", "es": "moderado", "pt": "moderado"},
    "danger.high": {"en": "high", "es": "alto", "pt": "alto"},
    "danger.very_high": {"en": "very high", "es": "muy alto", "pt": "muito alto"},
    "danger.extreme": {"en": "extreme", "es": "extremo", "pt": "extremo"},
    # ---- generic
    "open": {"en": "Open in Firealerts", "es": "Abrir en Firealerts", "pt": "Abrir no Firealerts"},
    "test.title": {"en": "Test alert from Firealerts", "es": "Alerta de prueba de Firealerts", "pt": "Alerta de teste do Firealerts"},
    "test.text": {
        "en": "This is a test notification for '{name}'. If you can read this, {org}'s alerts will arrive here.",
        "es": "Esta es una notificación de prueba para '{name}'. Si puede leerla, las alertas de {org} llegarán aquí.",
        "pt": "Esta é uma notificação de teste para '{name}'. Se você consegue ler isto, os alertas de {org} chegarão aqui.",
    },
    # ---- e-mails
    "email.verify.subject": {"en": "Confirm your e-mail address", "es": "Confirme su dirección de correo", "pt": "Confirme seu endereço de e-mail"},
    "email.verify.body": {
        "en": "Welcome to Firealerts! Confirm your address to activate your account.",
        "es": "¡Bienvenido a Firealerts! Confirme su dirección para activar su cuenta.",
        "pt": "Bem-vindo ao Firealerts! Confirme seu endereço para ativar sua conta.",
    },
    "email.verify.action": {"en": "Confirm e-mail", "es": "Confirmar correo", "pt": "Confirmar e-mail"},
    "email.reset.subject": {"en": "Reset your password", "es": "Restablezca su contraseña", "pt": "Redefina sua senha"},
    "email.reset.body": {
        "en": "Someone (hopefully you) asked to reset your Firealerts password. The link is valid for 2 hours. If it wasn't you, ignore this e-mail.",
        "es": "Alguien (esperamos que usted) pidió restablecer su contraseña de Firealerts. El enlace es válido por 2 horas. Si no fue usted, ignore este correo.",
        "pt": "Alguém (esperamos que você) pediu para redefinir sua senha do Firealerts. O link é válido por 2 horas. Se não foi você, ignore este e-mail.",
    },
    "email.reset.action": {"en": "Choose a new password", "es": "Elegir una nueva contraseña", "pt": "Escolher uma nova senha"},
    "email.invite.subject": {"en": "You're invited to {org} on Firealerts", "es": "Le invitaron a {org} en Firealerts", "pt": "Você foi convidado para {org} no Firealerts"},
    "email.invite.body": {
        "en": "{inviter} invited you to join {org} as {role}. The link expires in 14 days.",
        "es": "{inviter} le invitó a unirse a {org} como {role}. El enlace vence en 14 días.",
        "pt": "{inviter} convidou você para entrar em {org} como {role}. O link expira em 14 dias.",
    },
    "email.invite.action": {"en": "Accept invitation", "es": "Aceptar invitación", "pt": "Aceitar convite"},
    "email.digest.subject": {"en": "Firealerts daily summary: {n} alert(s) for {org}", "es": "Resumen diario de Firealerts: {n} alerta(s) para {org}", "pt": "Resumo diário do Firealerts: {n} alerta(s) para {org}"},
    "email.digest.action": {"en": "Open alerts", "es": "Ver alertas", "pt": "Ver alertas"},
    "push.test": {"en": "Push notifications are working on this device.", "es": "Las notificaciones push funcionan en este dispositivo.", "pt": "As notificações push estão funcionando neste dispositivo."},
}


def norm(lang: str | None) -> str:
    lang = (lang or "en").lower()[:2]
    return lang if lang in LANGUAGES else "en"


def t(lang: str | None, key: str, **params) -> str:
    entry = T[key]
    text = entry.get(norm(lang)) or entry["en"]
    return text.format(**params) if params else text


def plural(lang: str | None, key: str, n: int, **params) -> str:
    return t(lang, f"{key}.{'one' if n == 1 else 'other'}", n=n, **params)


def danger(lang: str | None, name: str) -> str:
    return t(lang, f"danger.{name}") if f"danger.{name}" in T else name.replace("_", " ")
