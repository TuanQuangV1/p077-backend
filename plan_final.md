---
title: "RAV-13 — Plan hoàn thiện cuối (khắc phục 26 phát hiện kiểm toán)"
description: "Đóng 9 issue nghiêm trọng + các issue trung bình rẻ tiền: wire 2 panel giả vào backend thật, persist auth vào SQLite, CORS/headers env-driven, error boundaries, CI tối thiểu, đồng bộ contract BE↔FE. Data 100% mô phỏng — được chấp nhận, chỉ cần dán nhãn provenance."
status: completed
priority: P1
effort: ~34h
branch: fix/ui-1
tags: [audit-remediation, be-fe-integration, security, auth, testing, ci, ui]
created: 2026-09-01
completed: 2026-09-01
---

> **Trạng thái nghiệm thu (2026-09-01):** Phase 0–8 xong. `make check-all` xanh —
> backend 463 test / coverage 89.8% (routes.py 86%) / ruff + mypy sạch; frontend
> 39 vitest / tsc / `next build` xanh. #26 (nhãn synthetic) **descoped theo chủ
> dự án**. #14 hạ mức (code chết đã dọn). #18/#19 hoãn (chỉ có tác dụng khi lên
> VPS/GCP). Chi tiết từng phase ở lịch sử hội thoại; smoke test end-to-end
> (upload→analyze→health→deep-dive→review) cần backend+frontend chạy live —
> chưa chạy trong phiên này.

# RAV-13 — Plan hoàn thiện cuối

## 0. Bối cảnh & phạm vi đã chốt

Nguồn: `system_audit_report.md` (26 phát hiện: 9 nghiêm trọng, 12 trung bình, 4 thấp).

Quyết định phạm vi (đã xác nhận với chủ dự án):

| Chủ đề | Quyết định |
|---|---|
| Mục tiêu | **Cân bằng** — đóng hết 9 nghiêm trọng + issue trung bình rẻ tiền; hoãn hạ tầng nặng (Terraform, CI matrix đầy đủ) |
| Panel giả #8 / #9 | **Wire vào backend thật** (`/export/windows`, `/deep-dive` → `/analysis/explain`); bỏ `generateMockData` / `generateFallbackAnalysis` |
| Auth #1 / #6 | **Persist vào SQLite** — `users` + `jwt_blacklist` là bảng mới trong `run_store.py`; rate limiter giữ in-memory + ghi chú single-instance |
| Deploy | Hiện: Render (BE) + Vercel (FE). Có thể chuyển VPS + domain mới → **CORS/headers phải env-driven, không hardcode**. Plan hỗ trợ cả 2 đường |
| Data mô phỏng #26 | **Chấp nhận** — 100% synthetic, không có rosbag thật. Chỉ cần dán nhãn provenance rõ ràng trên UI + docs |

### Trạng thái xuất phát (đã kiểm chứng trên cây làm việc `fix/ui-1`)

- Có **diff chưa commit rất lớn** đang gỡ mock: xóa `frontend/lib/server/store.ts` (-754 dòng), `/api/stream`, `/api/llm/*`, `use-live-stream.ts`, `app/api/runs/[runId]/ai/route.ts`; `rav-console.tsx` viết lại nhiều. **Phải review + commit trước khi làm tiếp** (Phase 0).
- Backend đã có sẵn: `/analysis/{id}/health`, `/analysis/{id}/deep-dive`, `/analysis/{id}/export/windows`, `/analysis/explain`, `run_store.py` (SQLite), JWT chuẩn HS256, leak_guard, rate limiter.
- Next.js route handlers (`frontend/app/api/**`) đã là lớp proxy tới backend (`lib/server/backend.ts`).

### Kết quả xác minh báo cáo kiểm toán (2026-09-01, re-grep từng finding)

| Nhóm | Finding | Ghi chú |
|---|---|---|
| **Đúng hoàn toàn (19)** | 1, 2, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16, 17, 18, 19, 20, 21, 25, 26 | Bằng chứng file:line đã xác nhận |
| **Đúng, chỉnh số liệu (2)** | 24 | `routes.py` line-rate = **0.6711** (đúng "67%"). `export/windows` + `deep-dive` đã có test auth (chưa có happy-path); `health` / `review/stats` / `hilt/*` chưa có test API nào |
| | 22 | `uv.lock` + `pnpm-lock.yaml` **có tồn tại** → không "drift" nếu dùng `--frozen-lockfile`. Lỗ thật: `render.yaml` build bằng `requirements.txt` (không lock) |
| **Nói quá / nhẹ hơn (4)** | 3 | `ai-conclusion.tsx:111` **đã** dán nhãn `canned-fallback` → badge `"Heuristic Rule Engine"` (êm dịu). Thiếu nhãn ở `llm-deep-dive-panel` |
| | 11 | `fetchWindowSummaries` **đã có** cleanup (`rav-console.tsx:170-174`). Còn thiếu: `/api/overview` (157), `loadLlmRuns` (191), `thresholds` (203), stats `load` (586) |
| | 12 | `HZ_EXCLUDED_*` có comment giải thích domain rõ ràng → **không phải bug**. Thật: `PLD-01` badge tĩnh + `any` ở `fleet-trend-chart.tsx:37` |
| | 23 | Scripts dùng thang fallback `elif [ -x ... ]`, dò `PATH` trước; path Windows là nhánh cuối. Tác động thấp |
| **Đã lỗi thời / sai (1)** | 14 | Không component production nào gọi `/timeline`, `/simulation`, `POST /api/reports` (chỉ có trong file test). `/reports` = route trang client. `/ai` route **đã bị xóa**. `/logs` → Next handler trả `{logs:[]}` + client `.catch` → **không bao giờ 404**. Vấn đề thật = code chết trong `resolveApiUrl` |

---

## 1. Data flow tổng thể (sau khi hoàn thiện)

```
rosbag mô phỏng (data/<id>/*.mcap|*.db3)
  → iter_bag_messages  → detect_anomalies (luật cứng)  → run_store (SQLite)
  → compute_health_summary  → /analysis/{id}/health
  → build_deep_dive_prompt  → /analysis/{id}/deep-dive  → /analysis/explain (LLM thật, fallback canned CÓ NHÃN)
  → iter_window_jsonl_lines → /analysis/{id}/export/windows (jitter/hz/gap thật)

Frontend (Next 16, Vercel/VPS)
  → /api/v1/* rewrite → backend origin (1 nơi cấu hình: API_PROXY_TARGET|NEXT_PUBLIC_API_URL)
  → SWR fetch: overview / analysis detail / health / windows / deep-dive
  → mọi panel đọc từ dữ liệu backend; badge "Dữ liệu mô phỏng" ở tầng dataset
```

---

## 2. Các phase

Ownership file ghi rõ để chạy song song không đụng nhau. Thứ tự phụ thuộc ở §3.

---

### Phase 0 — Chốt baseline & vệ sinh nhánh  ·  ~2h  ·  P1

**Mục tiêu:** biết chính xác đang đứng ở đâu trước khi sửa.

1. Review toàn bộ diff chưa commit (`git diff`, `git diff --staged`). Với mỗi file: xác nhận là refactor gỡ-mock hợp lệ, không có regression.
2. Chạy `make check` (ruff + mypy + pytest) và `pnpm lint && pnpm test`. Ghi lại số test pass/fail + coverage `routes.py` hiện tại (báo cáo nói 67%).
3. Commit diff hợp lệ theo từng nhóm logic (BE refactor / FE refactor / config). Nếu có phần dở dang không chạy → tách ra, đánh dấu `WIP`, không commit vào nhánh chính của plan.
4. Tạo nhánh làm việc `fix/final-polish` từ `fix/ui-1` sau khi commit sạch.

**Done:** cây làm việc sạch, `make check` xanh (hoặc danh sách fail đã biết được ghi lại), coverage baseline được ghi.
**Risk:** diff lớn ẩn regression. **Mitigation:** chạy e2e (`playwright test`) trước khi commit.
**Rollback:** diff đã ở trong git, `git stash`/`git checkout` an toàn.

---

### Phase 1 — Sự thật tích hợp BE ↔ FE  ·  ~6h  ·  P1  ·  (#8, #9, #15; #14 = dọn code chết)

**Files:**
`frontend/components/health/latency-jitter-panel.tsx`, `frontend/components/health/llm-deep-dive-panel.tsx`, `frontend/components/health/analysis-health-panel.tsx`, `frontend/lib/api.ts`, `frontend/lib/types.ts`, `frontend/app/api/runs/[runId]/logs/route.ts`, `frontend/app/api/runs/[runId]/**`, `src/models/schemas.py` (chỉ đọc để đối chiếu).

**1.1 — Latency/Jitter panel → dữ liệu thật (#8)**
- Bỏ `generateMockData`. Panel nhận `windowRows: WindowSummaryRow[]` (đã có sẵn `fetchWindowSummaries` trong `rav-console.tsx:171`).
- Map: `jitter_ms` → chế độ "jitter", `max_gap_ms` → "latency"/gap, `drift_ms` → "clock". Ngưỡng `THRESHOLD_MS` giữ nguyên nhưng đọc từ `diagnostics/thresholds.json` nếu khả thi, nếu không thì hằng số có comment.
- Khi `windowRows` rỗng → empty state "Chưa có dữ liệu cửa sổ", KHÔNG vẽ số giả.

**1.2 — LLM Deep-Dive panel → LLM thật (#9)**
- `triggerDeepDive()` gọi `GET /api/v1/analysis/{runId}/deep-dive` lấy `prompt` + `health`, rồi `POST /api/v1/analysis/explain` với prompt đó → nhận `root_cause` / `recommended_actions` / `explanation`.
- Thêm helper trong `api.ts`: `fetchDeepDive(runId)` và dùng lại `post('/api/analysis/explain', …)`.
- Giữ `generateFallbackAnalysis` **chỉ** làm nhánh catch khi request lỗi, và render badge `Fallback (LLM offline)` màu amber. Khi kết quả đến từ backend với `model === "canned-fallback"` → cũng hiện badge đó (xem 3.4).
- Bỏ auto-trigger vô điều kiện; chỉ auto khi `health.trigger_llm_deep_dive === true` (đã đúng) và thêm hủy khi unmount.

**1.3 — Dọn code chết endpoint (#14 — đã hạ mức, ~1h)**
- Xác minh lại (2026-09-01): **không có** user-facing 404. Việc thật là dọn code chết:
  - `frontend/lib/api.ts:19-20` — bỏ nhánh passthrough `/simulation`, `/timeline` trong `resolveApiUrl` (không caller nào). Giữ `/logs` (có caller ở `rav-console.tsx:164`).
  - Grep `POST("/api/reports"` chỉ trong file test — xoá code/test chết, hoặc nếu "Diagnostic Reports" là tính năng muốn có thì tạo issue riêng (ngoài scope).
  - `/reports` ở sidebar (`app-sidebar.tsx:44`) render catch-all `RavConsole` — xác nhận trang này có nội dung thật hay bỏ khỏi nav.
- `/logs`: giữ handler trả `{logs: []}` (log là anomaly `log_*` đã kèm trong detections) — thêm comment liên kết tới nơi render log severity.
- Ghi bảng "FE route → BE endpoint → trạng thái" vào `docs/api_contract.md`.

**1.4 — Khớp data model (#15 — đã xác minh đúng)**
- `runRootCause`: `AnalysisDetailResponse.runRootCause` (schemas.py:158) — **0 tham chiếu** trong frontend hiện tại. Thêm type `RunRootCause` vào `types.ts`, map trong lớp fetch analysis detail, render "Nguyên nhân gốc toàn run" ở `ai-conclusion.tsx` hoặc panel health.
- `evidence`: `Anomaly` type (`types.ts:151-169`) **không có field `evidence`** → `AnomalySummary.evidence: dict[str, object]` (schemas.py:80) bị rơi hoàn toàn ở FE. Lưu ý backend có **2 shape** khác nhau: `AnomalySummary.evidence` là `dict`, `AIResultSummary.evidence` là `list[EvidenceItem]` (schemas.py:100) — FE `Evidence` khớp cái thứ 2. Quyết định: hoặc (a) thêm `evidence` vào `Anomaly` type theo shape backend hiện có, hoặc (b) đổi `AnomalySummary.evidence` sang `list[EvidenceItem]` cho nhất quán rồi thêm vào FE. Khuyến nghị (b). Viết test contract 2 chiều.

**Done:** không panel nào gọi `Math.random`/`Math.sin` để tạo số liệu hiển thị; deep-dive hiện text từ LLM thật khi có key; `grep -rn "generateMock\|generateFallback" frontend/` chỉ còn trong nhánh fallback có nhãn; e2e `analysis.spec.ts` xanh.
**Risk:** LLM key không có trong CI/preview → panel luôn fallback. **Mitigation:** test cả 2 nhánh; badge rõ ràng; doc nêu cần `OPENAI_API_KEY`.
**Rollback:** revert theo component, panel cũ vẫn render (chỉ là giả).

---

### Phase 2 — Bảo mật  ·  ~5h  ·  P1  ·  (#16, #17, #18, #19)

**Files:** `render.yaml`, `src/config.py`, `src/main.py`, `frontend/next.config.mjs`, `nginx/nginx.conf`, `.env.example`, `terraform/gcp/main.tf`.

**2.1 — CORS không còn `*` (#16)**
- `render.yaml`: `CORS_ORIGINS` = danh sách rõ ràng, mặc định `https://<app>.vercel.app,http://localhost:3000`. Đặt giá trị thật qua Render dashboard (`sync: false` nếu cần đổi nhanh).
- `src/main.py:41`: giữ `split(",")` nhưng `strip()` từng phần tử, bỏ rỗng; nếu `APP_ENV in {production,staging}` và origins chứa `*` → log WARNING (không fail, để không khóa demo) hoặc raise tùy khẩu vị — khuyến nghị: raise ở production, warn ở staging.
- Hỗ trợ `CORS_ORIGIN_REGEX` optional cho preview deploy của Vercel (`https://p077-*\.vercel\.app`).

**2.2 — Security headers (#17)**
- `next.config.mjs`: thêm `async headers()` → `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security` (chỉ khi HTTPS), `Content-Security-Policy` (bắt đầu report-only, siết dần — `default-src 'self'`, cho phép `connect-src` tới backend origin).
- `nginx/nginx.conf`: `add_header` tương ứng trong block `server 443` (dùng `always`).
- Backend: cân nhắc middleware nhỏ set `X-Content-Type-Options` cho JSON API (tùy chọn, thấp ưu tiên).

**2.3 — Nginx rate limiting (#18)** — chỉ làm nếu chuyển sang VPS/nginx
- `limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;` + `limit_req zone=api burst=20 nodelay;` trong `location /api/`.
- Hạ `client_max_body_size` xuống `512m` (hoặc theo `MAX_UPLOAD_BYTES` thật), thêm `limit_req` riêng nới cho `location = /api/v1/datasets/upload`.

**2.4 — Firewall Terraform (#19)** — **HOÃN**, chỉ ghi chú
- Thêm comment trong `main.tf` nêu rủi ro `0.0.0.0/0` cho HTTP; khi lên production thật thì đặt sau Cloudflare/LB và siết. Không sửa hạ tầng trong plan này.

**Done:** `curl -I` tới FE trả đủ 4 header; production reject origin lạ; `render.yaml` không còn `"*"`.
**Risk:** CSP quá chặt làm vỡ UI (Recharts inline style, next). **Mitigation:** bật `Content-Security-Policy-Report-Only` trước, quan sát 1-2 ngày, rồi enforce.
**Rollback:** headers là additive, gỡ block `headers()` là xong.

---

### Phase 3 — Vững chắc backend  ·  ~6h  ·  P1/P2  ·  (#1, #3, #4, #5, #6, #7)

**Files:** `src/services/auth.py`, `src/services/run_store.py`, `src/api/routes.py`, `src/services/analysis.py`, `pyproject.toml`, `frontend/components/health/llm-deep-dive-panel.tsx` + `frontend/components/ai-conclusion.tsx` (nhãn canned).

**3.1 — Persist users vào SQLite (#1)**
- Thêm bảng `users(username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)` vào `_SCHEMA` (`run_store.py:26`).
- `run_store` API mới: `get_user(username)`, `create_user(username, hash)`, `user_exists(username)`.
- `auth.py`: `register_user` / `verify_credentials` đọc-ghi qua `run_store` thay cho `_USERS` dict. Giữ `_verify_env_credentials` cho admin từ env (không đưa admin vào bảng).
- `clear_users()` (test helper) → xóa bảng `users` trong DB test.
- Giữ dummy-hash timing guard (`_DUMMY_HASH`) nguyên vẹn.

**3.2 — Persist JWT blacklist vào SQLite (#6)**
- Bảng `jwt_blacklist(jti TEXT PRIMARY KEY, exp REAL NOT NULL)`.
- `blacklist_token` / `is_blacklisted` / `_cleanup_blacklist` (xóa `WHERE exp < now`) qua `run_store`.
- Rate limiter (`routes.py:133`): **giữ in-memory**, thêm docstring + dòng trong `ARCHITECTURE.md` "chỉ đúng cho single instance; scale ngang cần Redis". Không over-engineer.

**3.3 — Migration SQLite không nuốt lỗi mù (#4, #5)**
- `run_store._init`: bọc migration trong hàm `_migrate(conn)` có tên rõ. `except sqlite3.OperationalError as e:` chỉ nuốt khi message chứa `"duplicate column"` / `"already exists"`; còn lại `logger.warning(...)` kèm chi tiết rồi re-raise. Không `except sqlite3.Error: pass` trần.
- WAL pragma (`run_store.py:118`): nếu fail → `logger.warning("WAL pragma failed: %s", e)` thay vì `pass` câm.
- `auth.verify_password` (`auth.py:68`): bắt `Exception` → thêm `logger.debug("password verify failed: %s", e)` (debug, không leak). Giữ trả `False`.
- Rà `grep -rn "except.*:\s*$\|except.*: pass" src/` — với mỗi chỗ: hoặc thu hẹp exception, hoặc thêm log. Danh sách đầy đủ tạo ở Phase 0.

**3.4 — Nhãn "không phải AI thật" (#3 — đã có nhãn êm, cần rõ hơn)**
- Backend: `model="canned-fallback"` đã có (`analysis.py:411`), server chặn approve (routes.py:1583) — giữ.
- `ai-conclusion.tsx:111-113` **đã** map `canned-fallback` → badge `"Heuristic Rule Engine"`. Đổi label thành rõ ràng hơn: `"Phân tích mẫu — LLM offline"` màu amber + tooltip giải thích.
- `llm-deep-dive-panel.tsx` **chưa** có nhãn nào cho `generateFallbackAnalysis` → thêm badge `Fallback (LLM offline)` như 1.2.
- Đảm bảo `AIResult` type FE có field `model` (đã có ở `types.ts`).

**3.5 — Thống nhất Python version (#7)**
- `pyproject.toml:117` `mypy python_version = "3.12"` → `"3.11"` để khớp `requires-python`, ruff, black target. Chạy `mypy src/` xác nhận không phát sinh lỗi mới.

**Done:** restart backend → user đã signup vẫn login được; token đã logout vẫn bị từ chối sau restart; `grep "except sqlite3.Error: pass" src/` rỗng; `mypy` một version.
**Risk:** thêm bảng vào `_SCHEMA` chạy trên `data/runs.db` hiện có. **Mitigation:** `CREATE TABLE IF NOT EXISTS` là an toàn; test với copy của `data/runs.db` thật trước.
**Rollback:** bảng mới không phá bảng cũ; revert code auth về dict in-memory nếu cần.

---

### Phase 4 — Vững chắc frontend  ·  ~4h  ·  P2  ·  (#10, #11, #12, #13)

**Files:** `frontend/app/error.tsx` (mới), `frontend/app/loading.tsx` (mới), `frontend/app/global-error.tsx` (mới), `frontend/app/**/error.tsx` cho route con nếu cần, `frontend/components/rav-console.tsx`, `frontend/components/health/topic-health-table.tsx`, `frontend/components/health/data-bandwidth-panel.tsx`, `frontend/components/dashboard/fleet-trend-chart.tsx`, `frontend/public/`.

**4.1 — Error & loading boundaries (#10)**
- `app/error.tsx` (client, có `reset()`), `app/global-error.tsx`, `app/loading.tsx`. Route nặng (`app/[...slug]`, `app/login`, `app/signup`) thêm `error.tsx` riêng nếu hành vi khác.
- UI lỗi: thông báo tiếng Việt gọn + nút "Thử lại" + link về trang chủ. Không lộ stack trace ở production.

**4.2 — Cleanup useEffect (#11 — phạm vi đã thu hẹp sau xác minh)**
- `fetchWindowSummaries` (`rav-console.tsx:170-174`) **đã có** cleanup — bỏ qua.
- Còn thiếu, cần thêm cờ `let cancelled = false` + `return () => { cancelled = true }`: `/api/overview` (dòng ~157), `Promise.all` chi tiết run + logs (~158-165), `loadLlmRuns` (~191-200), `thresholds` fetch (~203), `stats load` (~583-586).
- Kiểm tra: mount/unmount nhanh trong test, không có warning "set state on unmounted".

**4.3 — Gỡ hardcode (#12 — 1 việc thật + 1 tùy chọn)**
- `fleet-trend-chart.tsx:37` `CustomTooltip = ({...}: any)` → type đúng theo Recharts `TooltipProps`. **(bắt buộc)**
- `data-bandwidth-panel.tsx:261` badge `"PLD-01"` là nhãn tĩnh cosmetic → lấy từ `anomaly.id`/`kind` thật, hoặc bỏ badge. **(nên làm, rẻ)**
- `topic-health-table.tsx:29-46` `HZ_EXCLUDED_*`: **đã có comment giải thích domain đầy đủ** → giữ nguyên, chỉ thêm 1 dòng link tới nơi định nghĩa nguồn (thresholds/diagnostics). **Không refactor.**

**4.4 — Dọn placeholder assets (#13)**
- Xóa 5 file `frontend/public/placeholder-*` nếu `grep -rn "placeholder" frontend/ --include=*.tsx` không tham chiếu. Nếu có tham chiếu → thay bằng asset thật hoặc bỏ tham chiếu.

**Done:** tắt mạng giữa lúc load run → UI hiện lỗi có nút retry, không trắng trang; `grep -n "any" fleet-trend-chart.tsx` sạch; unmount không warning.
**Risk:** thấp.
**Rollback:** xóa file boundary mới là quay lại hành vi cũ.

---

### Phase 5 — Cấu hình & hạ tầng nhẹ  ·  ~3h  ·  P2  ·  (#20, #21, #22, #23)

**Files:** `docker-compose.yml`, `.env.example`, `requirements.txt`, `pyproject.toml`/`uv.lock`, `package.json`/`pnpm-lock.yaml`, `scripts/_pyrun.sh`, `scripts/setup_hooks.sh`, `scripts/setup_hooks.ps1`.

**5.1 — docker-compose dev không còn 503 (#20)**
- `docker-compose.yml:12` service `backend` đang `APP_ENV: production` nhưng `.env` mặc định `JWT_SECRET=` rỗng → 503. Sửa: service mặc định `APP_ENV: development` (auth bypass, đúng cho dev), giữ `backend` + `frontend` là stack "chạy thử local". Đường production thật dùng `docker-compose.prod.yml`.
- Hoặc: `.env.example` sinh sẵn `JWT_SECRET` dev-only kèm comment to đùng "đổi khi deploy". Chọn cách 1 (rõ ý đồ hơn).
- Thêm dòng README: "dev = `docker compose up`, prod = `docker compose -f docker-compose.prod.yml up`".

**5.2 — Dọn `.env.example` (#21)**
- Xóa: `DATABASE_URL=postgresql://…`, `CHROMA_PERSIST_DIR`, `PINECONE_*`, `LANGCHAIN_*` (nếu LangSmith không dùng thật — xác nhận với chủ dự án, xem §5 câu hỏi mở).
- Sắp lại theo nhóm: LLM / App / Security / Persistence / Logging / Frontend. Mỗi biến 1 dòng comment mục đích. Khớp 100% với `src/config.py`.

**5.3 — Lock dependencies (#22 — lỗ thật: build không dùng lockfile)**
- `uv.lock` + `pnpm-lock.yaml` **đã tồn tại** → local build ổn nếu dùng `--frozen-lockfile`. Việc thật:
  - `render.yaml:5` build bằng `pip install -r requirements.txt` (dùng `>=`, **không** dùng `uv.lock`) → sinh `requirements.txt` pinned từ `uv export --no-hashes` và commit; hoặc đổi buildCommand sang `uv sync --frozen`.
  - CI (Phase 6) phải chạy `pip install -r requirements.txt` + `pnpm install --frozen-lockfile` để bắt lệch sớm.
- `next: 16.2.12` — xác minh resolve trong `pnpm-lock.yaml` khi CI chạy `--frozen-lockfile`. Nếu registry không có → hạ về bản Next 16 hợp lệ gần nhất (đã được chủ dự án cho phép, §8 câu 6).
- `passlib` ít bảo trì → tạo issue riêng, HOÃN (rủi ro đổi lib auth trước demo).

**5.4 — Scripts (#23 — nói quá, chỉ dọn nhẹ)**
- `_pyrun.sh` / `setup_hooks.{sh,ps1}` đã có thang fallback hợp lý (dò `PATH` trước). Chỉ cần: thêm rung đầu tiên `[ -n "$PYTHON" ] && PY="$PYTHON"` để override; đảm bảo `command -v python3` đứng trước path Windows tuyệt đối.
- Scripts hardcode `http://localhost:8000` → đọc `${API_BASE:-http://localhost:8000}`.
- Ưu tiên thấp, làm nếu còn thời gian.

**Done:** `cp .env.example .env && docker compose up` → backend healthy, không 503; `pnpm install --frozen-lockfile` + `pip install -r requirements.txt` deterministic; scripts chạy trên máy không phải Windows.
**Risk:** pin `==` có thể kéo lệch với môi trường Render (Python 3.11.9). **Mitigation:** build thử trên Render preview.
**Rollback:** giữ bản `.env.example` cũ trong git history.

---

### Phase 6 — Test & CI  ·  ~5h  ·  P1  ·  (#24, #25)

**Files:** `tests/test_api/test_routes.py`, `tests/test_security/test_auth_hardening.py` (đã có, mở rộng), `tests/test_services/test_run_store.py`, `.github/workflows/ci.yml` (mới), `package.json`.

**6.1 — Phủ 7 endpoint chưa test (#24)**
| Endpoint | Case tối thiểu |
|---|---|
| `GET /analysis/{id}/health` | 200 shape + 404 run lạ + per-owner isolation |
| `GET /analysis/{id}/deep-dive` | 200 (`triggered` bool, có `prompt`) + 404 + auth |
| `GET /analysis/{id}/export/windows` | 200 NDJSON parse được + 404 dataset thiếu + `window_sec` biên |
| `GET /review/stats` | 200 shape + rỗng khi chưa có review |
| `GET /hilt/summary/{id}` | 200 + 404 |
| `POST /hilt/iterate` | 200 happy + body sai → 422 |
| `POST /hilt/fix/{id}` | 200 ghi `expert_fixes` + đọc lại được |

- Auth error paths: token hết hạn, chữ ký sai, token đã blacklist (sau restart — test persist), thiếu header → 401.
- Upload: file sai định dạng, zip có `../`, vượt `MAX_UPLOAD_BYTES` → lỗi đúng mã.
- Mục tiêu: `routes.py` line coverage **≥ 85%**.

**6.2 — CI tối thiểu (#25)**
`.github/workflows/ci.yml` — 2 job chạy song song trên push + PR:
- `backend`: setup Python 3.11 → `pip install -r requirements.txt -e .` → `ruff check` → `mypy src/` → `pytest --cov=src --cov-fail-under=80`.
- `frontend`: setup Node + pnpm → `pnpm install --frozen-lockfile` → `pnpm lint` (tsc) → `pnpm test` (vitest) → `pnpm build`.
- (Tùy chọn) job `e2e` chạy Playwright, cho phép `continue-on-error` ban đầu.
- Thêm `make check-all` gộp cả FE + BE cho local.

**Done:** CI xanh trên PR mở từ `fix/final-polish`; coverage gate pass; 7 endpoint có test.
**Risk:** e2e flaky trong CI (cần LLM key + build). **Mitigation:** e2e non-blocking giai đoạn đầu; mock LLM bằng `is_llm_configured() = False` để test nhánh canned.
**Rollback:** workflow độc lập, xóa file là xong.

---

### Phase 7 — Nhãn provenance dữ liệu mô phỏng  ·  ~2h  ·  P2  ·  (#26, #2)

**Files:** `frontend/components/datasets/*`, `frontend/components/top-bar.tsx`, `src/services/iterative_debug.py`, `README.md`, `docs/data_contract.md`.

**7.1 — Dán nhãn "Dữ liệu mô phỏng" (#26)**
- Dataset seed bởi `scripts/seed_*.py` → thêm field `synthetic: true` (hoặc `source: "synthetic"`) vào metadata dataset khi seed.
- FE: badge `Mô phỏng` cạnh tên dataset trong danh sách + trang chi tiết + top-bar khi đang xem run của dataset synthetic.
- `README.md` + `docs/data_contract.md`: nêu rõ toàn bộ `data/` là synthetic có inject lỗi cố ý; hướng dẫn khi có rosbag thật thì bỏ nhãn thế nào.

**7.2 — HILT loop dummy (#2)** — **document, không sửa logic**
- `iterative_debug.py:293` hardcode `test_pass=False`, `test_comment="awaiting engineer test"` là **đúng** cho hệ không có kỹ sư thật trong vòng lặp. Thêm docstring + comment nêu rõ đây là placeholder chờ input người thật; endpoint `/hilt/iterate` nhận `test_pass`/`test_comment` từ body khi có.
- Nếu UI HILT đang hiển thị như kết quả thật → thêm nhãn "Chờ kỹ sư xác nhận".

**Done:** mọi dataset synthetic có badge; README nói thật về dữ liệu; không chỗ nào trình bày dummy HILT như đã kiểm chứng.
**Risk:** thấp.

---

### Phase 8 — Đồng bộ docs & nghiệm thu cuối  ·  ~2h  ·  P2

**Files:** `docs/api_contract.md`, `docs/data_contract.md`, `ARCHITECTURE.md`, `README.md`, `docs/codebase-summary.md`.

1. Cập nhật `api_contract.md`: bảng FE route → BE endpoint (từ Phase 1.3), endpoint mới/đổi.
2. `ARCHITECTURE.md`: security boundaries — CORS env-driven, headers, blacklist persist, rate limiter single-instance.
3. `README.md`: mục "Chạy local" (dev compose), "Deploy" (Render+Vercel env + đường VPS), "Dữ liệu là mô phỏng".
4. Chạy `repomix` → cập nhật `docs/codebase-summary.md`.
5. Nghiệm thu: checklist §4 toàn bộ xanh; `make check` + CI xanh; e2e xanh; smoke test thủ công lộ trình upload → analyze → health → deep-dive → review.

---

## 3. Đồ thị phụ thuộc

```
Phase 0  ──►  mọi phase khác
Phase 1  ──►  Phase 6 (test panel/endpoint), Phase 8
Phase 3  ──►  Phase 6 (test auth persist), Phase 2.1 (config chung src/config.py — phối hợp)
Phase 2  ──►  Phase 8
Phase 4  ──►  Phase 6 (test boundary)
Phase 5  ──►  Phase 6 (CI cần lockfile ổn), Phase 8
Phase 7  ──►  Phase 8
```

Song song an toàn: **P2 ∥ P4 ∥ P7** (khác vùng file). **P1 và P3** cùng đụng `llm-deep-dive-panel.tsx` + `schemas`/`routes` → làm tuần tự hoặc 1 người.
`src/config.py` bị cả P2 và P3 chạm nhẹ → gộp thay đổi config vào 1 commit đầu P2.

---

## 4. Checklist nghiệm thu (Definition of Done)

**Nghiêm trọng (bắt buộc):**
- [x] #1 signup persist — user sống sót qua restart backend
- [x] #8 latency/jitter panel đọc `WindowSummaryRow` thật, không `Math.random`
- [x] #9 deep-dive panel gọi `/deep-dive` + `/analysis/explain` (LLM thật), fallback có nhãn
- [x] #10 `app/error.tsx` + `app/loading.tsx` + `global-error.tsx` tồn tại, tắt mạng không trắng trang
- [x] #14 (hạ mức) code chết `/timeline` `/simulation` `/reports` đã dọn; bảng mapping trong `api_contract.md`
- [x] #15 `runRootCause` render trên UI; `evidence` một shape thống nhất + test contract
- [x] #16 `render.yaml` không `"*"`; production reject origin lạ
- [x] #17 4 security header có mặt (curl -I); CSP ít nhất report-only
- [x] #20 `cp .env.example .env && docker compose up` → backend healthy

**Trung bình (trong scope):**
- [x] #3 badge "phân tích mẫu" khi `model=canned-fallback`
- [x] #4/#5 không `except sqlite3.Error: pass` trần; migration log rồi re-raise lỗi lạ
- [x] #6 blacklist persist qua restart; rate limiter documented single-instance
- [x] #7 mypy `python_version = "3.11"`
- [x] #11 useEffect trong `rav-console.tsx` có cleanup
- [x] #12 hết hardcode `PLD-01`, `any` tooltip; `HZ_EXCLUDED_*` có nguồn/comment
- [x] #21 `.env.example` khớp `src/config.py`, bỏ biến rác
- [x] #22 `pip install -r requirements.txt` + `pnpm install --frozen-lockfile` deterministic
- [~] #23 scripts không hardcode path Windows / localhost  —  nói quá — scripts đã có fallback ladder + env override, không churn
- [x] #24 `routes.py` coverage ≥ 85%; 7 endpoint có test
- [x] #25 `.github/workflows/ci.yml` xanh (BE + FE)

**Thấp / documented:**
- [x] #13 placeholder assets đã xóa hoặc còn lý do
- [~] #26 badge "Mô phỏng" + README nói thật  —  DESCOPED theo chủ dự án (100% mô phỏng, không cần nhãn) — chỉ ghi chú trong data_contract.md
- [x] #2 HILT dummy có docstring "placeholder chờ kỹ sư"
- [~] #18 nginx rate-limit — làm nếu chuyển VPS, nếu không thì ghi TODO  —  HOÃN — chỉ có tác dụng khi lên VPS/nginx (đã viết sẵn config)
- [~] #19 firewall Terraform — comment rủi ro, hoãn  —  HOÃN — đã comment rủi ro trong main.tf

---

## 5. Hoãn có chủ đích (ngoài scope "cân bằng")

| Item | Lý do hoãn | Điều kiện kích hoạt |
|---|---|---|
| #19 Terraform firewall siết | Không deploy GCP trong giai đoạn này | Khi dựng hạ tầng GCP thật |
| #18 nginx rate limit | Đang ở Render (không dùng nginx) | Khi chuyển sang VPS + nginx |
| Bỏ `passlib` → `bcrypt` trực tiếp | Rủi ro thay lib auth ngay trước demo | Issue riêng sau demo |
| CI matrix đa phiên bản Python/Node | 1 phiên bản đủ cho giai đoạn này | Khi có nhiều target deploy |
| Alembic / migration tool thật | SQLite + `CREATE TABLE IF NOT EXISTS` đủ cho single-server | Khi schema đổi thường xuyên hoặc lên Postgres |
| HILT vòng lặp người thật | Không có kỹ sư thật + rosbag thật | Khi tích hợp quy trình vận hành thật |

---

## 6. Ma trận rủi ro

| Rủi ro | Khả năng | Tác động | Giảm thiểu |
|---|---|---|---|
| Diff chưa commit ẩn regression | Cao | Cao | Phase 0: e2e + `make check` trước khi build tiếp |
| CSP làm vỡ Recharts/Next inline | Trung bình | Trung bình | Report-only trước, enforce sau |
| LLM key vắng ở preview/CI → panel luôn fallback | Cao | Thấp | Test cả 2 nhánh; badge rõ; doc |
| Pin `==` lệch môi trường Render | Trung bình | Trung bình | Build thử trên Render preview trước merge |
| Thêm bảng vào `runs.db` production hiện có | Thấp | Cao | `IF NOT EXISTS` + test trên copy DB thật |
| `evidence` đổi shape phá FE đang render | Trung bình | Trung bình | Test contract BE↔FE; đổi 1 lần, grep hết consumer |

---

## 7. Ước lượng công sức

| Phase | Effort | Ưu tiên |
|---|---|---|
| 0 — Baseline | 2h | P1 |
| 1 — BE↔FE integration | 6h | P1 |
| 2 — Security | 5h | P1 |
| 3 — Backend hardening | 6h | P1/P2 |
| 4 — Frontend hardening | 3.5h | P2 |
| 5 — Config/infra nhẹ | 3h | P2 |
| 6 — Test & CI | 5h | P1 |
| 7 — Provenance labeling | 2h | P2 |
| 8 — Docs & nghiệm thu | 2h | P2 |
| **Tổng** | **~34.5h** | |

Đường tới hạn: 0 → 1 → 6 → 8 (~15h). P2/P3/P4/P5/P7 chèn song song.
Cắt giảm nếu gấp: #23 (scripts), #12 phần `HZ_EXCLUDED`, #18/#19 vốn đã hoãn.

---

## 8. Câu hỏi mở (cần chủ dự án trả lời trước/trong khi làm)

1. **LangSmith** (`LANGCHAIN_*` trong `.env.example`, "Deliverable #4"): còn dùng thật không? Nếu có → giữ + document; nếu không → xóa khỏi `.env.example` (#21).
2. **Domain thật**: Render dùng `*.onrender.com` và Vercel `*.vercel.app` — cho tôi URL chính xác để set `CORS_ORIGINS`, hay để `sync:false` và bạn tự điền trên dashboard? Nếu sắp thuê VPS+domain thì tên domain dự kiến là gì (để chuẩn bị regex/headers)?
3. **Tính năng FE `/timeline`, `/simulation`, `/reports`**: có nằm trong kịch bản demo không? Nếu không → tôi xóa hẳn khỏi UI thay vì dựng lại (#14).
4. **`AUTH_PASSWORD=test-pass` mặc định**: giữ cho demo (khớp nút "Điền demo" của FE + e2e) hay đổi mạnh + cập nhật cả FE/e2e?
5. **Coverage gate CI**: đặt `--cov-fail-under=80` toàn `src/` hay chỉ enforce `routes.py ≥ 85%`? (số hiện tại toàn repo là bao nhiêu — sẽ đo ở Phase 0).
6. **`next: 16.2.12`**: nếu version này không resolve trong registry lúc CI chạy, tôi được phép hạ về bản Next 16 hợp lệ gần nhất chứ?
7. **Có deadline Demo Day cụ thể không?** Để tôi cắt scope P2 (Phase 4/5/7) nếu thời gian gấp.
