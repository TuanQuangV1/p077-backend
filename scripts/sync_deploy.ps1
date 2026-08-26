Write-Host "🔄 [1/2] Đang kéo code mới nhất từ repo nhóm (AI20K-Build-Phase-Cohort-3/P-077)..." -ForegroundColor Cyan
git pull origin develop

if ($LASTEXITCODE -eq 0) {
    Write-Host "🚀 [2/2] Đang đẩy code sang repo cá nhân để kích hoạt Vercel & Render..." -ForegroundColor Green
    git push personal develop:main
    Write-Host "✅ Hoàn tất! Vercel và Render đang tự động deploy bản mới nhất." -ForegroundColor Green
} else {
    Write-Host "⚠️ Có xung đột hoặc lỗi khi kéo code. Vui lòng kiểm tra lại." -ForegroundColor Red
}
