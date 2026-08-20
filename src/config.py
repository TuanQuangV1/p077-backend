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
    app_env: Literal["development", "production", "test", "staging"] = "development"
    app_port: int = Field(default=8000, ge=1, le=65535)
    app_host: str = "0.0.0.0"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    cors_origins: str = "http://localhost:3000"

    # Security
    api_auth_token: str = ""

    # LLM
    openai_api_key: str = ""
    model_name: str = "gpt-4o-mini"
    llm_temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    llm_provider: Literal["openai", "vllm"] = "openai"
    vllm_base_url: str = ""
    vllm_api_key: str = "EMPTY"
    vllm_model_name: str = "qwen2.5-coder-32b"

    # HILT (human-in-the-loop) iterative debug triggers
    hilt_max_iterations: int = 5
    hilt_uncertainty_threshold: float = 0.5
    hilt_loop_similarity_threshold: float = 0.85
    hilt_max_failures: int = 3
    hilt_expert_email: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
