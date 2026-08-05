"""Thread-safe sliding-window rate limiter.

Encapsulates per-client request accounting so the API layer has no mutable
module-level dicts. The limiter is keyed by client identifier and tracks hit
timestamps inside a lock; expired hits are pruned on each check.
"""

from __future__ import annotations

import threading
import time


class SlidingWindowRateLimiter:
    """Sliding-window limiter allowing ``max_requests`` per ``window_sec`` per key."""

    def __init__(self, max_requests: int, window_sec: float) -> None:
        self._max_requests = max_requests
        self._window_sec = window_sec
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        """Record a hit for ``key`` and return False when the limit is exceeded."""
        now = time.monotonic()
        with self._lock:
            hits = self._hits.setdefault(key, [])
            hits[:] = [t for t in hits if now - t < self._window_sec]
            if len(hits) >= self._max_requests:
                return False
            hits.append(now)
            return True

    def reset(self) -> None:
        """Drop all recorded hits (used by tests for isolation)."""
        with self._lock:
            self._hits.clear()
