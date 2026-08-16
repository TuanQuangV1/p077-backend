# 🌐 Azure App Registration & GitHub Secrets Setup Guide

Tài liệu này hướng dẫn chi tiết từng thao tác trên **Azure Portal UI** để khởi tạo **App Registration** (thay thế lệnh CLI), cấp quyền `Contributor` cho Subscription và ánh xạ chính xác vào **GitHub Secrets** phục vụ CI/CD deployment tự động.

---

## 📌 PHẦN 1: TẠO APP REGISTRATION TRÊN AZURE PORTAL

1. Mở trình duyệt và đăng nhập vào: [https://portal.azure.com/](https://portal.azure.com/)
2. Trên ô tìm kiếm ở trên cùng, gõ **Microsoft Entra ID** (hoặc *Azure Active Directory*) và nhấp chọn.
3. Ở menu bên trái, nhấp vào **App registrations**.
4. Nhấp vào nút **+ New registration** ở thanh công cụ phía trên.
5. Điền các thông số:
   - **Name**: `sp-ai20k-github-actions`
   - **Supported account types**: Chọn dòng đầu tiên **`Accounts in this organizational directory only (Single tenant)`**.
   - **Redirect URI**: ĐỂ TRỐNG (không cần điền).
6. Nhấp vào nút **Register** ở dưới cùng.

👉 **Lưu lại 2 thông số trên trang Overview**:
- **Application (client) ID**: (Ví dụ dạng `11111111-2222-3333-4444-555555555555`)
- **Directory (tenant) ID**: `58f82789-6695-4f4a-abdb-357668d55cff`

---

## 🔑 PHẦN 2: TẠO CLIENT SECRET

1. Trong trang App Registration vừa tạo (`sp-ai20k-github-actions`), ở menu bên trái nhấp chọn **Certificates & secrets**.
2. Thẻ **Client secrets**, nhấp chọn nút **+ New client secret**.
3. Điền thông tin:
   - **Description**: `github-actions-deploy`
   - **Expires**: Chọn `180 days (6 months)` hoặc tùy chọn phù hợp.
4. Nhấp nút **Add**.
5. ⚠️ **QUAN TRỌNG**: Sao chép ngay lập tức chuỗi ký tự ở cột **`Value`** (Đây là Client Secret Value, tuyệt đối KHÔNG copy cột *Secret ID*). 
   *Lưu ý: Chuỗi Value này chỉ hiển thị 1 lần duy nhất trên Portal, nếu chuyển trang sẽ bị ẩn đĩa!*

---

## 🛡️ PHẦN 3: GÁN QUYỀN CONTRIBUTOR TRÊN AZURE SUBSCRIPTION

1. Trên ô tìm kiếm Azure Portal, gõ **Subscriptions** và chọn.
2. Nhấp chọn Subscription của bạn: **`Azure subscription 1`** (ID: `bea3db28-8916-4dc6-928c-8fcd12742c3a`).
3. Ở menu bên trái, nhấp chọn **Access control (IAM)**.
4. Nhấp chọn **+ Add** -> **Add role assignment**.
5. Tại thẻ **Role**: Gõ tìm và chọn vai trò **`Contributor`** -> Nhấp **Next**.
6. Tại thẻ **Members**:
   - Chọn **Assign access to**: `User, group, or service principal`.
   - Nhấp link **+ Select members**.
   - Gõ tìm tên: `sp-ai20k-github-actions` -> Nhấp chọn tên hiện ra ở dưới -> Bấm nút **Select**.
7. Nhấp **Review + assign** hai lần để hoàn tất cấp quyền.

---

## 🔗 PHẦN 4: ÁNH XẠ SANG GITHUB REPOSITORY SECRETS

Vào GitHub Repository của bạn trên trình duyệt -> **Settings** -> **Secrets and variables** -> **Actions** -> Bấm **New repository secret** để tạo 3 Secrets:

### 1. Secret `AZURE_CREDENTIALS` (Loại JSON)
Dán đúng định dạng JSON bên dưới (thay thế `YOUR_CLIENT_ID` và `YOUR_CLIENT_SECRET_VALUE` bằng giá trị thực tế của bạn):

```json
{
  "clientId": "YOUR_CLIENT_ID",
  "clientSecret": "YOUR_CLIENT_SECRET_VALUE",
  "subscriptionId": "bea3db28-8916-4dc6-928c-8fcd12742c3a",
  "tenantId": "58f82789-6695-4f4a-abdb-357668d55cff"
}
```

### 2. Secret `REGISTRY_USERNAME`
Dán chuỗi `YOUR_CLIENT_ID` (Application Client ID từ Bước 1).

### 3. Secret `REGISTRY_PASSWORD`
Dán chuỗi `YOUR_CLIENT_SECRET_VALUE` (Client Secret Value từ Bước 2).

---

## 🎯 PHẦN 5: TRẠNG THÁI SẴN SÀNG CHO DEPLOYMENT

- [x] App Registration `sp-ai20k-github-actions` được khởi tạo thành công.
- [x] Client Secret sẵn sàng.
- [x] Subscription Role `Contributor` đã gán.
- [x] 3 GitHub Secrets (`AZURE_CREDENTIALS`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD`) đã ánh xạ chuẩn.

**Kết Luận**: **READY FOR FIRST DEPLOYMENT 🚀**
