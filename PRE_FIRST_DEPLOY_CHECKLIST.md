# ✅ Pre-First Deploy Checklist — Kiểm Tra Lần Cuối Trước Khi Merge PR

Checklist này cung cấp quy trình nghiệm thu từng mục trước khi bạn bấm nút **Merge Pull Request** từ `feature/terraform-deploy-model` vào `develop` để triển khai lần đầu tiên lên Azure.

---

## 1. 📌 GIT BRANCH & COMMIT STATUS

- [x] **Branch Hiện Tại**: Đang đứng tại đúng nhánh `feature/terraform-deploy-model`.
- [ ] **Commit Code Chưa Đẩy**: Đã commit toàn bộ các file thay đổi bên dưới lên Git repository bằng lệnh:
  ```bash
  git add .
  git commit -m "feat: complete azure terraform deployment infrastructure, workflows, and runbooks"
  git push origin feature/terraform-deploy-model
  ```

---

## 2. 📂 DANH SÁCH FILE THAY ĐỔI & TẠO MỚI (VERIFICATION)

- [x] **Hạ Tầng Terraform Azure (`terraform/`)**:
  - `providers.tf`: Đã cấu hình AzureRM v3.90+ & Subscription ID `bea3db28-8916-4dc6-928c-8fcd12742c3a`.
  - `main.tf`: Đã tối ưu `acr_sku = "Basic"` ($5/tháng) & `min_replicas = 0` (Scale to Zero khi rảnh rỗi). Đã fix lỗi `password_secret_name`.
  - `variables.tf`, `outputs.tf`, `staging.tfvars`, `production.tfvars`.
- [x] **GitHub Actions Workflows (`.github/workflows/`)**:
  - `staging.yml`: Đã kích hoạt Build, Push ACR, Terraform Apply Staging, Tự động trích xuất FQDN URL và Health Check Gate.
  - `production.yml`: Đã kích hoạt đầy đủ luồng Gatekeeper Production Deployment.
- [x] **Docker & Proxy**:
  - `Dockerfile`: Đã bổ sung `ENV HOSTNAME="0.0.0.0"` và `ENV PORT=3000` cho Next.js standalone.
  - `nginx/nginx.conf`: Đã nâng cấp CORS Dynamic Whitelist.
- [x] **Tài Liệu Hướng Dẫn Kèm Theo**:
  - `AZURE_DEPLOYMENT_GUIDE.md`
  - `GITHUB_SECRETS_SETUP.md`
  - `FIRST_DEPLOY_RUNBOOK.md`
  - `TERRAFORM_PLAN_REVIEW.md`
  - `FINAL_AZURE_DEPLOYMENT_REPORT.md`
  - `FINAL_CICD_REVIEW.md`

---

## 3. 🔑 AZURE SECRETS & PERMISSIONS CHECKLIST

- [ ] **Azure Service Principal Prepared**: Đã chạy lệnh `az ad sp create-for-rbac` trên Subscription `bea3db28-8916-4dc6-928c-8fcd12742c3a`.
- [ ] **GitHub Secrets Added** (Repo -> Settings -> Secrets and variables -> Actions):
  - [ ] `AZURE_CREDENTIALS` (Toàn bộ đoạn JSON Service Principal)
  - [ ] `REGISTRY_USERNAME` (Giá trị `clientId`)
  - [ ] `REGISTRY_PASSWORD` (Giá trị `clientSecret`)
- [ ] **Azure Resource Providers Registered**:
  - `Microsoft.App`
  - `Microsoft.ContainerRegistry`
  - `Microsoft.OperationalInsights`
  - `Microsoft.Storage`

---

## ⚠️ 4. CÁC LỖI PHỔ BIẾN KHI FIRST DEPLOYMENT & CÁCH PHÒNG TRÁNH

| Lỗi Phổ Biến | Nguyên Nhân | Cách Phòng Tránh & Khắc Phục |
|---|---|---|
| **1. Invalid Azure Credentials JSON** | Đã copy thiếu dấu ngoặc `{}` hoặc thừa khoảng trắng khi thêm `AZURE_CREDENTIALS` vào GitHub Secret. | Copy chính xác toàn bộ nội dung JSON từ `{` đến `}` xuất ra từ Azure CLI. |
| **2. Provider Namespace Not Registered** | Azure Subscription chưa bật tính năng `Microsoft.App` hoặc `Microsoft.ContainerRegistry`. | Chạy lệnh `az provider register --namespace Microsoft.App` trước khi deploy. |
| **3. ACR Name Already Exists Globally** | Tên Azure Container Registry trùng với một người dùng khác trên toàn cầu. | Tên `acrai20krosbagstaging` hiện tại chưa bị trùng. Nếu trùng, chỉ cần đổi tên trong `staging.tfvars`. |
| **4. Docker Build Timeout / Memory Exhausted** | Runner GitHub hết bộ nhớ khi build Next.js. | `Dockerfile` đã dùng Multi-stage build cực kỳ tối ưu dung lượng và bộ nhớ. |
| **5. CORS Origin Error Khi Gọi API** | Frontend trên Azure gọi sai URL Backend API. | `staging.yml` tự động truyền `--build-arg NEXT_PUBLIC_API_BASE_URL` trỏ chuẩn về Backend ACA URL. |

---

## 🚀 5. CHECKLIST THỰC HIỆN MERGE (FINAL ACTION)

- [ ] 1. Mở GitHub Repository -> Chuyển sang phần **Pull Requests**.
- [ ] 2. Tạo Pull Request từ branch `feature/terraform-deploy-model` vào branch `develop`.
- [ ] 3. Kiểm tra không có xung đột (No merge conflicts).
- [ ] 4. Bấm nút xanh **Merge Pull Request**!
- [ ] 5. Mở thẻ **Actions** trên GitHub để theo dõi quá trình CI/CD deploy tự động.
