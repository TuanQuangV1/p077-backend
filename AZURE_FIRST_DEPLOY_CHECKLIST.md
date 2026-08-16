# 📋 Checklist Triển Khai Azure Lần Đầu (Azure First Deploy Checklist)

Checklist này cung cấp lộ trình kiểm tra từng bước trước và trong khi thực hiện deploy ứng dụng lên Microsoft Azure.

---

## 🟢 PHẦN 1: KIỂM TRA MÔI TRƯỜNG & TÀI KHOẢN AZURE

- [x] **Azure CLI Ready**: Phiên bản `azure-cli 2.89.1` đã được cài đặt.
- [x] **Azure Account Logged In**:
  - Subscription Name: `Azure subscription 1`
  - Subscription ID: `bea3db28-8916-4dc6-928c-8fcd12742c3a`
  - Tenant ID: `58f82789-6695-4f4a-abdb-357668d55cff`
  - Account Email: `26ai.quangmt@vinuni.edu.vn` (`vinuni.edu.vn`)
  - Subscription Status: `Enabled`
- [ ] **Azure Resource Providers Enabled**:
  Chạy lệnh đăng ký các Resource Provider cần thiết nếu chưa bật:
  ```bash
  az provider register --namespace Microsoft.App
  az provider register --namespace Microsoft.ContainerRegistry
  az provider register --namespace Microsoft.OperationalInsights
  az provider register --namespace Microsoft.Storage
  ```

---

## 🔑 PHẦN 2: TẠO SERVICE PRINCIPAL CHO GITHUB ACTIONS

- [ ] **Tạo Service Principal**:
  ```bash
  az ad sp create-for-rbac \
    --name "sp-ai20k-github-actions" \
    --role contributor \
    --scopes /subscriptions/bea3db28-8916-4dc6-928c-8fcd12742c3a \
    --sdk-auth
  ```
- [ ] **Cấu hình Secrets Trên GitHub Repository** (Settings -> Secrets -> Actions):
  - `AZURE_CREDENTIALS`: [Nội dung JSON kết quả từ lệnh trên]
  - `AZURE_CLIENT_ID`: [Giá trị `clientId`]
  - `AZURE_TENANT_ID`: `58f82789-6695-4f4a-abdb-357668d55cff`
  - `AZURE_SUBSCRIPTION_ID`: `bea3db28-8916-4dc6-928c-8fcd12742c3a`
  - `REGISTRY_USERNAME`: [Giá trị `clientId`]
  - `REGISTRY_PASSWORD`: [Giá trị `clientSecret`]

---

## 🛠️ PHẦN 3: KIỂM TRA KẾ HOẠCH HẠ TẦNG (TERRAFORM PLAN)

- [ ] **Khởi Tạo Terraform (Local Test)**:
  ```bash
  cd terraform
  terraform init -backend=false
  ```
- [ ] **Kiểm Tra Cú Pháp HCL**:
  ```bash
  terraform validate
  ```
- [ ] **Xem Trước Tài Nguyên Azure Sẽ Tạo**:
  ```bash
  terraform plan -var-file=environments/staging.tfvars
  ```
  *(Lưu ý: KHÔNG chạy `terraform apply` cho đến khi đã cấu hình GitHub Secrets xong)*.

---

## 🚀 PHẦN 4: THỰC THI DEPLOY THẬT

### Option A: Triển Khai Tự Động Qua CI/CD GitHub Actions (Khuyến nghị)
1. [ ] Push code thay đổi lên branch `feature/terraform-deploy-model`.
2. [ ] Tạo Pull Request và merge vào branch `develop` -> GitHub Actions tự động build Docker & deploy môi trường **Staging**.
3. [ ] Tạo Pull Request và merge vào branch `main` -> GitHub Actions tự động build Docker & deploy môi trường **Production**.

### Option B: Triển Khai Thủ Công Bằng CLI (Local Apply)
1. [ ] Đăng nhập Azure Container Registry:
   ```bash
   az acr login --name acrai20krosbagstaging
   ```
2. [ ] Build & Push Docker image:
   ```bash
   docker build --target backend -t acrai20krosbagstaging.azurecr.io/backend:staging-latest .
   docker build --target frontend --build-arg NEXT_PUBLIC_API_BASE_URL=https://<backend-url> -t acrai20krosbagstaging.azurecr.io/frontend:staging-latest .
   docker push acrai20krosbagstaging.azurecr.io/backend:staging-latest
   docker push acrai20krosbagstaging.azurecr.io/frontend:staging-latest
   ```
3. [ ] Apply Terraform:
   ```bash
   cd terraform
   terraform apply -var-file=environments/staging.tfvars -auto-approve
   ```

---

## 🌐 PHẦN 5: KIỂM TRA KẾT QUẢ & LẤY URL TRUY CẬP

- [ ] **Lấy Frontend Web URL**:
  ```bash
  az containerapp show \
    --name app-ai20krosbag-staging-frontend \
    --resource-group rg-ai20krosbag-staging \
    --query properties.configuration.ingress.fqdn -o tsv
  ```
- [ ] **Lấy Backend API Health Check URL**:
  ```bash
  az containerapp show \
    --name app-ai20krosbag-staging-backend \
    --resource-group rg-ai20krosbag-staging \
    --query properties.configuration.ingress.fqdn -o tsv
  ```
- [ ] **Mở URL trên trình duyệt** (Laptop / Điện thoại) và kiểm tra:
  - Frontend: `https://<frontend_fqdn>`
  - API Health: `https://<backend_fqdn>/health` -> `{"status": "ok"}`
