/** @type {import('next').NextConfig} */
const backendOrigin = (
    process.env.API_PROXY_TARGET ||
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.BACKEND_URL ||
    "http://127.0.0.1:8000"
).replace(/\/+$/, "")

// The browser only talks to the backend directly when NEXT_PUBLIC_API_URL is
// set (multipart uploads bypass the rewrite proxy); otherwise every call is
// same-origin. Add that origin to connect-src so the CSP doesn't block it.
const publicApiOrigin = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/+$/, "")

// Recharts and the dashboard components set element styles inline, and Next's
// hydration bootstrap is an inline script, so 'unsafe-inline' is required until
// a nonce pipeline is added. The policy still blocks external script/style
// injection, framing, base-tag hijacking and form exfiltration. Shipped as
// Report-Only first (see plan_final.md Phase 2) — flip the header key to
// `Content-Security-Policy` to enforce.
const contentSecurityPolicy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${publicApiOrigin ? ` ${publicApiOrigin}` : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
].join("; ")

const securityHeaders = [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
    { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy },
]
const nextConfig = {
    output: "standalone",
    distDir: ".next",
    turbopack: {
        root: process.cwd(),
    },
    typescript: {
        ignoreBuildErrors: false,
    },
    images: {
        unoptimized: true,
    },
    experimental: {
        // Backend allows uploads up to MAX_UPLOAD_BYTES (1 GiB by default).
        // Next.js 16 silently truncates proxied request bodies at 10 MB and
        // returns a misleading 500/"socket hang up" for multipart uploads.
        // Match the backend limit so rosbag uploads of any size survive the
        // dev rewrite proxy.
        proxyClientMaxBodySize: "1gb",
        proxyTimeout: 300000,
    },
    async rewrites() {
        return [
            {
                source: "/api/v1/:path*",
                destination: `${backendOrigin}/api/v1/:path*`,
            },
        ]
    },
    async headers() {
        return [{ source: "/:path*", headers: securityHeaders }]
    },
}

export default nextConfig
