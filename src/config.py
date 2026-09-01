from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # App
    app_name: str = "AI20K Agent"
    app_env: Literal["development", "staging", "production", "test"] = "development"
    app_port: int = Field(default=8000, ge=1, le=65535)
    app_host: str = "0.0.0.0"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    cors_origins: str = "http://localhost:3000"
    # Optional regex for origins that cannot be enumerated, e.g. Vercel preview
    # deploys: r"https://p077-[a-z0-9-]+\.vercel\.app". Applied in addition to
    # the cors_origins allowlist.
    cors_origin_regex: str = ""

    # Auth (JWT)  # noqa: ERA001
    auth_username: str = "admin"
    auth_password: str = ""
    auth_password_hash: str = ""
    jwt_secret: str = ""
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = Field(default=60, ge=1, le=1440)

    # Legacy (deprecated) - kept for backwards compat env parsing
    api_auth_token: str = ""

    # LLM
    openai_api_key: str = ""
    model_name: str = "gpt-4o-mini"
    llm_temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    llm_provider: Literal["openai", "anthropic"] = "openai"
    llm_language: Literal["vi", "en"] = "en"
    anthropic_api_key: str = ""
    anthropic_model_name: str = "claude-sonnet-4-5"
    anthropic_max_tokens: int = Field(default=2048, ge=1, le=8192)
    # Output cap applied to every completion request (OpenAI/Anthropic). Without it
    # a single /chat call can bill thousands of output tokens (LLM10). 2048 rather
    # than 1024 because a cluster answer carries one finding per anomaly row: the
    # largest measured cluster (C_10 #1, 17 rows) spends ~900 output tokens, and a
    # reply cut at the cap loses every structured verdict in that cluster.
    llm_max_tokens: int = Field(default=2048, ge=1, le=8192)

    # HILT (human-in-the-loop) iterative debug triggers
    hilt_max_iterations: int = 5
    hilt_uncertainty_threshold: float = 0.5
    hilt_loop_similarity_threshold: float = 0.85
    hilt_max_failures: int = 3
    hilt_expert_email: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        """``cors_origins`` split on commas, trimmed, with empty entries dropped."""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
