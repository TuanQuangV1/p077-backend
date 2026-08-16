# 🚀 First Deploy Runbook — Quy Trình Triển Khai Lần Đầu Lên Azure

Tài liệu này là hướng dẫn từng bước (Step-by-Step Runbook) để bạn khởi chạy đợt deploy thật đầu tiên cho môi trường **Staging** và **Production** qua GitHub Actions.

---

## 📋 BẢNG CÁC BƯỚC THỰC HIỆN TUẦN TỰ

### Bước 1: Tạo Azure Service Principal Cấp Quyền
Mở PowerShell / Terminal và chạy lệnh:
```bash
az ad sp create-for-rbac \
  --name "sp-ai20k-github-actions" \
  --role contributor \
  --scopes /subscriptions/bea3db28-8916-4dc6-928c-8fcd12742c3a \
  --sdk-auth
```

---

### Bước 2: Thêm Secrets Trên GitHub Repository
Truy cập **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**:
1. `AZURE_CREDENTIALS` = [Nội dung JSON xuất ra ở Bước 1]
2. `REGISTRY_USERNAME` = [Giá trị `clientId`]
3. `REGISTRY_PASSWORD` = [Giá trị `clientSecret`]

---

### Bước 3: Commit & Push Code Trên Feature Branch
```bash
git checkout feature/terraform-deploy-model
git add .
git commit -m "feat: setup azure infrastructure and github secrets runbook"
git push origin feature/terraform-deploy-model
```

---

### Bước 4: Triển Khai Môi Trường Staging
1. Mở GitHub Repository -> Chuyển sang phần **Pull Requests**.
2. Tạo Pull Request mới: **Base: `develop`** ← **Compare: `feature/terraform-deploy-model`**.
3. Bấm **Merge Pull Request**.
4. Chuyển sang thẻ **Actions** trên GitHub để theo dõi workflow `CD - Azure Staging Deployment`:
   - Step 1: Run Pytest & Lint.
   - Step 2: Build & Push Docker image lên ACR `acrai20krosbagstaging`.
   - Step 3: Terraform Apply Azure Staging.
   - Step 4: Staging Health Check.

---

### Bước 5: Kiểm Tra URL Website Staging
Sau khi Workflow báo xanh (Success 🟢), lấy Web URL bằng lệnh CLI:
```bash
az containerapp show \
  --name app-ai20krosbag-staging-frontend \
  --resource-group rg-ai20krosbag-staging \
  --query properties.configuration.ingress.fqdn -o tsv
```
Truy cập `https://<fqdn>` trên trình duyệt máy tính hoặc điện thoại!

---

### Bước 6: Triển Khai Môi Trường Production
1. Sau khi đã nghiệm thu xong trên Staging, tạo Pull Request mới: **Base: `main`** ← **Compare: `develop`**.
2. Bấm **Merge Pull Request**.
3. Workflow `CD - Azure Production Deployment` sẽ tự động deploy môi trường **Production**.
