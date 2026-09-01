import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// Public paths that don't require auth
const PUBLIC_PATHS = ["/login", "/signup", "/slides.html", "/api/v1/auth/login", "/api/v1/auth/signup", "/api/v1/auth/verify", "/_next", "/favicon.ico", "/icon.svg", "/apple-icon.png"]

function isPublic(pathname: string): boolean {
    if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true
    if (pathname.startsWith("/_next/")) return true
    if (pathname.startsWith("/api/v1/auth/")) return true
    return false
}

export default function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl
    if (isPublic(pathname)) return NextResponse.next()
    const token = request.cookies.get("auth_token")?.value || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    if (!token) {
        if (pathname.startsWith("/api/")) {
            return NextResponse.json({ detail: "invalid or missing JWT token" }, { status: 401 })
        }
        const url = request.nextUrl.clone()
        url.pathname = "/login"
        url.searchParams.set("from", pathname)
        return NextResponse.redirect(url)
    }
    return NextResponse.next()
}

// Keep middleware export for backwards compat (Next 15)
export function middleware(request: NextRequest) {
    return proxy(request)
}

export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
