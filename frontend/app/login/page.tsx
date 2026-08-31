"use client"

import { ThemeToggle } from "@/components/theme-toggle"
import { AuthBrandingPanel } from "@/components/auth/auth-branding-panel"
import { LoginForm } from "@/components/auth/login-form"

export default function LoginPage() {
  return (
    <div className="relative flex h-screen max-h-screen w-full flex-col justify-between overflow-hidden bg-background">
      {/* Background Ambient Glow & Cyber Grid */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-20%,rgba(14,165,233,0.12),transparent_70%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:3.5rem_3.5rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)]" />

      {/* Floating Top Header */}
      <header className="relative z-10 flex h-12 shrink-0 w-full items-center justify-between px-6 lg:px-10 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <div className="flex size-2 rounded-full bg-primary animate-pulse" />
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            ROS2 Autonomous Diagnostics Suite
          </span>
        </div>

        <div className="flex items-center gap-3">
          <ThemeToggle />
        </div>
      </header>

      {/* Main Container - Master Unified Card */}
      <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 min-h-0 items-center justify-center p-3 sm:p-4 lg:p-6">
        <div className="grid h-full max-h-[580px] w-full grid-cols-1 overflow-hidden rounded-3xl border border-border/80 bg-card/85 shadow-2xl backdrop-blur-2xl lg:grid-cols-12">
          {/* Left Column: Branding & Gyro Visual */}
          <div className="flex h-full w-full flex-col justify-between border-b border-border/60 bg-gradient-to-br from-primary/5 via-transparent to-cyan-500/5 p-6 lg:border-b-0 lg:border-r lg:col-span-7 lg:p-8">
            <AuthBrandingPanel />
          </div>

          {/* Right Column: Clean Login Form */}
          <div className="flex h-full w-full flex-col justify-between bg-card/40 p-6 lg:col-span-5 lg:p-8">
            <LoginForm />
          </div>
        </div>
      </main>

      {/* Bottom Global Status Bar */}
      <footer className="relative z-10 flex h-10 shrink-0 w-full items-center justify-between border-t border-border/40 px-6 font-mono text-[11px] text-muted-foreground backdrop-blur-sm lg:px-10">
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          <span>RAV-13 Enterprise · Version 1.0.4</span>
        </div>
        <div className="hidden sm:block">
          <span>Robotics Autonomous Vehicle Diagnostics · VinAI</span>
        </div>
      </footer>
    </div>
  )
}
