/** @type {import('next').NextConfig} */
const nextConfig = {
    output: "standalone",
    distDir: ".next",
    turbopack: {
        root: process.cwd(),
    },
    typescript: {
        ignoreBuildErrors: true,
    },
    images: {
        unoptimized: true,
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
