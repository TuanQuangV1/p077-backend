"use client"

import {
  ActivityIcon,
  BotIcon,
  CheckCircle2Icon,
  CpuIcon,
  DatabaseIcon,
  ShieldCheckIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react"
import { RobotPipelineVisual } from "@/components/auth/robot-pipeline-visual"

export function AuthBrandingPanel() {
  return (
    <div className="relative flex h-full w-full flex-col justify-between overflow-hidden">
      {/* Subtle Background Glows */}
      <div className="pointer-events-none absolute -left-20 -top-20 size-64 rounded-full bg-primary/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-20 -right-20 size-64 rounded-full bg-cyan-500/15 blur-3xl" />

      {/* Centered Brand Header */}
      <div className="relative flex items-center justify-center gap-3 pt-2">
        <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/30 ring-1 ring-white/20">
          <ActivityIcon className="size-5" />
        </div>
        <div className="text-left">
          <h1 className="font-mono text-2xl font-black tracking-wider text-foreground leading-none">
            RAV-13
          </h1>
          <p className="font-mono text-xs text-muted-foreground tracking-tight mt-1">
            Robotics Analysis & Visualization
          </p>
        </div>
      </div>

      {/* Center Abstract Animated Gyro Graphic */}
      <div className="relative my-auto flex flex-1 w-full items-center justify-center py-4">
        <RobotPipelineVisual />
      </div>

      {/* Bottom Technical Pills */}
      <div className="relative flex flex-wrap items-center justify-center gap-2 pt-2">
        <div className="flex items-center gap-1.5 rounded-full border border-border/80 bg-background/60 px-3 py-1 font-mono text-[11px] text-muted-foreground backdrop-blur-sm">
          <ZapIcon className="size-3 text-primary" />
          <span>Zero-Copy MCAP</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-border/80 bg-background/60 px-3 py-1 font-mono text-[11px] text-muted-foreground backdrop-blur-sm">
          <SparklesIcon className="size-3 text-cyan-500" />
          <span>Rule Engine + LLM</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-border/80 bg-background/60 px-3 py-1 font-mono text-[11px] text-muted-foreground backdrop-blur-sm">
          <ShieldCheckIcon className="size-3 text-emerald-500" />
          <span>Human Review</span>
        </div>
      </div>
    </div>
  )
}
