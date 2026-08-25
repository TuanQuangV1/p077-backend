# Báo Cáo Tóm Tắt: Nâng Cấp & Làm Cứng Rosbag Parser (RAV-13)

**Nhánh:** `feature/rosbag-parser-production-hardening` | **Trạng thái:** Hoàn thành (250/250 tests passed)

---

## 1. Tại Sao Phải Làm Việc Này? (Mục Đích)
- **Chuẩn hóa kiến trúc:** Tách bạch lớp đọc dữ liệu (Parser - Layer 1) với lớp phân tích (Detection Engine - Layer 2) theo nguyên lý thiết kế mở rộng (Open-Closed Principle).
- **Tránh lỗi sập hệ thống (Crash/OOM):** Khi đọc các file rosbag dung lượng lớn (hàng chục GB) hoặc dữ liệu bị hỏng/lỗi format, parser cũ dễ gây tràn bộ nhớ RAM hoặc bắn lỗi chung chung không rõ nguyên nhân.
- **Đảm bảo độ tin cậy khi chạy thật:** Tăng tốc độ đọc, bắt lỗi chính xác và tự động xử lý an toàn mọi dạng payload bất thường.

---

## 2. Lúc Đầu Như Thế Nào? (Hiện Trạng Ban Đầu)

| Yếu tố | Trạng thái ban đầu (Cũ) | Vấn đề tồn tại |
| :--- | :--- | :--- |
| **Cấu trúc code** | Toàn bộ dồn chung trong `bag_stream.py` | Khó mở rộng thêm định dạng mới, vi phạm SRP. |
| **Quản lý lỗi** | Dùng ngoại lệ chung `RuntimeError` hoặc lỗi raw của `sqlite3` | Khó debug, API/UI không biết chính xác lỗi ở đâu (hỏng file, sai format hay hỏng schema). |
| **Bộ nhớ (RAM)** | Truy vấn SQLite nạp mảng lớn | Nguy cơ tràn RAM khi gặp file ghi dài. |
| **An toàn dữ liệu** | Chưa chặn kiểm tra độ dài chuỗi/mảng bất thường | Dễ bị treo CPU (vòng lặp vô hạn) nếu file nhị phân bị hỏng byte. |
| **Kiểm thử** | Chỉ có test mẫu cơ bản | Chưa có kiểm thử Fuzzing (dữ liệu ngẫu nhiên) và test ngưỡng hiệu năng. |

---

## 3. Sau Khi Chỉnh Sửa Thì Ra Sao? (Kết Quả Cải Tiến)

### 3.1. Tách lớp trừu tượng `BaseBagReader` (Gói `src/services/bag_readers/`)
- Tạo chuẩn chung `BaseBagReader` với 3 hàm bắt buộc:
  1. `get_metadata()`: Lấy thông tin thời lượng, số lượng tin nhắn, kích thước ($O(1)$).
  2. `get_topics()`: Lấy danh sách topic và kiểu dữ liệu.
  3. `stream_messages()`: Stream dữ liệu tuần tự theo thời gian.
- Chia thành 2 Reader độc lập:
  - **`DB3Reader`**: Chuyên xử lý định dạng SQLite (`.db3`).
  - **`MCAPReader`**: Chuyên xử lý định dạng `.mcap` thông qua thống kê chỉ mục nhanh.
- Hàm Factory **`get_bag_reader(path)`**: Tự động nhận diện file đơn hoặc thư mục để cấp đúng Reader tương ứng.

### 3.2. Hệ thống bắt lỗi chuyên biệt (`src/services/exceptions.py`)
- Phân loại lỗi rõ ràng, mang kèm thông tin chi tiết (`file_path`, `topic`, `position`):
  - `CorruptedBagError`: File bị hỏng, mất header hoặc mất bảng dữ liệu.
  - `UnsupportedFormatError`: Định dạng không hỗ trợ (ví dụ file ROS 1 `.bag`).
  - `DecodeError` & `SchemaMismatchError`: Lỗi giải mã CDR hoặc sai lệch schema.
- Kế thừa từ `RuntimeError` giúp **100% tương thích ngược** với các tầng code hiện có.

### 3.3. Tối ưu bộ nhớ & Chốt an toàn Fast-Path
- Bộ nhớ cố định **$O(1)$** trong suốt quá trình đọc dữ liệu.
- Thêm kiểm tra giới hạn mảng nhị phân (`bounds checking`), triệt tiêu hoàn toàn nguy cơ lặp vô hạn khi gặp file lỗi.

---

## 4. Bảng So Sánh Trước & Sau

```
[TRƯỚC ĐÂY]
File Bag (.db3 / .mcap) ──> bag_stream.py (Đơn khối, if/else thủ công, lỗi chung) ──> Detection Engine

[HIỆN TẠI]
File Bag ──> Factory: get_bag_reader()
                 ├── DB3Reader   ───┐
                 └── MCAPReader  ───┼──> Stream chuẩn hóa (Không đổi) ──> Detection Engine
                                    │
                  Domain Exceptions ┘ (Báo lỗi chính xác vị trí/nguyên nhân)
```

---

## 5. Minh Chứng Số Liệu & Kiểm Thử

- **Kết quả kiểm thử:** **250 / 250 test cases thành công 100%**.
- **Độ bao phủ code (Coverage):** **88.64%** toàn dự án ($>90\%$ trên các module parser).
- **Tốc độ giải mã nhanh (Fast-path throughput):** Đạt **$> 50.000\text{ messages/giây}$**.
- **Fuzz Testing (Hypothesis):** Thử nghiệm hàng trăm kịch bản byte ngẫu nhiên/cắt cụt $\rightarrow$ **0 lỗi crash**.
- **Tính tương thích:** Tầng 2 (Detection Engine - 14 quy tắc chẩn đoán) hoạt động nguyên vẹn, không cần sửa một dòng code nào.
