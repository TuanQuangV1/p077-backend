"use client"

import * as React from "react"

export type Theme = "light" | "dark" | "system"

export interface ThemeContextType {
  theme: string
  setTheme: (theme: string) => void
  forcedTheme?: string
  resolvedTheme: "light" | "dark"
  themes: string[]
  systemTheme?: "light" | "dark"
}

const ThemeContext = React.createContext<ThemeContextType>({
  theme: "dark",
  setTheme: () => {},
  resolvedTheme: "dark",
  themes: ["light", "dark", "system"],
  systemTheme: "dark",
})

export function useTheme() {
  return React.useContext(ThemeContext)
}

export interface ThemeProviderProps {
  children: React.ReactNode
  attribute?: string
  defaultTheme?: string
  enableSystem?: boolean
  storageKey?: string
  disableTransitionOnChange?: boolean
  forcedTheme?: string
  themes?: string[]
}

export function ThemeProvider({
  children,
  attribute = "class",
  defaultTheme = "dark",
  enableSystem = true,
  storageKey = "theme",
  disableTransitionOnChange = false,
  forcedTheme,
  themes = ["light", "dark", "system"],
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<string>(() => {
    if (typeof window === "undefined") return defaultTheme
    try {
      return localStorage.getItem(storageKey) || defaultTheme
    } catch {
      return defaultTheme
    }
  })

  const [systemTheme, setSystemTheme] = React.useState<"light" | "dark">("dark")

  React.useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    setSystemTheme(mediaQuery.matches ? "dark" : "light")

    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light")
    }

    mediaQuery.addEventListener("change", handler)
    return () => mediaQuery.removeEventListener("change", handler)
  }, [])

  const resolvedTheme: "light" | "dark" = forcedTheme
    ? (forcedTheme as "light" | "dark")
    : theme === "system"
      ? systemTheme
      : (theme as "light" | "dark") || "dark"

  const applyTheme = React.useCallback(
    (targetTheme: "light" | "dark") => {
      const root = document.documentElement
      if (disableTransitionOnChange) {
        root.classList.add("no-transitions")
      }

      if (attribute === "class") {
        root.classList.remove("light", "dark")
        root.classList.add(targetTheme)
      } else {
        root.setAttribute(attribute, targetTheme)
      }

      root.style.colorScheme = targetTheme

      if (disableTransitionOnChange) {
        window.getComputedStyle(root).opacity
        requestAnimationFrame(() => {
          root.classList.remove("no-transitions")
        })
      }
    },
    [attribute, disableTransitionOnChange]
  )

  React.useEffect(() => {
    applyTheme(resolvedTheme)
  }, [resolvedTheme, applyTheme])

  const setTheme = React.useCallback(
    (newTheme: string) => {
      setThemeState(newTheme)
      try {
        localStorage.setItem(storageKey, newTheme)
      } catch {}
    },
    [storageKey]
  )

  const value = React.useMemo<ThemeContextType>(
    () => ({
      theme,
      setTheme,
      forcedTheme,
      resolvedTheme,
      themes,
      systemTheme,
    }),
    [theme, setTheme, forcedTheme, resolvedTheme, themes, systemTheme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
