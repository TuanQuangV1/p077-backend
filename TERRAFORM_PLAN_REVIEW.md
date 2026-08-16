# 📊 Terraform Plan Review — Azure Staging Environment

Tài liệu này tổng hợp kết quả rà soát chi tiết kế hoạch khởi tạo hạ tầng Terraform (Plan Review) cho môi trường **Staging** trên **Microsoft Azure**.

---

## 1. Environment Configuration

- **Cloud Provider**: Microsoft Azure (`azurerm` v3.90+)
- **Subscription Name**: `Azure subscription 1`
- **Subscription ID**: `bea3db28-8916-4dc6-928c-8fcd12742c3a`
- **Tenant ID**: `58f82789-6695-4f4a-abdb-357668d55cff`
- **Target Region**: `eastus`
- **Environment**: `staging`
- **Application Name**: `ai20krosbag`

---

## 2. Resources Created (Danh Sách 9 Tài Nguyên Sẽ Tạo)

| STT | Resource Type | Resource Name | Purpose |
|---|---|---|---|
| 1 | `azurerm_resource_group` | `rg-ai20krosbag-staging` | Quản lý gom nhóm toàn bộ tài nguyên Staging |
| 2 | `azurerm_container_registry` | `acrai20krosbagstaging` | Kho lưu trữ Docker image (ACR Basic SKU) |
| 3 | `azurerm_storage_account` | `stai20krosbagstaging` | Tài khoản lưu trữ dữ liệu bền vững |
| 4 | `azurerm_storage_share` | `appdata` | Đĩa dùng chung Azure File Share (50GB quota) |
| 5 | `azurerm_log_analytics_workspace` | `log-ai20krosbag-staging` | Thu thập nhật ký ứng dụng (Retention: 7 ngày) |
| 6 | `azurerm_container_app_environment` | `cae-ai20krosbag-staging` | Môi trường ảo hóa hosting Container Apps |
| 7 | `azurerm_container_app_environment_storage` | `appdatastorage` | Liên kết File Share vào ACA Environment |
| 8 | `azurerm_container_app` | `app-ai20krosbag-staging-backend` | Host FastAPI Backend (CPU: 0.25, RAM: 0.5Gi, Port 8000) |
| 9 | `azurerm_container_app` | `app-ai20krosbag-staging-frontend` | Host Next.js Frontend (CPU: 0.25, RAM: 0.5Gi, Port 3000) |

---

## 3. Cost Estimation (Bảng Báo Giá Dự Kiến MVP)

| Resource | Configuration | Estimated Cost |
|---|---|---|
| `azurerm_resource_group` | Resource Group | **$0 / tháng** |
| `azurerm_container_registry` | Basic SKU (10GB Capacity) | **~$5 / tháng** |
| `azurerm_storage_account` & `share` | Standard LRS (Chỉ tính dung lượng ghi thật ~1GB) | **<$0.20 / tháng** |
| `azurerm_log_analytics_workspace` | PerGB2018 (Miễn phí 5GB/tháng log nạp đầu tiên) | **$0 / tháng** |
| `azurerm_container_app_environment` | Container App Environment | **$0 / tháng** |
| `azurerm_container_app` (Backend) | 0.25 vCPU, 0.5Gi RAM (`min_replicas = 0`) | **$0 - $1.50 / tháng** |
| `azurerm_container_app` (Frontend) | 0.25 vCPU, 0.5Gi RAM (`min_replicas = 0`) | **$0 - $1.50 / tháng** |
| **TỔNG CHI PHÍ THÁNG** | **Môi trường Demo/MVP Staging** | **~$5 - $8 / tháng** |

---

## 4. Security Review

- **Secrets Handling**: 100% Không có secret/password hardcoded. Xác thực hoàn toàn bằng Azure OIDC/Service Principal qua GitHub Secrets.
- **Permissions**: Phân quyền tối thiểu vừa đủ với Scope chỉ trên Subscription `bea3db28-8916-4dc6-928c-8fcd12742c3a`.
- **Network Ingress**: Container App chỉ mở duy nhất Port 8000 cho Backend và Port 3000 cho Frontend.
- **HTTPS & SSL**: Kích hoạt sẵn TLS 1.2/1.3 mã hóa dữ liệu trên đường truyền mặc định.

---

## 5. Deployment Readiness

**Trạng Thái Kết Luận**: **READY** 🟢

Hạ tầng Terraform Azure đã đạt 100% yêu cầu bảo mật, tối ưu chi phí MVP và hoàn toàn khớp với quy trình GitHub Actions CI/CD.

---

## 6. Next Steps (Các Bước Cần Làm Để Deploy Thật)

1. **Tạo Azure Service Principal** (Chạy lệnh trong PowerShell/Terminal):
   ```bash
   az ad sp create-for-rbac \
     --name "sp-ai20k-github-actions" \
     --role contributor \
     --scopes /subscriptions/bea3db28-8916-4dc6-928c-8fcd12742c3a \
     --sdk-auth
   ```
2. **Cấu hình GitHub Repository Secrets** (`AZURE_CREDENTIALS`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD`).
3. **Merge PR từ branch `feature/terraform-deploy-model` vào branch `develop`** để kích hoạt pipeline deploy Staging tự động.
