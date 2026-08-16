# 🔍 Báo Cáo Phân Tích Lỗi Azure Portal 401 Unauthorized (Access Denied Report)

Báo cáo này xác định chính xác nguyên nhân kỹ thuật gây ra lỗi `401 You do not have access` khi truy cập **Microsoft Entra ID (App Registrations)** trên Azure Portal đối với tài khoản `26ai.quangmt@vinuni.edu.vn`, đồng thời cung cấp phương án giải quyết dứt điểm.

---

## 📌 1. NGUYÊN NHÂN KỸ THUẬT GÂY LỖI 401

- **Tài khoản**: `26ai.quangmt@vinuni.edu.vn` (MAI TUAN QUANG - VinUni)
- **Subscription**: `Azure subscription 1` (`bea3db28-8916-4dc6-928c-8fcd12742c3a`)
- **Tenant ID**: `58f82789-6695-4f4a-abdb-357668d55cff` (`VINACADEMY LLC` / `vinuni.edu.vn`)

### Tại sao bị lỗi 401 Unauthorized?
1. **Phân biệt 2 cấp độ phân quyền trong Azure**:
   - **Azure Subscription RBAC**: Bạn có vai trò **`Owner`** trên Subscription (Quyền quản lý hạ tầng Azure cao nhất: Tạo Resource Group, Container Apps, Storage, ACR). Lớp này hoạt động 100% hoàn hảo.
   - **Microsoft Entra ID (Azure AD) Directory Policy**: Quản lý thư mục tổ chức `vinuni.edu.vn`. Quản trị viên IT trường VinUni đã kích hoạt chính sách bảo mật:
     - *"Restrict access to Microsoft Entra admin center = YES"*
     - *"Users can register applications = NO"*
2. **Cơ chế gây lỗi**: Khi bạn truy cập **App Registrations** trên Azure Portal, trình duyệt gọi Microsoft Graph API (`graph.microsoft.com`). Do chính sách Entra ID của VinUni chặn người dùng phổ thông truy cập Directory Admin portal, API lập tức trả về lỗi HTTP Status `401 Unauthorized`.

---

## 📋 2. QUYỀN HIỆN TẠI VÀ QUYỀN CÒN THIẾU

### Quyền Hiện Có (Đã Đủ Để Deploy Hạ Tầng):
- **Role**: `Owner` trên `/subscriptions/bea3db28-8916-4dc6-928c-8fcd12742c3a`.

### Quyền Còn Thiếu Trong Entra ID (Để Tự Tạo App Registration/Service Principal):
- Vai trò Directory Entra ID: `Application Administrator`, `Cloud Application Administrator`, hoặc `Application Developer`.

---

## 🛠️ 3. SO SÁNH 3 PHƯƠNG ÁN XỬ LÝ

| Phương Án | Mô Tả | Ưu Điểm | Nhược Điểm | Khả Năng CI/CD |
|---|---|---|---|---|
| **Phương Án A**: Gửi Request Xin IT VinUni Cấp Quyền | Nhờ IT Support VinUni cấp vai trò `Application Developer` hoặc bật quyền tạo App. | Tự mình quản lý Service Principal. | Cần thời gian chờ IT phê duyệt. | Giữ 100% CI/CD tự động |
| **Phương Án B**: Nhờ Admin IT / Giảng Viên Tạo Giúp Service Principal *(Khuyên Dùng Cho CI/CD)* | Nhờ Admin IT VinUni (hoặc Giảng viên có quyền Admin) chạy 1 lệnh CLI tạo Service Principal và đưa JSON cho bạn. | 100% chuẩn CI/CD GitHub Actions, bạn không cần có quyền Entra ID. | Cần gửi yêu cầu cho Admin/Giảng viên. | **Giữ 100% CI/CD tự động** |
| **Phương Án C**: Triển Khai Local Nhờ Quyền Owner *(Khuyên Dùng Deploy Ngay)* | Tận dụng trực tiếp quyền **Owner** của bạn trên Azure CLI để deploy từ máy local. | **Chạy được NGAY LẬP TỨC 100%**, 0% rào cản Entra ID, không cần chờ ai. | Deploy từ CLI local thay vì GitHub Actions tự động. | Chạy deploy thủ công từ CLI |

---

## 🚀 4. CÁC BƯỚC TIẾP THEO THỰC HIỆN

### Nếu bạn muốn Deploy Web LIVE Ngay Lập Tức (Phương Án C):
Vì bạn đã có quyền **Owner** trên Subscription, bạn có thể tự tay chạy deploy từ máy cá nhân vô cùng nhanh chóng:
```powershell
cd terraform

# 1. Khởi tạo
terraform init

# 2. Deploy Staging ngay lập tức
terraform apply -var-file=environments/staging.tfvars -auto-approve
```

### Nếu bạn muốn Giữ Luồng GitHub Actions Tự Động (Phương Án B):
Gửi email/tin nhắn cho Admin IT VinUni hoặc Giảng viên quản lý môn học với nội dung mẫu:
> *"Em chào Thầy/Cô và IT Support, em đang làm đồ án AI20K triển khai CI/CD GitHub Actions lên Azure. Tài khoản của em đã có quyền Owner trên Subscription `bea3db28-8916-4dc6-928c-8fcd12742c3a`, nhưng Entra ID bị khóa quyền tạo App Registration. Nhờ Thầy/Cô hoặc IT hỗ trợ chạy câu lệnh tạo Service Principal giúp em:*
> `az ad sp create-for-rbac --name "sp-ai20k-github-actions" --role contributor --scopes /subscriptions/bea3db28-8916-4dc6-928c-8fcd12742c3a --sdk-auth` *Em xin cảm ơn ạ!"*
