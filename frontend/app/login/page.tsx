"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { LogInIcon, ShieldCheckIcon } from "lucide-react"

import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { login, signup, verifyToken, getAuthToken } from "@/lib/api"

export default function LoginPage() {
    const router = useRouter()
    const [username, setUsername] = useState("")
    const [password, setPassword] = useState("")
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
        toast.info("Đã điền demo: admin / test-pass - đang đăng nhập...")
        setLoading(true)
        try {
            try {
                const data = await login(demoUser, demoPass)
                toast.success("Đăng nhập thành công", { description: `Chào ${data.username}!` })
                // Dùng hard navigation để đảm bảo cookie auth_token được gửi kèm request tiếp theo (tránh race với proxy middleware)
                window.location.href = "/"
                return
            } catch (err) {
                const msg = err instanceof Error ? err.message : ""
                // Nếu user chưa tồn tại (in-memory _USERS bị xóa sau docker restart) thì thử đăng ký rồi đăng nhập lại
                const isNotFound = /not found|invalid credentials|401/i.test(msg)
                if (!isNotFound) throw err
                await signup(demoUser, demoPass, demoPass)
                const data2 = await login(demoUser, demoPass)
                toast.success("Đăng ký & đăng nhập thành công", { description: `Chào ${data2.username}!` })
                window.location.href = "/"
                return
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Đăng nhập thất bại"
            // Hiển thị chi tiết lỗi để debug docker/env mismatch
            toast.error(msg, { description: "Kiểm tra AUTH_PASSWORD trong .env phải là 'test-pass' cho môi trường dev" })
        } finally {
            setLoading(false)
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!username || !password) {
            toast.error("Vui lòng nhập đầy đủ username và password")
            return
        }
        setLoading(true)
        try {
            const data = await login(username, password)
            toast.success("Đăng nhập thành công", { description: `Chào ${data.username}!` })
            router.push("/")
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Đăng nhập thất bại"
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
                    <CardTitle className="text-xl">Đăng nhập RAV-13</CardTitle>
                    <CardDescription>
                        Nhập tài khoản để nhận JWT key và truy cập hệ thống chẩn đoán rosbag
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSubmit} className="grid gap-4" data-testid="login-form" autoComplete="on">
                        <div className="grid gap-2">
                            <Label htmlFor="username">Username</Label>
                            <Input
                                id="username"
                                name="username"
                                data-testid="login-username"
                                placeholder="admin"
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
                                data-testid="login-password"
                                type="password"
                                placeholder="••••••••"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete="current-password"
                            />
                        </div>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                className="flex-1"
                                onClick={handleAutofill}
                                data-testid="login-autofill"
                            >
                                Điền demo
                            </Button>
                            <Button type="submit" className="flex-1" disabled={loading} data-testid="login-submit">
                                <LogInIcon data-icon="inline-start" className="size-4" />
                                {loading ? "Đang đăng nhập..." : "Đăng nhập"}
                            </Button>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">Chưa có tài khoản?</span>
                            <Link href="/signup" className="text-primary hover:underline" data-testid="link-signup">
                                Đăng ký
                            </Link>
                        </div>
                        <p className="text-center font-mono text-[11px] text-muted-foreground">
                            Token sẽ được lưu ở localStorage và gắn vào mọi request qua Authorization header
                        </p>
                    </form>
                </CardContent>
            </Card>
        </div>
    )
}
