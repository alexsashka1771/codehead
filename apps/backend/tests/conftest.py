import os
import secrets
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from codehead.main import create_app
from codehead.migrate import migrate
from codehead.persistence.database import Database
from codehead.settings import Settings


@pytest.fixture
def database():
    url = os.environ.get("CODEHEAD_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Use npm run test:backend to provision the isolated PostgreSQL test database")
    parsed = make_url(url)
    if not parsed.database or not parsed.database.endswith("_test"):
        pytest.fail("Integration tests require a database whose name ends in _test")
    schema = f"test_{uuid4().hex}"
    admin = create_engine(parsed.set(drivername="postgresql+psycopg"), hide_parameters=True)
    try:
        with admin.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    finally:
        admin.dispose()
    db = Database(url, schema=schema)
    migrate(db)
    yield db
    db.close()


@pytest.fixture
def client(database):
    token = secrets.token_urlsafe(32)
    settings = Settings(allowed_hosts=("testserver", "localhost", "127.0.0.1"), command_token=token)
    with TestClient(
        create_app(settings=settings, database=database), headers={"X-CodeHead-Token": token}
    ) as api:
        yield api


def command_headers(key=None):
    return {
        "X-CodeHead-Client": "browser",
        "Idempotency-Key": key or str(uuid4()),
        "Origin": "http://127.0.0.1:5180",
    }


@pytest.fixture
def project(client):
    response = client.post(
        "/api/projects",
        headers=command_headers(),
        json={
            "name": "Clinic test",
            "description": "Doctors, synthetic patients and appointments.",
            "profile": "clinic_demo",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()
