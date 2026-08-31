# Phân tích Gap Bảo mật theo OWASP Top 10 for LLM Apps 2025

- **Branch:** `test/security-audit`
- **Ngày:** 2026-08-26
- **Nguồn đối chiếu:** [OWASP Top 10 Risk & Mitigations for LLMs and Gen AI Apps 2025](https://genai.owasp.org/llm-top-10/)

## 1. Bảng tổng hợp

| # | Rủi ro OWASP | Trạng thái dự án | Hành động |
|---|---|---|---|
| LLM01 | Prompt Injection | ✅ Suite 26 payloads (direct + smuggling + social engineering + pseudo multi-turn), guard trong cả 3 system prompts, output scan ở `/chat` | Đã cover (`prompt-injection-test-report.md`) |
| LLM02 | Sensitive Information Disclosure | ✅ **Đã vá** — trước đây chỉ `/chat` có leak scan; giờ cả explain/cluster (Python) và deep-dive (TS) đều chặn output vi phạm | Vá trong đợt này |
| LLM03 | Supply Chain | 🟡 Có Trivy/Gitleaks/CodeQL; model chưa pin version/digest; chưa có SBOM | Khuyến nghị (mục 3) |
| LLM04 | Data & Model Poisoning | ✅ **Test thêm** — file bag độc hại (SQLite giả, bảng lạ, blob lớn, topic chứa SQLi/injection text, zip chứa executable) fail gracefully, không crash, không thực thi | Test trong đợt này |
| LLM05 | Improper Output Handling | ✅ **Đã vá** — `_sanitized_content()` cho explain/cluster; `responseIsSafe()` trước `parseLLMResponse` ở frontend | Vá trong đợt này |
| LLM06 | Excessive Agency | 🟡 Latent: `chat_completion(tools=...)` hỗ trợ tool-calling nhưng chưa dùng. Nếu sau này build agent loop tự thực thi `tool_calls` từ model, prompt injection sẽ chuyển thành hành động thật | Cảnh báo thiết kế (mục 3) |
| LLM07 | System Prompt Leakage | ✅ Đã vá F1 + fragment detection trong leak_guard | Đã cover |
| LLM08 | Vector & Embedding Weaknesses | ✅ N/A — dự án không dùng RAG/vector store | Không áp dụng |
| LLM09 | Misinformation | 🟡 Có deterministic backstop (`_enforce_simultaneity`, `_gate_actuator_primary`) + HITL review queue; `confidence` từ model nhận nguyên trạng nhưng có default/clamp phía frontend | Chấp nhận được, có human review |
| LLM10 | Unbounded Consumption | ✅ **Đã vá** — `chat_completion()` giờ luôn set `max_tokens` (env `LLM_MAX_TOKENS`, default 1024); kết hợp auth bắt buộc + rate limit đã hardened | Vá trong đợt này |

## 2. Chi tiết remediation đợt này

### LLM10 — Unbounded Consumption
- `src/config.py`: setting mới `llm_max_tokens` (default 1024, clamp 1–8192)
- `src/services/llm.py`: payload OpenAI/vLLM luôn kèm `"max_tokens"` — một completion bị injection chiếm quyền không thể billing vô hạn
- Tests: mọi outbound request phải mang cap hợp lệ; env override hoạt động

### LLM02/05 — Output handling nhất quán
- Python: `_sanitized_content()` chạy `response_is_safe()` trên reply của `explain_diagnostics`/`explain_detection_cluster`; nội dung vi phạm thay bằng placeholder `[blocked]`
- Frontend: module mới `frontend/lib/server/leak-guard.ts` (mirror của `src/services/leak_guard.py`); deep-dive route scan content trước `parseLLMResponse`, vi phạm → fallback analysis an toàn
- Tests: pytest (leak bị withhold, clean pass-through) + vitest 4 cases

### LLM04 — Malicious bag files
- Suite mới `tests/test_security/test_malicious_bag_files.py`:
  - SQLite thiếu bảng `topics/messages`, bytes rác với header giả, file text thuần → `sqlite3.DatabaseError`/`OperationalError` sạch, không crash
  - Topic name chứa SQLi + instruction injection → chảy qua như data trơ
  - Blob 4 MiB parse OK (chỉ đọc `LENGTH(data)`, không load BLOB)
  - Upload `.db3` giả / zip chứa `evil.sh` → stored inert hoặc rejected, không bao giờ thực thi

## 3. Khuyến nghị còn lại (chưa làm)

1. **LLM03**: pin model version/digest khi gọi vLLM; cân nhắc SBOM cho dependencies + AI-BOM cho model artifacts.
2. **LLM06**: khi triển khai agent tool-calling, bắt buộc allowlist tools per-endpoint + xác nhận người dùng trước hành động có side-effect; re-run toàn bộ prompt-injection suite qua đường tools.
3. **LLM09**: clamp/validate `confidence` và `priority` từ model ở backend (hiện frontend tự default).
4. Body-size limit chung cho JSON inline (`/analysis/diagnose`) — hiện phụ thuộc uvicorn defaults.

## 4. Tham chiếu

- Prompt injection suite: `docs/security/prompt-injection-test-report.md`
- Backend attacks: `docs/security/backend-attack-tests.md`
- Frontend surface: `docs/security/frontend-llm-attack-surface.md`
