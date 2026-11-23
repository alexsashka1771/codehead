"""Configuration from process environment; secrets never enter checked-in files."""

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CODEHEAD_", extra="ignore")

    database_url: SecretStr = SecretStr("")
    command_token: SecretStr = SecretStr("")
    test_schema: str | None = None
    test_step_delay_seconds: float = Field(default=1, ge=0, le=5, allow_inf_nan=False)
    worker_poll_seconds: float = Field(default=0.25, ge=0.05, le=5, allow_inf_nan=False)
    worker_lease_seconds: int = Field(default=30, ge=3, le=300)
    allowed_origins: tuple[str, ...] = (
        "http://127.0.0.1:5180",
        "http://localhost:5180",
        "http://127.0.0.1:8010",
        "http://localhost:8010",
    )
    allowed_hosts: tuple[str, ...] = ("127.0.0.1", "localhost")

    @property
    def database_configured(self) -> bool:
        return bool(self.database_url.get_secret_value().strip())
