"""ASGI entry point:  uvicorn firealerts.main:app"""

from .api import create_app

app = create_app()
