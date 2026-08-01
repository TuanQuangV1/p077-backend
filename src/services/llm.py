from typing import Any

from langchain_openai import ChatOpenAI

from src.config import get_settings


def get_llm() -> ChatOpenAI:
    settings = get_settings()
    kwargs: dict[str, Any] = {
        "model": settings.model_name,
        "api_key": settings.openai_api_key or "EMPTY",
        "temperature": settings.llm_temperature,
    }
    if settings.llm_provider == "vllm" and settings.vllm_base_url:
        kwargs["base_url"] = settings.vllm_base_url
        kwargs["model"] = settings.vllm_model_name
        kwargs["api_key"] = settings.vllm_api_key or "EMPTY"
        
    return ChatOpenAI(**kwargs)


def explain_diagnostics(summary: dict[str, Any]) -> dict[str, str | list[str]]:
    settings = get_settings()
    if settings.llm_provider != "vllm" or not settings.vllm_base_url:
        detections = summary.get("detections", [])
        labels = [item.get("kind", "unknown") for item in detections]
        primary = labels[0] if labels else "unknown"
        return {
            "root_cause": f"The dominant issue appears to be a {primary} pattern in the ROS topic stream.",
            "recommended_actions": [
                "Check the producing node for publish stalls or thread starvation.",
                "Validate the network / recorder path for bursty or dropped message windows.",
            ],
            "explanation": "The summary shows that the diagnostic payload contains a repeated timing anomaly, so the most likely source is a message producer or transport jitter issue rather than a downstream consumer failure.",
        }

    prompt = (
        "You are a robotics diagnostics assistant. Given the JSON summary below, "
        "return a short root-cause explanation and a small list of mitigation steps. "
        "Answer in plain language.\n\nJSON:\n"
        f"{summary}"
    )
    llm = get_llm()
    response = llm.invoke(prompt)
    content = response.content if hasattr(response, "content") else str(response)
    return {
        "root_cause": content[:200],
        "recommended_actions": ["Inspect the identified node/topic path first.", "Verify recorder-to-bus timing and message queue health."],
        "explanation": content[:350],
    }
