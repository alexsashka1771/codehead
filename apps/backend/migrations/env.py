"""Run migrations against environment configuration or a caller-owned connection."""

from alembic import context

from codehead.persistence.database import Database
from codehead.persistence.models import Base
from codehead.settings import Settings

config = context.config


def configure(connection):
    context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


connection = config.attributes.get("connection")
if connection is not None:
    configure(connection)
else:
    settings = Settings()
    if not settings.database_configured:
        raise RuntimeError("Set CODEHEAD_DATABASE_URL before running migrations")
    database = Database(settings.database_url.get_secret_value())
    try:
        with database.engine.begin() as connection:
            configure(connection)
    finally:
        database.close()
