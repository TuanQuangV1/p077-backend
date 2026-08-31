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
    model_name: str = "gpt-4.1"
    llm_temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    llm_provider: Literal["openai", "anthropic"] = "openai"
    llm_language: Literal["vi", "en"] = "vi"
    anthropic_api_key: str = ""
    anthropic_model_name: str = "claude-sonnet-4-5"
    anthropic_max_tokens: int = Field(default=1024, ge=1, le=8192)
    # Output cap applied to every completion request (OpenAI/Anthropic). Without it
    # a single /chat call can bill thousands of output tokens (LLM10).
    llm_max_tokens: int = Field(default=1024, ge=1, le=8192)

    # HILT (human-in-the-loop) iterative debug triggers
    hilt_max_iterations: int = 5
    hilt_uncertainty_threshold: float = 0.5
    hilt_loop_similarity_threshold: float = 0.85
    hilt_max_failures: int = 3
    hilt_expert_email: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
