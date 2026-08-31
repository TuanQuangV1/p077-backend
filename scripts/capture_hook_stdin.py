import sys
import datetime

raw = sys.stdin.buffer.read()
ts = datetime.datetime.now().isoformat()

with open(r"P-077\.ai-log\hook_debug.txt", "a") as f:
    f.write(f"[{ts}] stdin ({len(raw)} bytes): {raw[:2000]}\n")
