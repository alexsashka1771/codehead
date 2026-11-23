"""Apply versioned migrations without storing a connection string in Alembic files."""

from pathlib import Path

from alembic import command
from alembic.config import Config

from codehead.persistence.database import Database
from codehead.settings import Settings


def migration_config() -> Config:
    return Config(str(Path(__file__).resolve().parents[2] / "alembic.ini"))


def migrate(database: Database) -> None:
    config = migration_config()
    with database.engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")


def main() -> None:
    settings = Settings()
    if not settings.database_configured:
        raise SystemExit(
            "CODEHEAD_DATABASE_URL is required; use npm run dev for the local database."
        )
    database = Database(settings.database_url.get_secret_value(), schema=settings.test_schema)
    try:
        migrate(database)
        print("PostgreSQL migrations are up to date.")
    finally:
        database.close()


if __name__ == "__main__":
    main()
