"use client"

import { useEffect } from "react"
import { AlertTriangleIcon } from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"

/**
 * Route-segment error boundary. Without it, a throw during render or in a
 * client data fetch takes the whole route to a blank screen; here the user
 * gets a message and a way back.
 */
export default function Error({
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
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangleIcon className="size-6" />
      </div>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Đã xảy ra lỗi khi hiển thị trang</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Giao diện gặp sự cố khi dựng dữ liệu. Thử tải lại, hoặc quay về trang chủ.
        </p>
        {error.digest ? (
          <p className="font-mono text-[10px] text-muted-foreground/70">mã lỗi: {error.digest}</p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button onClick={reset}>Thử lại</Button>
        <a href="/" className={buttonVariants({ variant: "outline" })}>
          Về trang chủ
        </a>
      </div>
    </div>
  )
}
