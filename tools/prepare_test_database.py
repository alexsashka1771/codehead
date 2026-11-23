"""Create a fresh test schema without dropping or truncating existing data."""

import json
import os
from uuid import uuid4

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from codehead.migrate import migrate
from codehead.persistence.database import Database

url = os.environ["CODEHEAD_TEST_DATABASE_URL"]
parsed = make_url(url)
if not parsed.database or not parsed.database.endswith("_test"):
    raise SystemExit("An explicit _test database is required.")
schema = f"test_{uuid4().hex}"
engine = create_engine(parsed.set(drivername="postgresql+psycopg"), hide_parameters=True)
with engine.begin() as connection:
    connection.execute(text(f'CREATE SCHEMA "{schema}"'))
engine.dispose()
database = Database(url, schema=schema)
try:
    migrate(database)
finally:
    database.close()
print(json.dumps({"schema": schema}))
