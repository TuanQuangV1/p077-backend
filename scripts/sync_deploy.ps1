Write-Host "🔄 [1/3] Đang kéo code mới nhất từ repo nhóm (AI20K-Build-Phase-Cohort-3/P-077)..." -ForegroundColor Cyan
git pull origin develop

if ($LASTEXITCODE -eq 0) {
    Write-Host "🔀 [2/3] Đang đóng gói bản cập nhật..." -ForegroundColor Cyan
    git checkout deploy/render
    git merge develop -m "sync: update deployment with latest changes from develop"
    
    Write-Host "🚀 [3/3] Đang đẩy code sang repo cá nhân để kích hoạt Vercel & Render..." -ForegroundColor Green
    git push personal deploy/render:main
    git checkout develop
    
    Write-Host "✅ Hoàn tất! Vercel và Render đang tự động deploy bản mới nhất." -ForegroundColor Green
} else {
    Write-Host "⚠️ Có xung đột hoặc lỗi khi kéo code. Vui lòng kiểm tra lại." -ForegroundColor Red
}
