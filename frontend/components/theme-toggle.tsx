"use client"

import * as React from "react"
import { MoonIcon, SunIcon, LaptopIcon } from "lucide-react"
import { useTheme } from "@/components/theme-provider"

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return <div className="size-7" />
  }

  const cycleTheme = () => {
    if (theme === "dark") setTheme("light")
    else if (theme === "light") setTheme("system")
    else setTheme("dark")
  }

  return (
    <button
      type="button"
      onClick={cycleTheme}
      className="inline-flex size-7 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
      title={`Active theme: ${theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System"}. Click to toggle.`}
    >
      {theme === "dark" ? (
        <MoonIcon className="size-3.5" />
      ) : theme === "light" ? (
        <SunIcon className="size-3.5" />
      ) : (
        <LaptopIcon className="size-3.5" />
      )}
      <span className="sr-only">Toggle theme</span>
    </button>
  )
}
