"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import {
  AlertCircleIcon,
  ArrowRightIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  LockIcon,
  LogInIcon,
  ShieldCheckIcon,
  UserIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { login, verifyToken, getAuthToken } from "@/lib/api"

export function LoginForm() {
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [rememberMe, setRememberMe] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string; general?: string }>({})

  // Load remembered username if present
  useEffect(() => {
    try {
      const savedUser = localStorage.getItem("rav_remembered_username")
      if (savedUser) {
        setUsername(savedUser)
      }
    } catch {
      // ignore localStorage errors
    }
  }, [])

  // Auto-redirect if already logged in
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      if (!cancelled) setChecking(false)
    }, 2000)
    const token = getAuthToken()
    if (!token) {
      clearTimeout(t)
      setChecking(false)
      return
    }
    verifyToken()
      .then((res) => {
        if (!cancelled) {
          if (res.valid) router.replace("/")
          else setChecking(false)
        }
      })
      .catch(() => {
        if (!cancelled) setChecking(false)
      })
      .finally(() => clearTimeout(t))
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [router])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFieldErrors({})

    const errors: { username?: string; password?: string } = {}
    if (!username.trim()) {
      errors.username = "Please enter your email or username"
    }
    if (!password) {
      errors.password = "Please enter your password"
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      toast.error("Please provide valid authentication credentials")
      return
    }

    setLoading(true)
    try {
      const data = await login(username, password)
      if (rememberMe) {
        localStorage.setItem("rav_remembered_username", username)
      } else {
        localStorage.removeItem("rav_remembered_username")
      }
      toast.success("Authentication successful", { description: `Welcome back, ${data.username}!` })
      router.push("/")
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Authentication failed"
      setFieldErrors({ general: "Invalid credentials or unauthorized account." })
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  const handleForgotPassword = () => {
    toast.info("Password Recovery", {
      description: "In development/local environments, operator credentials are configured via AUTH_PASSWORD in the .env file.",
    })
  }

  if (checking) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <Loader2Icon className="size-6 animate-spin text-primary" />
          <p className="font-mono text-xs text-muted-foreground">Verifying active session...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col justify-center space-y-6">
      {/* Header */}
      <div className="space-y-1.5 text-left">
        <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Sign In
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
          Access autonomous diagnostics & fleet telemetry workspace
        </p>
      </div>

      {/* General Error Banner */}
      {fieldErrors.general && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertCircleIcon className="size-4 shrink-0" />
          <span>{fieldErrors.general}</span>
        </div>
      )}

      {/* Main Login Form */}
      <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form" autoComplete="on">
        {/* Username / Email */}
        <div className="space-y-1.5">
          <Label htmlFor="username" className="text-xs font-semibold text-foreground">
            Email / Username
          </Label>
          <div className="relative">
            <UserIcon className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="username"
              name="username"
              data-testid="login-username"
              placeholder="admin or operator@company.com"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
                if (fieldErrors.username) setFieldErrors({ ...fieldErrors, username: undefined })
              }}
              autoComplete="username"
              autoFocus
              className={`h-10 pl-10 font-sans text-sm transition-colors ${
                fieldErrors.username ? "border-destructive focus-visible:ring-destructive/30" : ""
              }`}
            />
          </div>
          {fieldErrors.username && (
            <p className="text-[11px] font-medium text-destructive">{fieldErrors.username}</p>
          )}
        </div>

        {/* Password */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password" className="text-xs font-semibold text-foreground">
              Password
            </Label>
            <button
              type="button"
              onClick={handleForgotPassword}
              className="text-xs text-primary hover:underline font-medium"
            >
              Forgot password?
            </button>
          </div>
          <div className="relative">
            <LockIcon className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="password"
              name="password"
              data-testid="login-password"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                if (fieldErrors.password) setFieldErrors({ ...fieldErrors, password: undefined })
              }}
              autoComplete="current-password"
              className={`h-10 pl-10 pr-10 font-mono text-sm transition-colors ${
                fieldErrors.password ? "border-destructive focus-visible:ring-destructive/30" : ""
              }`}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              tabIndex={-1}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showPassword ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
            </button>
          </div>
          {fieldErrors.password && (
            <p className="text-[11px] font-medium text-destructive">{fieldErrors.password}</p>
          )}
        </div>

        {/* Remember Me Checkbox */}
        <div className="flex items-center space-x-2 py-0.5">
          <Checkbox
            id="remember"
            checked={rememberMe}
            onCheckedChange={(checked) => setRememberMe(!!checked)}
          />
          <label
            htmlFor="remember"
            className="text-xs font-medium leading-none text-muted-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer select-none"
          >
            Remember me
          </label>
        </div>

        {/* Submit Button */}
        <Button
          type="submit"
          className="h-10.5 w-full gap-2 text-sm font-semibold shadow-lg shadow-primary/20 transition-all hover:shadow-primary/30"
          disabled={loading}
          data-testid="login-submit"
        >
          {loading ? (
            <>
              <Loader2Icon className="size-4 animate-spin" />
              <span>Signing in...</span>
            </>
          ) : (
            <>
              <LogInIcon className="size-4" />
              <span>Sign In</span>
            </>
          )}
        </Button>
      </form>

      {/* Footer Links & Security Indicator */}
      <div className="space-y-3 pt-2 border-t border-border/50">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Need an account?</span>
          <Link
            href="/signup"
            className="flex items-center gap-1 font-medium text-primary hover:underline"
            data-testid="link-signup"
          >
            <span>Create account</span>
            <ArrowRightIcon className="size-3" />
          </Link>
        </div>

        <div className="flex items-center justify-center gap-1.5 font-mono text-[10px] text-muted-foreground/80">
          <ShieldCheckIcon className="size-3 text-emerald-500" />
          <span>JWT 256-bit Encrypted Session · TLS 1.3</span>
        </div>
      </div>
    </div>
  )
}
