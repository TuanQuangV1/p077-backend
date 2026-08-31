"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { CircleDotIcon, LogOutIcon, RadioIcon } from "lucide-react"

import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { useLiveStream } from "@/hooks/use-live-stream"
import { cn } from "@/lib/utils"
import { getAuthToken, logout, verifyToken } from "@/lib/api"

/**
 * Persistent status strip. The live pill is driven by the same SSE channel the
 * rest of the app consumes, so "connected" here means telemetry is really
 * flowing, not just that the page loaded.
 */
export function TopBar() {
  const { connected, ticks, job } = useLiveStream({ logLimit: 1, tickLimit: 2 })
  const last = ticks[ticks.length - 1]
  const [auth, setAuth] = useState<{ valid: boolean; username: string | null }>({ valid: false, username: null })

  useEffect(() => {
    const token = getAuthToken()
    if (!token) {
      setAuth({ valid: false, username: null })
      return
    }
    verifyToken().then((res) => setAuth({ valid: res.valid, username: res.username })).catch(() => setAuth({ valid: false, username: null }))
    const handler = () => {
      const t = getAuthToken()
      if (!t) setAuth({ valid: false, username: null })
    }
    window.addEventListener("storage", handler)
    return () => window.removeEventListener("storage", handler)
  }, [])

  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur-sm">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 !h-4" />

      <div className="flex min-w-0 items-center gap-2">
        <RadioIcon className={cn("size-3.5 shrink-0", connected ? "text-ok" : "text-muted-foreground")} />
        <span className="font-mono text-xs text-muted-foreground">
          {connected ? "trực tiếp" : "nhàn rỗi"}
          <span className="hidden sm:inline"> · /ws?topics=jobs,logs,llm</span>
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3 font-mono text-xs">
        {job ? (
          <span className="hidden items-center gap-1.5 text-muted-foreground lg:flex">
            <CircleDotIcon className="size-3 text-primary" />
            {job.stage}
            <span className="text-foreground">{job.progress.toFixed(0)}%</span>
          </span>
        ) : null}
        {last ? (
          <>
            <span className="hidden text-muted-foreground sm:inline">
              tok/s <span className="text-foreground">{last.tokensPerSec}</span>
            </span>
            <span className="text-muted-foreground">
              hàng đợi <span className="text-foreground">{last.queueLen}</span>
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">đang chờ dữ liệu…</span>
        )}
        <Separator orientation="vertical" className="!h-4" />
        {auth.valid ? (
          <div className="flex items-center gap-2">
            <span className="hidden font-mono text-xs text-muted-foreground sm:inline" data-testid="topbar-user">
              {auth.username}
            </span>
            <Button variant="ghost" size="sm" onClick={() => logout()} data-testid="topbar-logout" className="h-7 px-2 text-xs">
              <LogOutIcon className="mr-1 size-3" />
              Đăng xuất
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button render={<Link href="/login" />} variant="ghost" size="sm" className="h-7 px-2 text-xs" data-testid="topbar-login">
              Đăng nhập
            </Button>
            <Button render={<Link href="/signup" />} size="sm" className="h-7 px-2 text-xs" data-testid="topbar-signup">
              Đăng ký
            </Button>
          </div>
        )}
        <ThemeToggle />
      </div>
    </header>
  )
}
