import pytest

from codehead.persistence.database import Database


def test_platform_never_falls_back_to_sqlite():
    with pytest.raises(ValueError, match="PostgreSQL"):
        Database("sqlite://")


def test_test_schema_is_forbidden_in_user_database():
    with pytest.raises(ValueError, match="test database"):
        Database("postgresql://codehead@127.0.0.1/codehead", schema="test_" + "a" * 32)
