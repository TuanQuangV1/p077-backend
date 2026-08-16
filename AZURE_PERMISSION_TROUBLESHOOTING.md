# 🛠️ Azure & GitHub Permission Troubleshooting Guide

Tài liệu này tổng hợp kết quả phân tích nguyên nhân và các giải pháp khắc phục sự cố phân quyền **GitHub Workflow Scope** và **Microsoft Entra ID Service Principal Registration**.

---

## 📌 1. PHÂN TÍCH NGUYÊN NHÂN SỰ CỐ

### Sự Cố 1: Git Push Bị Từ Chối (`OAuth App without workflow scope`)
- **Triệu chứng**: Git từ chối push commit có sửa đổi file trong `.github/workflows/`.
- **Nguyên nhân**: Token đăng nhập Git HTTPS hiện tại lưu trên Windows Credential Manager chưa có scope `workflow`.

### Sự Cố 2: Azure CLI Không Cho Tạo Service Principal (`Insufficient privileges`)
- **Triệu chứng**: `az ad sp create-for-rbac` báo lỗi `Directory permission is needed`.
- **Phân tích quyền hiện tại**:
  - **Azure Subscription Role**: Tài khoản `26ai.quangmt@vinuni.edu.vn` có quyền **Owner** trên Subscription `bea3db28-8916-4dc6-928c-8fcd12742c3a` (Quyền cao nhất quản lý hạ tầng Azure).
  - **Microsoft Entra ID Role**: Tenant `vinuni.edu.vn` bị giới hạn chính sách "Users can register applications = No". Thiếu một trong các vai trò Entra ID Directory: `Application Administrator`, `Cloud Application Administrator`, hoặc `Application Developer`.

---

## 🛠️ 2. HƯỚNG DẪN KHẮC PHỤC CHI TIẾT

### Bước 1: Xử Lý Quyền Git Workflow Scope (Khắc phục Sự Cố 1)

Do máy chưa có `gh` CLI, cách nhanh nhất là dùng **Personal Access Token (PAT)**:

1. Vào trình duyệt mở: [https://github.com/settings/tokens](https://github.com/settings/tokens)
2. Bấm **Generate new token (classic)**.
3. Đặt tên: `antigravity-workflow-token`.
4. Tích chọn 2 ô quan trọng: **`repo`** và **`workflow`**.
5. Bấm **Generate token** -> Copy chuỗi token dạng `ghp_xxxxxxxxxxxx`.
6. Thực hiện push code lên GitHub:
   ```powershell
   git push https://ghp_YOUR_TOKEN_HERE@github.com/AI20K-Build-Phase-Cohort-3/P-077.git feature/terraform-deploy-model
   ```

---

### Bước 2: So Sánh & Chọn Hướng Xử Lý Azure Credentials (Khắc phục Sự Cố 2)

| Phương Án | Mô Tả | Ưu Điểm | Nhược Điểm | Ảnh Hưởng CI/CD |
|---|---|---|---|---|
| **Phương Án A**: Xin cấp quyền Entra ID | Yêu cầu IT Admin cấp vai trò `Application Developer` trong Microsoft Entra ID. | Tạo được Service Principal chuẩn qua CLI. | Cần thời gian chờ IT Admin phê duyệt. | Không |
| **Phương Án B**: Tạo App Registration qua Azure Portal UI | Vào [Azure Portal](https://portal.azure.com/) -> Microsoft Entra ID -> App registrations -> New registration. | Giao diện Web đôi khi cho phép tạo App ngay cả khi CLI script bị chặn. | Cần tạo thủ công trên trình duyệt. | Không |
| **Phương Án C**: Triển Khai Terraform Local | Tận dụng trực tiếp quyền **Owner** sẵn có của bạn trên Azure CLI để deploy. | **Chạy được ngay lập tức 100%**, không bị chặn bởi Entra ID. | Deploy từ máy cá nhân thay vì GitHub Actions. | Không dùng GitHub Actions |

---

## 🚀 3. CÁC BƯỚC TIẾP THEO ĐỀ XUẤT

1. **Khuyên dùng Phương Án B (Tạo trên Azure Portal UI)**:
   - Truy cập Azure Portal -> **Microsoft Entra ID** -> **App registrations** -> **New registration** (Name: `sp-ai20k-github-actions`).
   - Tạo Client Secret tại **Certificates & secrets**.
   - Gán role `Contributor` tại Subscription **Access Control (IAM)**.
   - Thêm `AZURE_CREDENTIALS`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` vào GitHub Secrets.
2. **Nếu Portal UI cũng bị khóa**:
   - Sử dụng **Phương Án C (Deploy Local)** bằng lệnh:
     ```powershell
     cd terraform
     terraform init
     terraform apply -var-file=environments/staging.tfvars -auto-approve
     ```
