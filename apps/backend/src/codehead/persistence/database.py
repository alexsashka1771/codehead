"""Engine creation and bounded transactions."""

import re
from contextlib import contextmanager

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker


class Database:
    def __init__(self, url: str, *, schema: str | None = None):
        parsed = make_url(url)
        if parsed.get_backend_name() != "postgresql":
            raise ValueError("CodeHead requires PostgreSQL; no fallback database is supported")
        parsed = parsed.set(drivername="postgresql+psycopg")
        options = "-c statement_timeout=10000 -c lock_timeout=5000"
        if schema:
            if not parsed.database or not parsed.database.endswith("_test"):
                raise ValueError("Isolated schemas require an explicit test database")
            if not re.fullmatch(r"test_[a-f0-9]{32}", schema):
                raise ValueError("Invalid isolated test schema")
            options += f" -c search_path={schema}"
        self.engine = create_engine(
            parsed,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=5,
            connect_args={"connect_timeout": 3, "options": options},
            hide_parameters=True,
        )
        self.sessions = sessionmaker(self.engine, expire_on_commit=False)

    @contextmanager
    def read(self):
        with self.sessions.begin() as session:
            session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
            yield session

    def ping(self) -> None:
        with self.engine.connect() as connection:
            connection.execute(text("SELECT 1"))

    def close(self) -> None:
        self.engine.dispose()
