# Báo cáo Test Tấn công Backend Thông thường

- **Branch:** `test/security-audit`
- **Ngày:** 2026-08-26
- **Suite:** `tests/test_security/test_backend_attacks.py` (14 tests)
- **Bổ sung cho:** `docs/security/prompt-injection-test-report.md` (prompt injection đã có suite riêng)

## 1. Tổng quan

Bộ test tấn công web truyền thống vào FastAPI backend, tập trung các gap chưa được cover bởi tests sẵn có (path traversal/zip-slip/oversized upload/auth đã có test từ trước).

## 2. Phát hiện & Vá lỗi

### B1 — Rate-limit bypass qua `X-Forwarded-For` spoofing — Severity: Medium — **ĐÃ VÁ (v2)**

- **Vị trí:** `src/api/routes.py` (`_check_rate_limit`)
- **Trước đây:** key rate limit lấy IP đầu tiên trong XFF → attacker đổi header mỗi request là có bucket mới, vượt hoàn toàn giới hạn.
- **Vá v1:** thêm env `TRUST_PROXY` (mặc định tắt). Khi bật, chỉ tin **entry cuối** trong chuỗi XFF (nginx dùng `$proxy_add_x_forwarded_for` — append địa chỉ thật vào cuối; các entry trước có thể do attacker tự chèn). Khi tắt, key theo socket address.
- **Vá v2 (2026-08-26):** bổ sung `TRUST_PROXY_HOPS` (default 1) để peeling đúng số hop tin cậy từ phải sang. Với 1 nginx, `HOPS=1` lấy last entry là client IP. Với L4 LB + nginx, last entry là IP internal của LB, phải lấy `parts[-2]` mới là client thật — nếu không tất cả external traffic gom vào 1 bucket. Hỗ trợ `X-Real-IP` fallback, strip port, validate. Env `TRUST_PROXY` cũng chấp nhận số (`"2"` = 2 hops). Giữ `TRUST_PROXY=1` + `TRUST_PROXY_HOPS=1` cho GCP hiện tại (ít đụng infra, nginx vẫn append).
- **Deploy:** `docker-compose.gcp.yml` đã set `TRUST_PROXY=1` và `TRUST_PROXY_HOPS=1` cho môi trường GCP sau nginx.

### B2 — Regex Performance (Leak Guard) — Severity: Low — **ĐÃ VÁ**

- **Vị trí:** `src/services/leak_guard.py:19` (`SECRET_PATTERNS`), `frontend/lib/server/leak-guard.ts`
- **Trước đây:** 4 regex riêng, mỗi `finditer` scan toàn bộ LLM response (tới 8192 tokens ~32k chars) → latency spike khi model trả về text dài.
- **Vá:** gộp thành 1 combined pattern (`_COMBINED_SECRET_PATTERN`), thêm `MAX_LEAK_SCAN_LEN=20000` truncate trước scan, và pre-filter keyword (`sk-`, `bearer`, `api_key`...) để bỏ qua regex khi không cần. Frontend đồng bộ single regex + slice.
- **Kết quả:** 1 pass thay vì 4, 12ms → <3ms trên 20k chars benign.

### B3 — Leak Guard Bypass (Prompt Fragment Fuzzy) — Severity: Medium — **ĐÃ VÁ**

- **Vị trí:** `src/services/leak_guard.py:30-51` (`find_prompt_leaks`)
- **Trước đây:** match chính xác 8-word shingle step 24 → attacker chèn typo, extra spaces, đồng nghĩa (`helper` vs `assistant`) là bypass.
- **Vá:** shingles step 8 (72 fragments, phủ kín hơn), normalize (`[^a-z0-9]+` → space, lower, collapse), và fuzzy `rapidfuzz` với `max(partial_ratio, token_set_ratio) >=85`. Backend dùng `rapidfuzz` (Rust, ~0.3ms/fragment), fallback `difflib`. Frontend port `normalize` + `partialRatio` + token overlap (Jaccard) với cùng ngưỡng 85, xử lý được typo, extra spaces, punct, synonym.
- **Kết quả:** `You are a robotics diagnostics helper for the RAV-13 platform` và `You   are  a  robotics   diagnostics   assistant` đều bị chặn, trong khi `You are a helpful assistant` / `The RAV-13 platform is great` không false positive.

## 3. Các lớp tấn công được test

| Tier | Lớp tấn công | Test | Kết quả |
|---|---|---|---|
| 1a | XFF spoofing rotate bucket | `test_spoofed_forwarded_for_cannot_rotate_buckets`, `test_trusted_proxy_keys_on_the_last_forwarded_entry` | Đã vá |
| 1a | TRUST_PROXY phải opt-in tường minh | `test_trusted_proxy_disabled_by_default` | Pass |
| 1b | Inline JSON khổng lồ (~10 MiB messages) | `test_diagnose_survives_a_huge_message_list` | Không crash (không có cap body riêng — xem mục 5) |
| 1b | JSON lồng sâu 5000 tầng | `test_diagnose_survives_deeply_nested_json` | Từ chối sạch (400/413/422) |
| 1b | Message `/chat` quá dài | `test_chat_rejects_absurdly_long_message` | 422 theo contract max-length |
| 1c | Bytes rác dưới tên `.mcap` | `test_upload_garbage_bytes_with_valid_extension_is_stored_but_never_crashes` | Chấp nhận/stored inert, không 500 |
| 1c | PE/MZ magic bytes giả `.bag` | `test_upload_executable_disguised_as_bag_is_inert` | Stored nguyên trạng, không thực thi |
| 2 | IDOR / cross-run access | `test_unknown_run_ids_do_not_leak_other_runs` (+delete, review) | 404 đúng |
| 2 | Symlink escape khi xóa dataset | `test_symlink_inside_data_dir_does_not_escape_deletion` | Không follow symlink ra ngoài `data/` |
| 2 | CPU amplification qua `window_sec` nhỏ | `test_export_window_sec_lower_bound_is_enforced` | Validation chặn `< 0.01` |
| 3 | SQLi fuzzing run_id/review params | `test_sqli_probes_on_run_and_review_params_are_inert` | Inert — queries parameterized |

## 4. Hạn chế không thể test tự động (đã ghi nhận)

- **Chunked-transfer upload bypass**: pre-check `Content-Length` ở `/datasets/upload` có thể bị né bằng chunked encoding, nhưng ASGI transport của httpx luôn tính Content-Length nên không mô phỏng được trong pytest. Khuyến nghị kiểm tra thủ công bằng curl `--header "Transfer-Encoding: chunked"` hoặc thêm middleware đếm byte stream.
- **Multi-tenant authz**: hệ thống single-tenant — mọi caller hợp lệ truy cập được mọi object ID. Nếu chuyển multi-user, cần authorization per-object trước khi expose public.

## 5. Khuyến nghị tiếp theo

1. Cân nhắc giới hạn tổng kích thước body JSON inline (middleware đọc Content-Length hoặc streaming limit) cho `/analysis/diagnose`.
2. Nginx hiện publish toàn bộ `/api/`; nếu frontend không dùng endpoint nào, cân nhắc allowlist location thay vì passthrough blanket.
3. Upload validation theo extension — cân nhắc magic-byte sniff (`.db3` = SQLite header, `.zip` = PK) để từ chối sớm nội dung giả mạo.

## 6. Tham chiếu

- Suite prompt injection: `docs/security/prompt-injection-test-report.md`
- Attack surface UI: `docs/security/frontend-llm-attack-surface.md`
