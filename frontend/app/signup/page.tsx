"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { UserPlusIcon, ShieldCheckIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { signup, verifyToken, getAuthToken } from "@/lib/api"

export default function SignupPage() {
    const router = useRouter()
    const [username, setUsername] = useState("")
    const [password, setPassword] = useState("")
    const [confirm, setConfirm] = useState("")
    const [loading, setLoading] = useState(false)
    const [checking, setChecking] = useState(true)

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

    const handleAutofill = async () => {
        const demoUser = "admin"
        const demoPass = "test-pass"
        setUsername(demoUser)
        setPassword(demoPass)
        setConfirm(demoPass)
        toast.info("Đã điền demo: admin / test-pass - đang đăng ký...")
        setLoading(true)
        try {
            // Try signup, if already exists (admin), fallback to login
            try {
                const data = await signup(demoUser, demoPass, demoPass)
                toast.success("Đăng ký thành công", { description: `Chào ${data.username}!` })
                router.replace("/")
                return
            } catch (err) {
                const msg = err instanceof Error ? err.message : ""
                if (msg.includes("already exists") || msg.includes("409")) {
                    // Fallback to login for demo admin
                    const { login } = await import("@/lib/api")
                    const data = await login(demoUser, demoPass)
                    toast.success("Đăng nhập thành công (demo đã tồn tại)", { description: `Chào ${data.username}!` })
                    router.replace("/")
                    return
                }
                throw err
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Đăng ký thất bại"
            toast.error(msg)
        } finally {
            setLoading(false)
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!username || !password || !confirm) {
            toast.error("Vui lòng nhập đầy đủ username, password và xác nhận")
            return
        }
        if (password !== confirm) {
            toast.error("Mật khẩu xác nhận không khớp")
            return
        }
        setLoading(true)
        try {
            const data = await signup(username, password, confirm)
            toast.success("Đăng ký thành công", { description: `Chào ${data.username}!` })
            router.push("/")
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Đăng ký thất bại"
            toast.error(msg)
        } finally {
            setLoading(false)
        }
    }

    if (checking) {
        return (
            <div className="grid min-h-[calc(100vh-3rem)] place-items-center p-4">
                <p className="font-mono text-sm text-muted-foreground">Đang kiểm tra phiên đăng nhập...</p>
            </div>
        )
    }

    return (
        <div className="grid min-h-[calc(100vh-3rem)] place-items-center p-4 bg-background">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
                        <ShieldCheckIcon className="size-5" />
                    </div>
                    <CardTitle className="text-xl">Đăng ký RAV-13</CardTitle>
                    <CardDescription>Tạo tài khoản mới (fake, không ràng buộc) để nhận JWT</CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSubmit} className="grid gap-4" data-testid="signup-form" autoComplete="on">
                        <div className="grid gap-2">
                            <Label htmlFor="username">Username</Label>
                            <Input
                                id="username"
                                name="username"
                                data-testid="signup-username"
                                placeholder="myuser"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                autoComplete="username"
                                autoFocus
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="password">Password</Label>
                            <Input
                                id="password"
                                name="password"
                                data-testid="signup-password"
                                type="password"
                                placeholder="••••••••"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete="new-password"
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="confirm">Xác nhận mật khẩu</Label>
                            <Input
                                id="confirm"
                                name="confirm"
                                data-testid="signup-confirm"
                                type="password"
                                placeholder="••••••••"
                                value={confirm}
                                onChange={(e) => setConfirm(e.target.value)}
                                autoComplete="new-password"
                            />
                        </div>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" className="flex-1" onClick={handleAutofill} data-testid="signup-autofill">
                                Điền demo
                            </Button>
                            <Button type="submit" className="flex-1" disabled={loading} data-testid="signup-submit">
                                <UserPlusIcon data-icon="inline-start" className="size-4" />
                                {loading ? "Đang đăng ký..." : "Đăng ký"}
                            </Button>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">Đã có tài khoản?</span>
                            <Link href="/login" className="text-primary hover:underline" data-testid="link-login">
                                Đăng nhập
                            </Link>
                        </div>
                        <p className="text-center font-mono text-[11px] text-muted-foreground">
                            Tài khoản được lưu in-memory, không ràng buộc, chỉ để demo
                        </p>
                    </form>
                </CardContent>
            </Card>
        </div>
    )
}
