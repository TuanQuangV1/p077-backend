.PHONY: run test lint format typecheck check frontend-check check-all clean

run:
	uvicorn src.main:app --reload --reload-dir src --host 0.0.0.0 --port 8000

test:
	pytest tests/ -v

lint:
	ruff check src/ tests/

format:
	ruff format src/ tests/

typecheck:
	mypy src/

check: lint typecheck test

# Frontend gate — run from the frontend/ package (root has no test tooling).
frontend-check:
	cd frontend && pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm build

# What CI runs: backend + frontend.
check-all: check frontend-check

clean:
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type d -name .pytest_cache -exec rm -rf {} +
	find . -type d -name .ruff_cache -exec rm -rf {} +
