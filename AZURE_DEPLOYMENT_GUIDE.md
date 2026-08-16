# 🚀 Hướng Dẫn Triển Khai Lần Đầu Lên Microsoft Azure (Azure Deployment Guide)

Tài liệu này hướng dẫn chi tiết từng bước cho người dùng từ việc khởi tạo tài khoản Azure, thiết lập Azure CLI, cấu hình GitHub Secrets cho đến chạy Terraform deploy và truy cập ứng dụng thành công trên cả máy tính lẫn điện thoại.

---

## 📋 Mục Lục
1. [Chuẩn Bị Tài Khoản & Azure CLI](#1-chuẩn-bị-tài-khoản--azure-cli)
2. [Tạo Service Principal / Credentials Cho GitHub Actions](#2-tạo-service-principal--credentials-cho-github-actions)
3. [Cấu Hình Secrets Trên GitHub Repository](#3-cấu-hình-secrets-trên-github-repository)
4. [Triển Khai Bằng Terraform (Thủ Công Hoặc CI/CD)](#4-triển-khai-bằng-terraform-thủ-công-hoặc-cicd)
5. [Kiểm Tra & Truy Cập Ứng Dụng](#5-kiểm-tra--truy-cập-ứng-dụng)
6. [Cấu Hình Domain Mặc Định & Custom Domain + HTTPS](#6-cấu-hình-domain-mặc-định--custom-domain--https)

---

## 1. Chuẩn Bị Tài Khoản & Azure CLI

### Bước 1: Tạo Tài Khoản Azure
- Truy cập [https://azure.microsoft.com/free/](https://azure.microsoft.com/free/) để đăng ký tài khoản Azure Free (nhận $200 credits miễn phí trong 30 ngày đầu tiên và nhiều dịch vụ miễn phí 12 tháng).

### Bước 2: Cài Đặt Azure CLI (`az`)
- **Windows (PowerShell)**:
  ```powershell
  invoke-web-request -uri https://aka.ms/installazurecliwindows -outfile AzureCLI.msi
  start-process msiexec.exe -argumentlist '/i AzureCLI.msi /quiet' -wait
  ```
- **macOS**:
  ```bash
  brew install azure-cli
  ```
- **Linux (Ubuntu/Debian)**:
  ```bash
  curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
  ```

### Bước 3: Đăng Nhập Azure Qua CLI
```bash
# Mở trình duyệt để đăng nhập tài khoản Azure
az login

# Kiểm tra danh sách Subscription và lấy Subscription ID
az account list --output table
```

---

## 2. Tạo Service Principal / Credentials Cho GitHub Actions

Để GitHub Actions CI/CD có thể tự động đẩy Docker image lên Azure Container Registry (ACR) và chạy Terraform apply, bạn cần tạo một **Azure Service Principal**:

```bash
# Lấy Subscription ID của bạn
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# Tạo Service Principal phân quyền Contributor
az ad sp create-for-rbac \
  --name "sp-ai20k-github-actions" \
  --role contributor \
  --scopes /subscriptions/$SUBSCRIPTION_ID \
  --sdk-auth
```

Kết quả sẽ xuất ra một đoạn JSON có dạng như sau:
```json
{
  "clientId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "clientSecret": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "subscriptionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "tenantId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "activeDirectoryEndpointUrl": "https://login.microsoftonline.com",
  "resourceManagerEndpointUrl": "https://management.azure.com/",
  "activeDirectoryGraphResourceId": "https://graph.windows.net/",
  "sqlManagementEndpointUrl": "https://management.core.windows.net/",
  "galleryEndpointUrl": "https://gallery.azure.com/",
  "managementEndpointUrl": "https://management.core.windows.net/"
}
```

---

## 3. Cấu Hình Secrets Trên GitHub Repository

Vào GitHub Repository của bạn: **Settings** -> **Secrets and variables** -> **Actions** -> bấm **New repository secret** và thêm các biến sau:

| Tên Secret trên GitHub | Giá trị (Value) |
|---|---|
| `AZURE_CREDENTIALS` | Dán toàn bộ nội dung JSON vừa tạo ở Bước 2 |
| `AZURE_CLIENT_ID` | Giá trị `clientId` từ đoạn JSON |
| `AZURE_TENANT_ID` | Giá trị `tenantId` từ đoạn JSON |
| `AZURE_SUBSCRIPTION_ID` | Giá trị `subscriptionId` từ đoạn JSON |
| `REGISTRY_USERNAME` | Giá trị `clientId` (hoặc admin username của ACR) |
| `REGISTRY_PASSWORD` | Giá trị `clientSecret` (hoặc admin password của ACR) |

---

## 4. Triển Khai Bằng Terraform (Thủ Công Hoặc CI/CD)

### Cách A: Tự Động Triển Khai Qua CI/CD (Khuyến nghị)
1. Push code lên branch `feature/terraform-deploy-model`.
2. Merge PR vào branch `develop` -> GitHub Actions tự động build & deploy môi trường **Staging**.
3. Merge PR vào branch `main` -> GitHub Actions tự động build & deploy môi trường **Production**.

### Cách B: Triển Khai Thủ Công Từ Máy Local

```bash
# 1. Di chuyển vào thư mục terraform
cd terraform

# 2. Khởi tạo Azure Provider
terraform init -backend=false

# 3. Kiểm tra các tài nguyên Azure sẽ tạo (STAGING)
terraform plan -var-file=environments/staging.tfvars

# 4. Thực thi triển khai hạ tầng (chỉ chạy khi bạn chắc chắn)
terraform apply -var-file=environments/staging.tfvars -auto-approve
```

---

## 5. Kiểm Tra & Truy Cập Ứng Dụng

Sau khi Terraform hoặc CI/CD hoàn tất, bạn có thể lấy URL công khai của dịch vụ:

### Lấy URL Qua Azure CLI:
```bash
# Lấy URL Frontend Container App Staging
az containerapp show \
  --name app-ai20krosbag-staging-frontend \
  --resource-group rg-ai20krosbag-staging \
  --query properties.configuration.ingress.fqdn -o tsv

# Lấy URL Backend API Health Check
az containerapp show \
  --name app-ai20krosbag-staging-backend \
  --resource-group rg-ai20krosbag-staging \
  --query properties.configuration.ingress.fqdn -o tsv
```

### Kiểm Tra Trực Tiếp Trên Trình Duyệt:
- **Frontend Web UI**: `https://<frontend_fqdn>` (Mở được trực tiếp trên cả máy tính và điện thoại thông qua HTTPS).
- **Backend API Health Check**: `https://<backend_fqdn>/health` -> Trả về `{"status": "ok", "env": "staging"}`.
- **Backend Interactive Swagger Docs**: `https://<backend_fqdn>/docs`.

---

## 6. Cấu Hình Domain Mặc Định & Custom Domain + HTTPS

### Domain Mặc Định Môi Trường Azure:
Azure Container Apps tự động cấp domain công khai mặc định HTTPS chuẩn wildcard SSL:
- Staging Backend: `https://app-ai20krosbag-staging-backend.<region>.azurecontainerapps.io`
- Staging Frontend: `https://app-ai20krosbag-staging-frontend.<region>.azurecontainerapps.io`
- Production Backend: `https://app-ai20krosbag-production-backend.<region>.azurecontainerapps.io`
- Production Frontend: `https://app-ai20krosbag-production-frontend.<region>.azurecontainerapps.io`

### Bật Custom Domain Cho Production (Ví dụ: `yourdomain.com`):
1. **Thêm CNAME / A Record trên DNS Manager của bạn** (Cloudflare, GoDaddy, Namecheap...):
   - Type: `CNAME`, Name: `api`, Target: `<backend_fqdn>`
   - Type: `CNAME`, Name: `@` hoặc `www`, Target: `<frontend_fqdn>`
2. **Gắn Domain & Chứng Chỉ SSL Miễn Phí Trên Azure Container App**:
   ```bash
   # Thêm hostname custom domain vào Container App
   az containerapp hostname add \
     --name app-ai20krosbag-production-frontend \
     --resource-group rg-ai20krosbag-production \
     --hostname yourdomain.com

   # Azure tự động cấp chứng chỉ Managed Managed SSL Certificate hoàn toàn miễn phí
   az containerapp hostname bind \
     --name app-ai20krosbag-production-frontend \
     --resource-group rg-ai20krosbag-production \
     --hostname yourdomain.com \
     --environment cae-ai20krosbag-production
   ```
