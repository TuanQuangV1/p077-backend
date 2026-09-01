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

# Fuzzy threshold: partial_ratio >= 85 catches typos and mangled whitespace
# while avoiding false positives on generic phrasing (80).
FUZZ_THRESHOLD = 85

# How many distinct fragments the fuzzy layer must hit before it counts as a
# leak. A diagnosis is written in the vocabulary this prompt dictates, so a
# single fuzzy hit is what a *correct* answer looks like, not a disclosure:
# replayed over 67 known-good cluster explanations, one fuzzy hit withheld 3 of
# them for echoing "they are simultaneous symptoms of one shared event" - a
# sentence the cluster prompt orders the model to write. A real dump reproduces
# the prompt in sequence and trips several fragments at once. Exact and
# normalized substring hits still count on their own.
MIN_FUZZY_FRAGMENTS = 2

try:
    from rapidfuzz import fuzz as _rf_fuzz

    _HAS_RAPIDFUZZ = True
except ImportError:  # pragma: no cover - fallback for environments without rapidfuzz
    import difflib as _difflib

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


def _fuzzy_score(norm_frag: str, norm_text: str) -> float:
    """Order-sensitive similarity of a fragment against the reply text.

    Deliberately not a bag-of-words measure. ``token_set_ratio`` was used here
    and scored 85+ on clean diagnoses purely because they reuse the prompt's own
    vocabulary ("sensor", "transform", "anomaly", "overlaps") in a different
    order - it withheld 11 of 67 known-good cluster explanations, while
    ``partial_ratio`` on those same replies peaked at 63.
    """
    if _HAS_RAPIDFUZZ:
        # rapidfuzz is Rust-backed, ~0.3ms per fragment on 20k text
        return float(_rf_fuzz.partial_ratio(norm_frag, norm_text))
    # difflib fallback (slower, pure python): approximate partial_ratio by
    # scanning windows of the fragment's length for the best ratio.
    best = 0.0
    frag_len = len(norm_frag)
    step = max(1, frag_len // 4)
    for i in range(0, max(1, len(norm_text) - frag_len + 1), step):
        window = norm_text[i : i + frag_len]
        ratio = _difflib.SequenceMatcher(None, norm_frag, window).ratio() * 100
        if ratio > best:
            best = ratio
            if best >= FUZZ_THRESHOLD:
                break
    return best


def find_prompt_leaks(text: str) -> list[str]:
    """Return system-prompt fragments found in an LLM response (fuzzy-aware).

    Three layers, fastest first:
    1. Exact verbatim substring (original behaviour).
    2. Normalized substring (handles extra spaces, punctuation, case).
    3. Fuzzy ``partial_ratio`` (handles typos and mangled whitespace),
       requiring ``MIN_FUZZY_FRAGMENTS`` distinct hits - see that constant for
       why one fuzzy hit is a correct answer rather than a disclosure.

    Scanning is truncated to ``MAX_LEAK_SCAN_LEN``.
    """
    if not text:
        return []
    truncated = text[:MAX_LEAK_SCAN_LEN] if len(text) > MAX_LEAK_SCAN_LEN else text
    lowered = truncated.lower()

    # Layer 1: exact verbatim fast path
    exact_hits = [frag for frag in PROMPT_FRAGMENTS if frag.lower() in lowered]
    if exact_hits:
        return exact_hits

    norm_text = _normalize(truncated)
    if not norm_text:
        return []

    # Layer 2: normalized substring (extra spaces, punctuation, case)
    substring_hits = [
        frag
        for frag, norm_frag in zip(PROMPT_FRAGMENTS, PROMPT_FRAGMENTS_NORM, strict=False)
        if norm_frag and norm_frag in norm_text
    ]
    if substring_hits:
        return substring_hits

    # Layer 3: fuzzy, and only when corroborated by a second fragment
    fuzzy_hits = [
        frag
        for frag, norm_frag in zip(PROMPT_FRAGMENTS, PROMPT_FRAGMENTS_NORM, strict=False)
        if norm_frag and _fuzzy_score(norm_frag, norm_text) >= FUZZ_THRESHOLD
    ]
    return fuzzy_hits if len(fuzzy_hits) >= MIN_FUZZY_FRAGMENTS else []


def response_is_safe(content: str) -> bool:
    """True when a model reply carries no secret material or prompt leakage."""
    return not find_secret_leaks(content) and not find_prompt_leaks(content)
