# syntax=docker/dockerfile:1

# ---- Frontend dependency layer ----
FROM node:22-bookworm-slim AS frontend-deps

WORKDIR /app/frontend

RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml* frontend/.npmrc* ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile --ignore-scripts

# ---- Frontend production build ----
FROM frontend-deps AS frontend-builder

ARG API_PROXY_TARGET=http://127.0.0.1:8000
ENV API_PROXY_TARGET=$API_PROXY_TARGET

COPY frontend ./
RUN pnpm build

# ---- Frontend production image ----
FROM node:22-bookworm-slim AS frontend

WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

COPY --from=frontend-builder /app/frontend/public ./frontend/public
COPY --from=frontend-builder /app/frontend/.next/standalone ./frontend
COPY --from=frontend-builder /app/frontend/.next/static ./frontend/.next/static

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home nextjs \
    && chown -R nextjs:nextjs /app

USER nextjs

EXPOSE 3000

CMD ["node", "frontend/server.js"]

# ---- Frontend development image ----
FROM frontend-deps AS frontend-dev

WORKDIR /app/frontend
COPY frontend ./
EXPOSE 3000

CMD ["pnpm", "dev"]

# ---- Backend dependency layer ----
# Pin to a specific digest for reproducible builds.
# To update: docker pull python:3.11-slim && docker inspect python:3.11-slim --format '{{index .RepoDigests 0}}'
FROM python:3.11-slim AS backend-builder

WORKDIR /app

COPY pyproject.toml README.md requirements.txt ./
COPY src ./src

RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --default-timeout=100 --retries 5 --prefix=/install -r requirements.txt && \
    python -m pip install --no-deps --prefix=/install -e .

# ---- Backend production image (default final stage) ----
FROM python:3.11-slim AS backend

WORKDIR /app

COPY --from=backend-builder /install /usr/local
COPY pyproject.toml README.md ./
COPY src ./src
COPY data ./data

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && pip uninstall -y setuptools \
    && useradd --create-home appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD python -c "import os, urllib.request; port = os.environ.get('PORT', '8000'); urllib.request.urlopen(f'http://localhost:{port}/health')" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["sh", "-c", "exec uvicorn src.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
