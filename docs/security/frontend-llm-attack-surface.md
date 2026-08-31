# Báo cáo Attack Surface LLM từ phía Frontend

- **Branch:** `test/security-audit`
- **Ngày:** 2026-08-26
- **Phạm vi:** Các endpoint LLM mà frontend (Next.js) thực tế gọi, đối chiếu với bộ test prompt injection tại `docs/security/prompt-injection-test-report.md`

## 1. Kết luận nhanh

Frontend hiện **không có khung chat** và **không gọi `POST /api/v1/chat`** ở bất kỳ đâu. Direct prompt injection từ phía người dùng UI hiện không khả thi — attack surface LLM thật của UI chỉ còn **một đường gián tiếp duy nhất qua route deep-dive**, và ngay cả đường đó cũng chưa được wire vào component.

## 2. Phân tích từng đường

### 2.1. `/api/v1/chat` — frontend KHÔNG gọi

- Bảng mapping route trong `frontend/lib/api.ts:3-35` (`resolveApiUrl`) không có entry nào cho `chat`.
- Grep toàn bộ `frontend/components/` và `frontend/app/` không thấy fetch nào tới endpoint này.
- Endpoint vẫn tồn tại công khai trên FastAPI (`src/api/routes.py`), nên attacker **vẫn tấn công được bằng cách gọi HTTP trực tiếp** (curl/httpx/Postman) mà không cần UI — đúng như live runner `scripts/test_security_injection.py` đang làm.
- Đã vá: response được sanitize bởi `src/services/leak_guard.py` (xem F2 trong báo cáo prompt injection).

### 2.2. `GET /api/runs/{runId}/deep-dive` — đường duy nhất UI chạm được

- Route Next.js `frontend/app/api/runs/[runId]/deep-dive/route.ts:245` tự gọi thẳng `${VLLM_API_URL}/v1/chat/completions`.
- Prompt được build hoàn toàn từ dữ liệu anomalies/health của run (`route.ts:13-58`), kèm safety notice cuối prompt.
- Panel `llm-deep-dive-panel.tsx` auto-trigger khi health score tụt dưới ngưỡng.

**Điểm đáng chú ý:** tại `llm-deep-dive-panel.tsx:197-198`, hàm `triggerDeepDive()` hiện chỉ dùng fallback cục bộ (`generateFallbackAnalysis`) mà **không fetch endpoint deep-dive**. Nghĩa là:

- Người dùng UI hiện không bao giờ nhìn thấy output LLM thật của route này.
- Khi có ai đó wire panel vào endpoint thật, attack surface sẽ bật lên — cần xử lý an toàn ngay từ lúc wire.

### 2.3. `/api/v1/analysis/explain` — map sẵn nhưng không dùng

- `api.ts:16` có mapping sang backend, nhưng không có component nào gọi nó (chỉ test tham chiếu).
- Backend endpoint này nhận JSON diagnostic do caller cung cấp — đây là vector instruction smuggling (payload PI14), nhưng hiện chỉ khai thác được qua API trực tiếp, không qua UI.

## 3. Bảng tổng hợp

| Đường | UI có gọi? | Vector injection | Trạng thái phòng thủ |
|---|---|---|---|
| `/api/v1/chat` | ❌ Không | Direct (chỉ qua HTTP trực tiếp) | ✅ Đã sanitize (F2) + guard trong system prompt (F1) |
| `/api/runs/{id}/deep-dive` | ⚠️ Có route nhưng panel dùng fallback, chưa fetch | Indirect qua dữ liệu anomaly | ⚠️ Chỉ có safety notice trong prompt; chưa scan output |
| `/api/v1/analysis/explain` | ❌ Map sẵn, chưa dùng | Indirect qua JSON diagnostic | ✅ Có injection guard trong system prompt |

## 4. Khuyến nghị

1. **Khi wire `LLMDeepDivePanel` vào endpoint deep-dive thật:**
   - Áp dụng cơ chế tương tự `leak_guard` cho output vLLM trước khi hiển thị (route Next.js chạy Node nên cần port logic scan sang TS hoặc lọc ở backend trước khi trả về).
   - Giữ nguyên fallback khi LLM lỗi/từ chối — panel đã có sẵn behavior này.
2. **Khi dữ liệu anomaly chuyển từ mock store sang rosbag/log upload-thật:** sanitize hoặc escape dữ liệu trước khi build prompt deep-dive — đây là lúc indirect injection trở thành khả năng thực tế.
3. **Endpoint không dùng nên siết lại:** cân nhắc bỏ mapping `analysis/explain` khỏi `resolveApiUrl` cho đến khi UI thật sự dùng, để giảm diện tích bề mặt. *(Đã áp dụng một phần: cả 3 endpoint LLM giờ bắt buộc auth qua `_require_llm_auth` — fail-closed 503 trong production nếu chưa cấu hình `API_AUTH_TOKEN`, xem `src/api/routes.py`.)*
4. Bổ sung case deep-dive vào suite live (`scripts/test_security_injection.py`) một khi panel được wire — hiện probe đã kiểm tra containment (không leak secret) nhưng chưa có payload injection qua dữ liệu anomaly.

## 5. Tham chiếu

- Báo cáo chính: `docs/security/prompt-injection-test-report.md`
- Suite test: `tests/test_services/test_llm_security.py`, `scripts/test_security_injection.py`
- Guard production: `src/services/leak_guard.py`
