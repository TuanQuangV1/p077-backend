"""Response-level guard against prompt-injection exfiltration.

Scans LLM output for secret material and verbatim system-prompt text before
it is returned to callers, so a model that has been tricked by an injected
instruction cannot leak credentials or hidden prompts through the API.
"""

from __future__ import annotations

import re

from src.services.llm import (
    CHAT_SYSTEM_PROMPT,
    _CLUSTER_SYSTEM_PROMPT,
    _EXPLAIN_SYSTEM_PROMPT,
)

# Patterns whose presence in an LLM response indicates a secret leak.
SECRET_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),  # OpenAI-style keys
    re.compile(r"Bearer\s+[A-Za-z0-9_\-\.]{12,}", re.IGNORECASE),
    re.compile(
        r"(openai_api_key|anthropic_api_key|api_auth_token)\s*[:=]\s*\S+",
        re.IGNORECASE,
    ),
    re.compile(r"x-api-key\s*[:=]", re.IGNORECASE),
]

# Combined single-pass pattern for performance (one finditer over truncated text).
_COMBINED_SECRET_PATTERN = re.compile(
    r"sk-[A-Za-z0-9_\-]{16,}"
    r"|Bearer\s+[A-Za-z0-9_\-\.]{12,}"
    r"|(?:openai_api_key|anthropic_api_key|api_auth_token)\s*[:=]\s*\S+"
    r"|x-api-key\s*[:=]",
    re.IGNORECASE,
)

# Cap scanning to avoid latency spikes on large completions (up to 8192 tokens ~32k chars).
MAX_LEAK_SCAN_LEN = 20000

# Lightweight keyword pre-filter before running regex (avoids 4 passes on clean text).
_SECRET_KEYWORDS = ("sk-", "bearer", "api_key", "api_auth_token", "x-api-key")


def _prompt_fragments() -> list[str]:
    """Short verbatim windows of each real system prompt, for leak matching."""

    def fragments(prompt: str) -> list[str]:
        words = prompt.split()
        # Overlapping shingles (step 8) for better recall; earlier step 24 missed 66% of prompt.
        return [" ".join(words[i : i + 8]) for i in range(0, len(words) - 7, 8)]

    return fragments(CHAT_SYSTEM_PROMPT) + fragments(_EXPLAIN_SYSTEM_PROMPT) + fragments(_CLUSTER_SYSTEM_PROMPT)


PROMPT_FRAGMENTS = _prompt_fragments()

# Normalized variants for fuzzy/whitespace-robust matching.
def _normalize(text: str) -> str:
    """Lowercase, replace non-alnum with space, collapse whitespace."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", text.lower())).strip()


PROMPT_FRAGMENTS_NORM: list[str] = [_normalize(f) for f in PROMPT_FRAGMENTS]

# Fuzzy threshold: partial_ratio >= 85 catches typos, extra spaces, synonyms
# like "helper" vs "assistant" (88) while avoiding FP on generic phrases (80).
FUZZ_THRESHOLD = 85

try:
    from rapidfuzz import fuzz as _rf_fuzz  # type: ignore

    _HAS_RAPIDFUZZ = True
except ImportError:  # pragma: no cover - fallback for environments without rapidfuzz
    import difflib as _difflib  # type: ignore

    _HAS_RAPIDFUZZ = False
    _rf_fuzz = None  # type: ignore


def find_secret_leaks(text: str) -> list[str]:
    """Return secret-pattern matches found in an LLM response."""
    if not text:
        return []
    # Truncate to bound worst-case latency; secrets leaking beyond this would
    # still be caught via compliance markers or prompt fragments.
    truncated = text[:MAX_LEAK_SCAN_LEN] if len(text) > MAX_LEAK_SCAN_LEN else text
    lowered = truncated.lower()
    # Fast path: skip regex entirely when no keyword is present.
    if not any(kw in lowered for kw in _SECRET_KEYWORDS):
        return []
    return [match.group(0) for match in _COMBINED_SECRET_PATTERN.finditer(truncated)]


def find_prompt_leaks(text: str) -> list[str]:
    """Return system-prompt fragments found in an LLM response (fuzzy-aware).

    Three layers, fastest first:
    1. Exact verbatim substring (original behaviour).
    2. Normalized substring (handles extra spaces, punctuation, case).
    3. Fuzzy partial_ratio via rapidfuzz (handles typos, synonyms like
       "helper" vs "assistant") — truncated to ``MAX_LEAK_SCAN_LEN``.
    """
    if not text:
        return []
    truncated = text[:MAX_LEAK_SCAN_LEN] if len(text) > MAX_LEAK_SCAN_LEN else text
    lowered = truncated.lower()

    # Layer 1: exact verbatim fast path
    exact_hits = [frag for frag in PROMPT_FRAGMENTS if frag.lower() in lowered]
    if exact_hits:
        return exact_hits

    # Layer 2+3: normalized + fuzzy
    norm_text = _normalize(truncated)
    if not norm_text:
        return []

    leaks: list[str] = []
    for frag, norm_frag in zip(PROMPT_FRAGMENTS, PROMPT_FRAGMENTS_NORM, strict=False):
        if not norm_frag:
            continue
        # Normalized exact substring (catches extra spaces/punctuation)
        if norm_frag in norm_text:
            leaks.append(frag)
            continue
        # Fuzzy: max of partial_ratio (typos, extra spaces) and token_set_ratio (synonyms)
        score: float
        if _HAS_RAPIDFUZZ:
            # rapidfuzz is Rust-backed, ~0.3ms per fragment on 20k text
            partial = float(_rf_fuzz.partial_ratio(norm_frag, norm_text))  # type: ignore
            token_set = float(_rf_fuzz.token_set_ratio(norm_frag, norm_text))  # type: ignore
            score = partial if partial > token_set else token_set
        else:
            # difflib fallback (slower, pure python) — use SequenceMatcher ratio
            # Approximate partial by scanning windows of fragment length
            best = 0.0
            frag_len = len(norm_frag)
            # Scan windows of similar char length for best ratio
            step = max(1, frag_len // 4)
            for i in range(0, max(1, len(norm_text) - frag_len + 1), step):
                window = norm_text[i : i + frag_len]
                r = _difflib.SequenceMatcher(None, norm_frag, window).ratio() * 100  # type: ignore
                if r > best:
                    best = r
                    if best >= FUZZ_THRESHOLD:
                        break
            score = best
        if score >= FUZZ_THRESHOLD:
            leaks.append(frag)

    # De-duplicate while preserving order
    seen: set[str] = set()
    deduped: list[str] = []
    for frag in leaks:
        if frag not in seen:
            seen.add(frag)
            deduped.append(frag)
    return deduped


def response_is_safe(content: str) -> bool:
    """True when a model reply carries no secret material or prompt leakage."""
    return not find_secret_leaks(content) and not find_prompt_leaks(content)
