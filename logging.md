Logging câu trả lời của người dùng (HITL Approve/Reject) — lưu trữ thế nào
1. Cần log những gì

Đây là dữ liệu feedback loop — giá trị lớn nhất của nó không phải để "xem cho biết" mà để sau này đánh giá và cải 
thiện agent. Cấu trúc tối thiểu nên có:

json
{
  "review_id": "uuid",
  "run_id": "uuid-của-lần-phân tích",
  "anomaly_id": "id-của-detection-cụ-thể",
  "ai_conclusion": { "type": "...", "root_cause": "...", "severity": "..." },
  "reviewer_action": "approved | rejected | edited",
  "reviewer_note": "text tự do, VD: 'đúng nhưng root cause nên là X thay vì Y'",
  "reviewed_by": "tên/id người review",
  "reviewed_at": "2026-08-01T10:32:00Z"
}

Vì sao cần đủ 5 trường này: ai_conclusion snapshot lại đúng thứ AI đã nói tại thời điểm đó (để sau này so sánh dù 
model có đổi), reviewer_action là nhãn nhị phân dễ tính Precision/Recall, reviewer_note là phần định tính giúp hiểu 
tại sao sai (quan trọng hơn nhiều so với chỉ biết "sai").

2. Lưu ở đâu
Lựa chọn	Khi nào dùng
Bảng riêng trong SQLite/Postgres (VD: reviews)	Khuyến nghị cho MVP — đơn giản, join được với bảng runs/anomalies, dễ query để tính metric
File JSON append-only	Chỉ nên dùng nếu chưa muốn setup DB, nhưng khó query/tính toán sau này — không khuyến nghị nếu đã có FastAPI + DB sẵn trong kiến trúc

Vì kiến trúc đã có sẵn FastAPI + endpoint POST /api/feedback — chỉ cần thêm 1 bảng reviews là đủ, không cần công cụ mới.

sql
CREATE TABLE reviews (
    id UUID PRIMARY KEY,
    run_id UUID REFERENCES runs(id),
    anomaly_id UUID,
    ai_conclusion JSONB,
    reviewer_action TEXT CHECK (reviewer_action IN ('approved','rejected','edited')),
    reviewer_note TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMP DEFAULT now()
);
3. Có nên hiển thị lên UI không?

Có — và nên hiển thị ở 2 nơi khác nhau, phục vụ 2 mục đích khác nhau:

a) Ngay tại trang Human Review (real-time, khi đang duyệt)

Sau khi bấm Approve/Reject, hiển thị ngay trạng thái đã lưu (VD: badge "Đã duyệt lúc 10:32 bởi Minh") — để người dùng biết hành động của mình đã ghi nhận, tránh bấm nhầm 2 lần
Đây là UX cơ bản, gần như bắt buộc, không tốn nhiều effort

b) Trang tổng hợp riêng — "Lịch sử Review" hoặc gộp vào Reports

Hiển thị dạng bảng: run nào, bao nhiêu anomaly đã duyệt/từ chối, tỷ lệ AI đúng theo đánh giá con người
Đây chính là nguồn dữ liệu để tính Precision/Recall — metric mà đề tài RAV-13 yêu cầu đo lường 
Vì sao nên ưu tiên hiển thị — không chỉ log ngầm

Đối chiếu lại ràng buộc gốc của đề tài: "agent chỉ chẩn đoán và gợi ý, kỹ sư quyết định và duyệt hành động khắc phục (human-in-the-loop)... hiệu quả đo được" — nghĩa là:

HITL không chỉ là bước "duyệt cho có" — nó phải tạo ra dữ liệu đo lường được để chứng minh giá trị sản phẩm. Nếu chỉ lưu ngầm mà không có nơi tổng hợp hiển thị, bạn sẽ khó có con số cụ thể để đưa vào phần demo/báo cáo tuần 5 ("agent đúng 85% theo đánh giá kỹ sư")
Đây chính là "wow moment" thứ 2 bên cạnh phần AI chẩn đoán — cho mentor thấy 1 dashboard nhỏ kiểu "Agent Accuracy: 82% (18 reviewed, 15 approved)" tạo ấn tượng mạnh hơn nhiều so với chỉ nói miệng "em đo được X%"
Đề xuất mức độ ưu tiên cho MVP 2 tuần
Việc	Ưu tiên	Effort
Log vào bảng reviews khi bấm Approve/Reject	Bắt buộc	Thấp — chỉ 1 endpoint + 1 bảng
Hiển thị trạng thái ngay tại Human Review sau khi bấm	Bắt buộc	Rất thấp
Trang tổng hợp tỷ lệ Approve/Reject (đơn giản: vài con số + 1 bảng)	Nên có, không cần đẹp	Thấp-trung bình — tận dụng luôn phần "Reports" đang trống trong UI hiện tại thay vì để nó là "audit ledger" phức tạp như thiết kế ban đầu
Biểu đồ xu hướng theo thời gian (accuracy cải thiện qua các lần review)	Để dành Nâng cao	—

Gợi ý cụ thể: dùng chính trang Reports đã có sẵn trong UI (hiện đang là khung trống "No reports yet") để làm nơi hiển thị bảng tổng hợp này — vừa tận dụng cấu trúc UI đã thiết kế, vừa biến 1 trang trước đây được đánh giá là "không cần thiết cho MVP" (audit ledger phức tạp) thành 1 trang thực sự cần thiết (bảng đo lường Precision/Recall) chỉ với nội dung đơn giản hơn nhiều so với thiết kế ban đầu.

thế còn câu trả lời của chatbot thì có nên lưu trữ lại và hiển thị lên UI không?

Câu trả lời của "chatbot" (LLM) 

1. Có nên lưu không — chắc chắn có, và đây là 2 lý do bắt buộc

a) Không lưu = không có gì để hiển thị lại
Nếu không lưu kết quả LLM trả về vào DB, mỗi lần người dùng mở lại 1 run cũ, bạn sẽ phải gọi lại LLM lần nữa — vừa tốn tiền/tài nguyên, vừa có rủi ro kết quả không nhất quán (LLM có thể trả lời khác đi giữa 2 lần gọi cùng input, đặc biệt nếu temperature > 0)

b) Đây chính là input cho bảng Review đã bàn ở câu trước
Nhớ lại cấu trúc reviews table đã đề xuất — trường ai_conclusion (snapshot lại kết luận AI) phải lấy từ đâu đó — chính là kết quả LLM đã lưu này. Nếu không có bảng lưu kết quả LLM riêng, bạn không có gì để snapshot vào review.

2. Lưu ở đâu — thêm 1 bảng riêng, tách biệt với review
sql
CREATE TABLE diagnoses (
    id UUID PRIMARY KEY,
    run_id UUID REFERENCES runs(id),
    anomaly_type TEXT,           -- "timestamp_drift", "node_crash"...
    topic TEXT,
    timestamp_in_bag TIMESTAMP,
    root_cause TEXT,             -- giải thích của LLM
    recommendation TEXT,         -- đề xuất khắc phục
    severity TEXT,               -- "critical"/"high"/"medium"/"low"
    raw_llm_output JSONB,        -- lưu nguyên JSON gốc, phòng khi cần debug
    model_name TEXT,             -- "gpt-oss-20b" — quan trọng nếu sau đổi model
    created_at TIMESTAMP DEFAULT now()
);

Vì sao tách bảng diagnoses riêng khỏi reviews:

Bảng	Vai trò	Ghi khi nào
diagnoses	Kết quả AI trả về (chưa qua duyệt)	Ngay sau khi gọi LLM xong
reviews	Quyết định của con người về kết quả đó	Sau khi kỹ sư bấm Approve/Reject

Tách riêng giúp bạn dễ trả lời câu hỏi "AI đã chẩn đoán bao nhiêu case, trong đó bao nhiêu case đã có người xem" — tức là phân biệt được "đã sinh ra" và "đã được duyệt", đúng với luồng nghiệp vụ HITL thực tế.

Về raw_llm_output: nên lưu luôn cả JSON thô mà model trả về (không chỉ các trường đã tách), vì nếu sau này phát hiện lỗi parse hay muốn debug prompt, bạn có bằng chứng gốc để xem lại — chi phí lưu thêm 1 cột JSONB gần như bằng 0.

3. Có nên hiển thị lên UI không — chắc chắn có, đây là màn hình quan trọng nhất

Đối chiếu lại đúng workflow đã thống nhất: Analysis workspace (ó phần "Select a detection to inspect the agent conclusion") chính là nơi hiển thị kết quả này. Đây không phải tính năng phụ — đây là lý do tồn tại của cả sản phẩm.

Cách hiển thị đề xuất, theo đúng cấu trúc đã có sẵn trong UI:

Timeline (trục thời gian, đánh dấu các điểm bất thường)
       ↓ click vào 1 điểm
Panel bên phải hiện ra:
  - Loại lỗi: Timestamp Drift
  - Topic: /imu/data
  - Thời điểm: 0:42.800
  - Mức độ: HIGH
  - Giải thích (root cause): "..." (text từ LLM)
  - Đề xuất khắc phục: "..." (text từ LLM)
  - [Nút Approve] [Nút Reject]

Đây chính xác là luồng đã thấy trong ảnh "Analysis workspace" — chỉ là hiện tại nó đang trống ("Select a detection to inspect the agent conclusion") vì chưa nối dữ liệu thật.

4. Có nên hiển thị "raw JSON" hay chỉ hiển thị bản đã format đẹp?
Đối tượng xem	Nên hiển thị gì
Kỹ sư đang duyệt (Human Review)	Chỉ hiển thị bản đã format đẹp (root cause + recommendation dạng câu văn, không phải JSON thô) — đúng tinh thần UX bình thường
Bạn/đội dev lúc debug	Có thể thêm 1 nút nhỏ "View raw output" (dev mode) để xem JSON gốc khi cần kiểm tra model có trả đúng schema không
Không nên bắt kỹ sư đọc JSON thô trong lúc review — điều này đi ngược lại chính giá trị cốt lõi đề tài hướng tới ("giải thích bằng ngôn ngữ tự nhiên dễ hiểu" thay vì chỉ báo lỗi kỹ thuật khô khan).

Tổng hợp — cập nhật kiến trúc dữ liệu MVP
[vLLM trả JSON] 
      ↓
Lưu vào bảng `diagnoses`
      ↓
Hiển thị tại Analysis workspace (timeline + panel giải thích)
      ↓
Kỹ sư bấm Approve/Reject
      ↓
Lưu vào bảng `reviews` (snapshot lại ai_conclusion từ diagnoses)
      ↓
Hiển thị tổng hợp tại Reports (tính Precision/Recall)

Đây là 2 bảng đơn giản, 2 màn hình chính (Analysis + Reports) — không tốn thêm effort đáng kể so với kế hoạch đã có, nhưng đảm bảo đủ dữ liệu để đo lường được hiệu quả agent, đúng yêu cầu cốt lõi của đề tài.
