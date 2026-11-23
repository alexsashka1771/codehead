"""HTTP application factory."""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from codehead.api.routes import router as http_router
from codehead.api.security import install_security
from codehead.api.stream import router as stream_router
from codehead.persistence.database import Database
from codehead.persistence.service import ProjectService
from codehead.settings import Settings


def create_app(*, settings: Settings | None = None, database: Database | None = None) -> FastAPI:
    settings = settings or Settings()
    owns_database = database is None
    if database is None and settings.database_configured:
        database = Database(settings.database_url.get_secret_value(), schema=settings.test_schema)

    @asynccontextmanager
    async def lifespan(app):
        yield
        if owns_database and database is not None:
            database.close()

    app = FastAPI(title="CodeHead", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.database = database
    app.state.service = ProjectService(database) if database else None
    install_security(app, settings)
    app.include_router(http_router)
    app.include_router(stream_router)
    return app
