# 📧 Mẫu Yêu Cầu Tạo Service Principal & Hướng Dẫn Cấu Hình GitHub Secrets (IT Admin Request Guide)

Tài liệu này chuẩn bị sẵn nội dung yêu cầu gửi **IT Support VinUni** hoặc **Giảng viên/Quản trị viên Entra ID** để nhờ khởi tạo **Azure Service Principal**, cùng hướng dẫn ánh xạ chính xác vào GitHub Secrets để giữ nguyên kiến trúc CI/CD tự động (`GitHub Actions → Azure Container Registry → Terraform → Azure Container Apps`).

---

## 📌 PHẦN 1: MẪU NỘI DUNG YÊU CẦU GỬI IT ADMIN / GIẢNG VIÊN

Bạn có thể sao chép mẫu email / tin nhắn bên dưới và gửi cho bộ phận IT Support VinUni hoặc Giảng viên/Trợ giảng quản lý môn học:

```text
Kính gửi Bộ phận IT Support VinUni / Giảng viên quản lý môn học,

Em tên là: MAI TUAN QUANG (Email: 26ai.quangmt@vinuni.edu.vn)
Dự án: Đồ án AI20K — RAV-13 Rosbag Diagnostics Platform

Hiện tại em đang triển khai quy trình CI/CD tự động qua GitHub Actions để tự động deploy ứng dụng lên Microsoft Azure. Tài khoản của em hiện đã có quyền Owner trên Azure Subscription:

- Subscription Name: Azure subscription 1
- Subscription ID: bea3db28-8916-4dc6-928c-8fcd12742c3a
- Tenant ID: 58f82789-6695-4f4a-abdb-357668d55cff (vinuni.edu.vn)

Tuy nhiên, do chính sách bảo mật Microsoft Entra ID của trường, tài khoản người dùng của em không có quyền tự đăng ký App Registration / Service Principal qua Azure CLI.

Em kính nhờ IT Admin / Thầy Cô hỗ trợ khởi tạo giúp em 1 Service Principal bằng cách chạy câu lệnh Azure CLI bên dưới (hoặc tạo trên Azure Portal):

--------------------------------------------------------------------------------
az ad sp create-for-rbac \
  --name "sp-ai20k-github-actions" \
  --role contributor \
  --scopes /subscriptions/bea3db28-8916-4dc6-928c-8fcd12742c3a \
  --sdk-auth
--------------------------------------------------------------------------------

Sau khi chạy xong, nhờ Thầy Cô / IT gửi lại giúp em đoạn mã JSON kết quả để em cấu hình vào GitHub Repository Secrets phục vụ bài tập đồ án.

Em xin chân thành cảm ơn ạ!
```

---

## 🔑 PHẦN 2: THÔNG TIN CHÍNH XÁC IT ADMIN CẦN CUNG CẤP

Đoạn mã JSON kết quả mà IT Admin / Giảng viên gửi lại cho bạn sẽ bao gồm 4 thông số cốt lõi:

1. **`clientId`**: (Application/Client ID định danh cho Service Principal)
2. **`clientSecret`**: (Khóa secret password dùng để đăng nhập)
3. **`tenantId`**: `58f82789-6695-4f4a-abdb-357668d55cff`
4. **`subscriptionId`**: `bea3db28-8916-4dc6-928c-8fcd12742c3a`

### Định dạng JSON mẫu nhận được từ Admin:
```json
{
  "clientId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "clientSecret": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "subscriptionId": "bea3db28-8916-4dc6-928c-8fcd12742c3a",
  "tenantId": "58f82789-6695-4f4a-abdb-357668d55cff",
  "activeDirectoryEndpointUrl": "https://login.microsoftonline.com",
  "resourceManagerEndpointUrl": "https://management.azure.com/",
  "activeDirectoryGraphResourceId": "https://graph.windows.net/",
  "sqlManagementEndpointUrl": "https://management.core.windows.net/",
  "galleryEndpointUrl": "https://gallery.azure.com/",
  "managementEndpointUrl": "https://management.core.windows.net/"
}
```

---

## 🔗 PHẦN 3: ÁNH XẠ CHÍNH XÁC SANG GITHUB REPOSITORY SECRETS

Sau khi nhận được JSON từ Admin, bạn vào GitHub Repository -> **Settings** -> **Secrets and variables** -> **Actions** -> bấm **New repository secret** và thêm đúng **3 Secrets**:

| STT | Tên Secret Trên GitHub | Giá Trị Cần Dán Vào | Mục Đích Trong CI/CD |
|---|---|---|---|
| **1** | **`AZURE_CREDENTIALS`** | Copy và dán toàn bộ đoạn mã JSON nhận được từ Admin (bao gồm cả dấu `{` và `}`) | Dùng cho `azure/login@v2` đăng nhập Azure |
| **2** | **`REGISTRY_USERNAME`** | Dán chuỗi giá trị `clientId` | Dùng cho `azure/docker-login@v1` đăng nhập ACR |
| **3** | **`REGISTRY_PASSWORD`** | Dán chuỗi giá trị `clientSecret` | Dùng cho `azure/docker-login@v1` đăng nhập ACR |

---

## 🚀 PHẦN 4: QUY TRÌNH KÍCH HOẠT DEPLOYMENT TỰ ĐỘNG

Ngay sau khi cấu hình xong 3 Secrets ở Bước 3:

1. Mở GitHub Repository của bạn.
2. Tạo Pull Request từ branch `feature/terraform-deploy-model` vào branch `develop`.
3. Bấm **Merge Pull Request**.
4. GitHub Actions workflow `.github/workflows/staging.yml` sẽ tự động kích hoạt:
   - Build Docker images Backend & Frontend.
   - Push images lên Azure Container Registry (`acrai20krosbagstaging.azurecr.io`).
   - Chạy `terraform apply` khởi tạo hạ tầng Azure Container Apps.
   - Xuất URL công khai trực tiếp ra log của GitHub Actions!
