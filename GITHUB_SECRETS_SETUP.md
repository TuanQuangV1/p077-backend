# 🔑 Hướng Dẫn Cấu Hình Secrets Trên GitHub (GitHub Secrets Setup Guide)

Tài liệu này hướng dẫn chi tiết cách thiết lập các Secrets cần thiết cho CI/CD Workflow (`staging.yml` & `production.yml`) trên GitHub Repository.

---

## 📋 Danh Sách Secrets Cần Thiết

Dựa trên cấu hình trong `.github/workflows/staging.yml` và `.github/workflows/production.yml`, workflow yêu cầu chính xác **3 Secrets quan trọng**:

| Tên Secret Trên GitHub | Giá Trị Lấy Từ Đâu? | Mục Đích Sử Dụng |
|---|---|---|
| `AZURE_CREDENTIALS` | Dán toàn bộ nội dung JSON xuất ra từ lệnh `az ad sp create-for-rbac` | Đăng nhập Azure CLI qua `azure/login@v2` |
| `REGISTRY_USERNAME` | Giá trị `clientId` từ đoạn JSON (hoặc Username quản trị ACR) | Đăng nhập Azure Container Registry qua `azure/docker-login@v1` |
| `REGISTRY_PASSWORD` | Giá trị `clientSecret` từ đoạn JSON (hoặc Password quản trị ACR) | Đăng nhập Azure Container Registry qua `azure/docker-login@v1` |

---

## 🛠️ Từng Bước Tạo Service Principal & Lấy Giá Trị Secrets

### Bước 1: Chạy lệnh tạo Service Principal trên PowerShell / Terminal

```bash
az ad sp create-for-rbac \
  --name "sp-ai20k-github-actions" \
  --role contributor \
  --scopes /subscriptions/bea3db28-8916-4dc6-928c-8fcd12742c3a \
  --sdk-auth
```

### Bước 2: Kết quả JSON nhận được có cấu trúc như sau:

```json
{
  "clientId": "11111111-2222-3333-4444-555555555555",
  "clientSecret": "wXyZ~1234567890abcdefghijklmnopqrst",
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

### Bước 3: Ánh Xạ Vào GitHub Repository Secrets

1. Truy cập GitHub Repository của bạn trên trình duyệt.
2. Chuyển sang thẻ: **Settings** -> **Secrets and variables** -> **Actions**.
3. Nhấp vào nút xanh **New repository secret**.
4. Thêm lượt lượt các Secret:
   - **Secret 1**:
     - Name: `AZURE_CREDENTIALS`
     - Secret: [Copy và dán toàn bộ đoạn JSON từ `{` đến `}`]
   - **Secret 2**:
     - Name: `REGISTRY_USERNAME`
     - Secret: `11111111-2222-3333-4444-555555555555` *(Giá trị `clientId`)*
   - **Secret 3**:
     - Name: `REGISTRY_PASSWORD`
     - Secret: `wXyZ~1234567890abcdefghijklmnopqrst` *(Giá trị `clientSecret`)*
