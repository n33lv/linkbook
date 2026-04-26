"""Env loader + Pydantic-validated config. Mirrors apps/api/src/config.ts."""

from __future__ import annotations

from typing import Literal

from pydantic import AnyUrl, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppConfig(BaseSettings):
    """Validates the env at boot. Anything missing fails fast."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    NODE_ENV: Literal["development", "test", "production"] = "development"
    PORT: int = 3000
    LOG_LEVEL: Literal["fatal", "error", "warn", "info", "debug", "trace"] = "info"

    DATABASE_URL: str = "file:./linkbook.db"

    DEV_PRINCIPAL_EMAIL: str
    DEV_PRINCIPAL_NAME: str

    STUDIO_NAME: str
    STUDIO_FISCAL_YEAR_START: str = Field(pattern=r"^\d{2}-\d{2}$")
    STUDIO_BILLABLE_TARGET_PCT: float = Field(ge=0, le=100)
    STUDIO_LOADED_COST_RATE: float = Field(ge=0)

    ANTHROPIC_API_KEY: str | None = None

    # Agentspan SDK — these are the env names the SDK itself reads.
    # Setting them in our config keeps everything declared in one place.
    AGENTSPAN_SERVER_URL: AnyUrl | None = None
    AGENTSPAN_API_KEY: str | None = None
    AGENTSPAN_LLM_MODEL: str | None = None

    LLM_DAILY_KILL_SWITCH_USD: float = Field(default=20, gt=0)

    # Ranking weights — §1.3.
    RANK_W_MONEY: float = 0.40
    RANK_W_URGENCY: float = 0.25
    RANK_W_CLIENT_TIER: float = 0.15
    RANK_W_BLOCKING: float = 0.10
    RANK_W_NEGLECT: float = 0.10
    RANK_W_SNOOZED: float = 0.50

    USE_INTEGRATION_MOCKS: bool = True

    # Per-source escape hatch for the all-or-nothing mock toggle. Sources
    # listed here go to the real httpx transport even when
    # USE_INTEGRATION_MOCKS=true. Comma-separated, e.g. "harvest" or
    # "harvest,qbo". Lets you exercise one real integration during a PoC
    # while everything else stays on safe mocks.
    INTEGRATION_LIVE_SOURCES: str = ""

    # §5.3 — when true, action.execute routes through the Agentspan
    # orchestrator instead of the manual dispatcher. Default off in v1
    # so the test suite stays green without an Agentspan server / API key.
    # Lazy-fail: if the SDK/server/model isn't available at runtime, we
    # fall back to the direct dispatcher per-action.
    USE_AGENT_DISPATCH: bool = False

    # 30s soft-undo window. Tests override this to keep runs fast.
    SEND_DELAY_MS: int = Field(default=30_000, gt=0)

    # Integration creds — optional; per-source code refuses to connect
    # if the relevant pair is missing.
    QBO_CLIENT_ID: str | None = None
    QBO_CLIENT_SECRET: str | None = None
    QBO_REDIRECT_URI: AnyUrl | None = None
    QBO_ENVIRONMENT: Literal["sandbox", "production"] = "sandbox"

    HARVEST_CLIENT_ID: str | None = None
    HARVEST_CLIENT_SECRET: str | None = None
    HARVEST_REDIRECT_URI: AnyUrl | None = None

    DROPBOXSIGN_CLIENT_ID: str | None = None
    DROPBOXSIGN_CLIENT_SECRET: str | None = None
    DROPBOXSIGN_API_KEY: str | None = None

    AIRTABLE_CLIENT_ID: str | None = None
    AIRTABLE_CLIENT_SECRET: str | None = None
    AIRTABLE_REDIRECT_URI: AnyUrl | None = None

    GOOGLE_CLIENT_ID: str | None = None
    GOOGLE_CLIENT_SECRET: str | None = None
    GOOGLE_REDIRECT_URI: AnyUrl | None = None
    GOOGLE_PUBSUB_TOPIC: str | None = None

    @field_validator("DATABASE_URL")
    @classmethod
    def _normalize_db_url(cls, v: str) -> str:
        """Accept `file:./x.db`, `./x.db`, `/abs/path.db`, or
        `sqlite:///./x.db`. Stored as-is; the engine factory normalizes."""
        return v

    # Empty strings in .env for the OAuth URL fields should mean "not set",
    # not "invalid URL". Coerce "" → None before URL validation runs.
    @field_validator(
        "AGENTSPAN_SERVER_URL",
        "QBO_REDIRECT_URI",
        "HARVEST_REDIRECT_URI",
        "AIRTABLE_REDIRECT_URI",
        "GOOGLE_REDIRECT_URI",
        mode="before",
    )
    @classmethod
    def _empty_url_to_none(cls, v: object) -> object:
        if isinstance(v, str) and v.strip() == "":
            return None
        return v


def load_config() -> AppConfig:
    return AppConfig()  # type: ignore[call-arg]


# Hostname → source name. Used by the mock transport to decide whether
# a request should pass through to the real httpx transport.
INTEGRATION_HOST_SOURCES: dict[str, str] = {
    "intuit.com": "qbo",
    "quickbooks": "qbo",
    "harvestapp.com": "harvest",
    "harvest.com": "harvest",
    "dropboxsign.com": "dropboxsign",
    "hellosign.com": "dropboxsign",
    "airtable.com": "airtable",
    "googleapis.com": "gmail",
    "gmail.com": "gmail",
}


def live_sources(cfg: AppConfig) -> set[str]:
    """Parse INTEGRATION_LIVE_SOURCES into a normalized set."""
    if not cfg.INTEGRATION_LIVE_SOURCES:
        return set()
    return {s.strip().lower() for s in cfg.INTEGRATION_LIVE_SOURCES.split(",") if s.strip()}


def source_for_host(host: str) -> str | None:
    """Pick the integration source that owns this hostname, or None."""
    for marker, source in INTEGRATION_HOST_SOURCES.items():
        if marker in host:
            return source
    return None


def sqlalchemy_url(database_url: str) -> str:
    """Map our env's DATABASE_URL syntax to a SQLAlchemy URL."""
    if database_url.startswith("sqlite"):
        return database_url
    if database_url.startswith("file:"):
        path = database_url[len("file:") :]
    else:
        path = database_url
    # Strip any leading ./ for clarity in logs.
    if path.startswith("./"):
        path = path[2:]
    return f"sqlite+pysqlite:///{path}"
