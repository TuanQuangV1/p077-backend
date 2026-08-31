"use client"

import {
  ActivityIcon,
  BotIcon,
  CpuIcon,
  RadioIcon,
  ScanIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react"

export function RobotPipelineVisual() {
  return (
    <div className="relative flex w-full flex-col items-center justify-center py-2 select-none">
      {/* Visual Canvas Container */}
      <div className="relative flex h-72 w-full max-w-[340px] items-center justify-center">
        
        {/* Background Radar Conic Sweep (Clockwise - 3s) */}
        <div className="pointer-events-none absolute size-60 rounded-full bg-[conic-gradient(from_0deg,transparent_0_300deg,rgba(14,165,233,0.25)_360deg)] animate-[radar-fast_3s_linear_infinite]" />

        {/* Opposite Sweep Wave (Counter-Clockwise - 4.5s) */}
        <div className="pointer-events-none absolute size-52 rounded-full bg-[conic-gradient(from_180deg,transparent_0_310deg,rgba(6,182,212,0.2)_360deg)] animate-[spin-reverse_4.5s_linear_infinite]" />

        {/* Outer Orbit Track */}
        <div className="absolute size-64 rounded-full border-2 border-dashed border-primary/40 dark:border-primary/30 animate-[radar-fast_10s_linear_infinite]" />

        {/* Middle Gyro Ring */}
        <div className="absolute size-52 rounded-full border border-dashed border-cyan-500/50 dark:border-cyan-400/40 animate-[spin-reverse_6s_linear_infinite]">
          {/* Orbital Data Particles */}
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 size-2 rounded-full bg-cyan-400 shadow-[0_0_10px_#22d3ee]" />
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 size-2 rounded-full bg-primary shadow-[0_0_10px_#0ea5e9]" />
        </div>

        {/* Inner Gyro Ring with Amber/Purple particles */}
        <div className="absolute size-40 rounded-full border border-dashed border-amber-500/40 dark:border-amber-400/30 animate-[radar-fast_4s_linear_infinite]">
          <div className="absolute top-1/2 -left-1 -translate-y-1/2 size-2 rounded-full bg-amber-400 shadow-[0_0_10px_#f59e0b]" />
          <div className="absolute top-1/2 -right-1 -translate-y-1/2 size-2 rounded-full bg-purple-400 shadow-[0_0_10px_#c084fc]" />
        </div>

        {/* Center Wave Pulsing Halo */}
        <div className="absolute size-36 rounded-full border border-primary/50 bg-primary/10 animate-ping [animation-duration:2.5s] opacity-25" />

        {/* High-Contrast SVG Connecting Beams */}
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 340 288">
          {/* Crosshairs */}
          <line x1="170" y1="10" x2="170" y2="278" stroke="currentColor" className="text-border/70 dark:text-border/40" strokeWidth="1.5" strokeDasharray="4 4" />
          <line x1="10" y1="144" x2="330" y2="144" stroke="currentColor" className="text-border/70 dark:text-border/40" strokeWidth="1.5" strokeDasharray="4 4" />

          {/* Flowing Laser Data Streams into Center */}
          <line x1="170" y1="36" x2="170" y2="105" stroke="#0ea5e9" strokeWidth="2.5" strokeDasharray="6 4" className="animate-[dash_0.8s_linear_infinite]" />
          <line x1="170" y1="252" x2="170" y2="183" stroke="#0ea5e9" strokeWidth="2.5" strokeDasharray="6 4" className="animate-[dash_0.8s_linear_infinite]" />
          <line x1="38" y1="144" x2="115" y2="144" stroke="#f59e0b" strokeWidth="2.5" strokeDasharray="6 4" className="animate-[dash_0.8s_linear_infinite]" />
          <line x1="302" y1="144" x2="225" y2="144" stroke="#06b6d4" strokeWidth="2.5" strokeDasharray="6 4" className="animate-[dash_0.8s_linear_infinite]" />
        </svg>

        {/* Central Core: RAV ENGINE */}
        <div className="relative z-10 flex size-24 items-center justify-center rounded-2xl border-2 border-primary/70 bg-card shadow-[0_4px_25px_rgba(14,165,233,0.35)] backdrop-blur-2xl transition-transform hover:scale-105">
          {/* Micro-Gear Ring */}
          <div className="absolute -inset-1.5 rounded-2xl border border-dashed border-primary/40 animate-[radar-fast_5s_linear_infinite]" />
          <div className="absolute -inset-2 rounded-2xl bg-gradient-to-tr from-primary/25 to-cyan-400/25 blur-sm animate-pulse" />
          
          <div className="relative flex flex-col items-center justify-center text-center">
            <div className="relative">
              <CpuIcon className="size-7 text-primary animate-pulse" />
              <span className="absolute -right-1 -top-1 flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-90" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]" />
              </span>
            </div>
            <span className="mt-1 font-mono text-[10px] font-black tracking-widest text-foreground">
              RAV ENGINE
            </span>
          </div>
        </div>

        {/* 4 Crisp & Well-Positioned Sensor / AI Badges */}

        {/* 1. Top: /scan LiDAR */}
        <div className="absolute top-1 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full border border-primary/60 bg-card px-3 py-1 text-xs font-mono shadow-md backdrop-blur-md transition-all hover:scale-105 animate-[bounce_2.5s_ease-in-out_infinite]">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-80" />
            <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
          </span>
          <ScanIcon className="size-3 text-primary" />
          <span className="font-bold text-foreground">/scan</span>
          <span className="text-[9px] text-muted-foreground font-semibold">20Hz</span>
        </div>

        {/* 2. Right: /odom Odometry */}
        <div className="absolute right-0 top-1/2 -translate-y-1/2 z-20 flex items-center gap-1.5 rounded-full border border-cyan-500/60 bg-card px-3 py-1 text-xs font-mono shadow-md backdrop-blur-md transition-all hover:scale-105 animate-[bounce_2.5s_ease-in-out_0.6s_infinite]">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-80" />
            <span className="relative inline-flex size-1.5 rounded-full bg-cyan-500" />
          </span>
          <ActivityIcon className="size-3 text-cyan-500" />
          <span className="font-bold text-foreground">/odom</span>
          <span className="text-[9px] text-muted-foreground font-semibold">50Hz</span>
        </div>

        {/* 3. Bottom: AI Diagnostic LLM */}
        <div className="absolute bottom-1 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full border-2 border-primary/70 bg-primary/15 dark:bg-primary/20 px-3.5 py-1 text-xs font-mono text-primary shadow-lg backdrop-blur-md transition-all hover:scale-105 animate-[bounce_2.5s_ease-in-out_1.2s_infinite]">
          <SparklesIcon className="size-3.5 animate-spin [animation-duration:4s]" />
          <span className="font-bold tracking-wide">AI Diagnostic</span>
        </div>

        {/* 4. Left: /cmd_vel Controller */}
        <div className="absolute left-0 top-1/2 -translate-y-1/2 z-20 flex items-center gap-1.5 rounded-full border border-amber-500/60 bg-card px-3 py-1 text-xs font-mono shadow-md backdrop-blur-md transition-all hover:scale-105 animate-[bounce_2.5s_ease-in-out_1.8s_infinite]">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-80" />
            <span className="relative inline-flex size-1.5 rounded-full bg-amber-500" />
          </span>
          <RadioIcon className="size-3 text-amber-500" />
          <span className="font-bold text-foreground">/cmd_vel</span>
          <span className="text-[9px] text-muted-foreground font-semibold">10Hz</span>
        </div>
      </div>
    </div>
  )
}
