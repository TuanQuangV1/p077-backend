/** @type {import('next').NextConfig} */
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
                destination: "http://127.0.0.1:8000/api/v1/:path*",
            },
        ]
    },
}

export default nextConfig
