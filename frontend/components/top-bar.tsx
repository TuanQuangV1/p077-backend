"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { CircleDotIcon, LogOutIcon, RadioIcon } from "lucide-react"

import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button, buttonVariants } from "@/components/ui/button"
import { useActiveRun } from "@/hooks/use-active-run"
import { cn } from "@/lib/utils"
import { getAuthToken, logout, verifyToken } from "@/lib/api"

/**
 * Persistent status strip. The live pill polls `GET /api/v1/runs`, so
 * "connected" means the backend answered and the job readout is the real
 * stage/progress of an analysis still in flight.
 */
export function TopBar() {
  const { connected, job } = useActiveRun()
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
          {connected ? "LIVE" : "IDLE"}
          <span className="hidden sm:inline"> · GET /api/v1/runs</span>
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3 font-mono text-xs">
        {job ? (
          <span className="hidden items-center gap-1.5 text-muted-foreground lg:flex">
            <CircleDotIcon className="size-3 text-primary animate-pulse" />
            {job.stage}
            <span className="text-foreground font-semibold">{job.progress.toFixed(0)}%</span>
          </span>
        ) : (
          <span className="hidden text-muted-foreground sm:inline">no run in flight</span>
        )}
        <Separator orientation="vertical" className="!h-4" />
        {auth.valid ? (
          <div className="flex items-center gap-2">
            <span className="hidden font-mono text-xs text-muted-foreground sm:inline" data-testid="topbar-user">
              {auth.username}
            </span>
            <Button variant="ghost" size="sm" onClick={() => logout()} data-testid="topbar-logout" className="h-7 px-2 text-xs cursor-pointer">
              <LogOutIcon className="mr-1 size-3" />
              Sign Out
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Link
              href="/login"
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-7 px-2 text-xs")}
              data-testid="topbar-login"
            >
              Sign In
            </Link>
            <Link
              href="/signup"
              className={cn(buttonVariants({ size: "sm" }), "h-7 px-2 text-xs")}
              data-testid="topbar-signup"
            >
              Sign Up
            </Link>
          </div>
        )}
        <ThemeToggle />
      </div>
    </header>
  )
}
