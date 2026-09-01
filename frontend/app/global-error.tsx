"use client"

import { useEffect } from "react"

/**
 * Last-resort boundary for errors thrown in the root layout itself. It replaces
 * the whole document, so it must render its own <html>/<body>.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="vi">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b1220",
          color: "#e5e7eb",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", padding: "1.5rem", maxWidth: "28rem" }}>
          <h1 style={{ fontSize: "1.125rem", fontWeight: 600 }}>Ứng dụng gặp sự cố</h1>
          <p style={{ fontSize: "0.875rem", color: "#9ca3af", marginTop: "0.25rem" }}>
            Không thể dựng giao diện. Thử tải lại trang.
          </p>
          {error.digest ? (
            <p style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.625rem", color: "#6b7280" }}>
              mã lỗi: {error.digest}
            </p>
          ) : null}
          <button
            onClick={reset}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "none",
              background: "#0ea5e9",
              color: "#0b1220",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Thử lại
          </button>
        </div>
      </body>
    </html>
  )
}
