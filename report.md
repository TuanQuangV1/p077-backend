Báo cáo tổng quan: Phát hiện lỗi định vị (localization) trong RAV-13
1. Vấn đề: "Robot vẫn nói nó ổn, nhưng nó không biết mình đang ở đâu"
Hệ thống RAV-13 phân tích rosbag của robot (TurtleBot3 + Nav2) để tìm xem robot hỏng chỗ nào.

Lỗi thông thường (mất tín hiệu, topic chết, giảm tần số...) — nhìn vào tần số publish là phát hiện được.
Lỗi định vị (localization failure) thì khó hơn: robot vẫn publish /amcl_pose đều đặn, nhưng vị trí nó báo cáo là sai. 
Kiểu như một nhân viên đi làm đúng giờ mỗi ngày, nhưng đi nhầm tòa nhà.
Hậu quả: robot "tin" mình ở vị trí A trong khi thực tế ở B → lao vào tường, mất phương hướng, hoặc tệ hơn là vẫn báo 
cáo "khỏe mạnh" cho hệ thống giám sát. 

Đây là lỗi mà các detector truyền thống chỉ nhìn timing không thể bắt được.

Các dạng lỗi định vị được phân loại:

Loại lỗi	Ví dụ dân dã	Mức độ
local_drift	Vị trí sai dần từng chút, kiểu la bàn trôi	Nhẹ, cục bộ
sudden_jump	Robot bị "dịch chuyển tức thời" (kidnap/teleport)	Nặng, toàn cục
tight_confident_wrong	Robot tự tin 100% nhưng ở chỗ sai (particle hội tụ nhầm)	Nặng, toàn cục
multi_hypothesis	Robot phân vân "mình ở đây hay đằng kia?" (nhiều giả thuyết)	Nặng, toàn cục
Điểm nguy hiểm nhất: lỗi này không phá vỡ tần số publish → Health Score tính từ timing vẫn ≥ 70/100 → hệ thống báo "OK".

2. Bộ dữ liệu: 417.185 mẫu từ 21 recording robot thật
Để dạy AI nhận diện lỗi định vị, chúng tôi thu 21 recording thật trên robot mô phỏng (ROS 2 Jazzy + Gazebo + Nav2/AMCL):

417.185 frame dữ liệu: ~77% khỏe mạnh + ~23% lỗi định vị
3 kiểu môi trường: kho hàng (warehouse), môi trường đối xứng, môi trường bất đối xứng — để AI học được "sai lệch hình 
dạng bản đồ"
Biến thiên: có/không vật cản động, 4–16 lần cố tình làm mất định vị (reset) mỗi recording
Nhãn ground truth: từ topic /delocalizations trong bag — frame nào robot bị mất định vị = label "lỗi"
Chia train/val/test theo recording (không trộn frame của cùng 1 recording vào 2 tập) — đảm bảo đánh giá công bằng, 
không "học lỏm"
5 nguồn dữ liệu mỗi frame: scan LiDAR, particle cloud (đám hạt của AMCL), pose ước lượng, pose tham chiếu, bản đồ occupancy
Ngoài ra còn một dataset riêng (49 rosbag, 57 lần tiêm lỗi, 14 loại lỗi) dùng để kiểm chứng các luật phát hiện truyền 
thống — 2 dataset bổ trợ cho nhau.

3. Hướng tiếp cận: "Bác sĩ 3 tầng, tầng nào cũng có dự phòng"
Hệ thống dùng 3 tầng phát hiện bổ trợ nhau, không tầng nào thay thế tầng nào:

Tầng 1 — Detector truyền thống (timing-based)
16 luật quy tắc: topic chết, giảm tần số, node im lặng, TF lệch...
Tổng hợp thành Health Score 0–100 → nếu < 70, hệ thống chạy deep-dive.
Giới hạn: không nhìn thấy lỗi định vị.
Tầng 2 — CNN (AI nhìn ảnh) — "đôi mắt thứ hai"
Khi cần deep-dive, hệ thống:

Chuyển bag → parquet (5 topic bắt buộc; thiếu topic thì bỏ qua tầng này một cách lịch sự, không crash)
Chọn cửa sổ thời gian cần soi: nếu có detection → soi đúng khoảng lỗi; nếu robot "sạch" → quét toàn bộ recording theo chunk 60s kèm prefilter rẻ (vị trí lệch < 0.3m thì bỏ qua, không tốn AI) — lỗi giữa chừng không bị sót
Vẽ mỗi frame thành 1 bức ảnh 3 kênh màu: kênh 1 = bản đồ, kênh 2 = tia LiDAR, kênh 3 = đám hạt AMCL — giống như cho AI "xem" robot đang định vị ở đâu
CNN phán xét: "bức ảnh này trông khỏe mạnh hay đang sai?"
Kết quả là bằng chứng định vị (localization_evidence) đính kèm vào prompt gửi LLM: loại lỗi, mức độ lệch (mét), xu hướng sai số, độ phân tán particle, mức khớp giữa scan và bản đồ.

Điểm mấu chốt: nếu CNN nói "có lỗi" → hệ thống ép buộc kích hoạt deep-dive dù Health Score vẫn cao. Đây là mắt xích lấp đúng khoảng trống của Tầng 1.

Tầng 3 — LLM giải thích
LLM nhận health + detections + bằng chứng CNN, giải thích tại sao robot hỏng và đưa kế hoạch sửa cho kỹ sư mới vào nghề (kiểm tra gì → sửa gì).

Nguyên tắc vàng: graceful-degrade
Thiếu model, thiếu topic, bag hỏng, cửa sổ trống... → tầng CNN bị bỏ qua, hệ thống vẫn trả kết quả bình thường, không bao giờ lỗi 500. AI là bổ trợ, không bao giờ là vật cản.

4. Kết quả & độ tin cậy
301 test tự động pass, coverage 88.16% (yêu cầu ≥ 75%)
Converter trên bag thật: chuyển đổi thành công, schema khớp reference
Mọi đường degrade đều được test riêng (12 test health + 61 test API)
Tóm tắt một câu cho mentor: Chúng tôi giải quyết bài toán "lỗi vô hình" bằng cách kết hợp detector timing (biết khi nào)
 + CNN đọc ảnh 3 kênh map/scan/particle (biết robot có định vị sai không) + LLM (giải thích tại sao), trên bộ dữ liệu 417k frame từ 21 recording thật, với thiết kế graceful-degrade đảm bảo AI không bao giờ làm hỏng luồng chính.