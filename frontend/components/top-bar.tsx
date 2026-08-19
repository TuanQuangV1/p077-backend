"use client"

import { CircleDotIcon, RadioIcon } from "lucide-react"

import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ThemeToggle } from "@/components/theme-toggle"
import { useLiveStream } from "@/hooks/use-live-stream"
import { cn } from "@/lib/utils"

/**
 * Persistent status strip. The live pill is driven by the same SSE channel the
 * rest of the app consumes, so "connected" here means telemetry is really
 * flowing, not just that the page loaded.
 */
export function TopBar() {
  const { connected, ticks, job } = useLiveStream({ logLimit: 1, tickLimit: 2 })
  const last = ticks[ticks.length - 1]

  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur-sm">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 !h-4" />

      <div className="flex min-w-0 items-center gap-2">
        <RadioIcon className={cn("size-3.5 shrink-0", connected ? "text-ok" : "text-muted-foreground")} />
        <span className="font-mono text-xs text-muted-foreground">
          {connected ? "luồng trực tiếp (live)" : "luồng nhàn rỗi (idle)"}
          <span className="hidden sm:inline"> · /ws?topics=jobs,logs,vllm</span>
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
            <span className="hidden text-muted-foreground md:inline">
              gpu <span className="text-foreground">{last.gpuUtil.toFixed(0)}%</span>
            </span>
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
        <ThemeToggle />
      </div>
    </header>
  )
}
