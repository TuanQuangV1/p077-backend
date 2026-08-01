/** @type {import('next').NextConfig} */
const nextConfig = {
    output: "standalone",
    turbopack: {
        root: process.cwd(),
    },
    typescript: {
        ignoreBuildErrors: true,
    },
    images: {
        unoptimized: true,
    },
}

export default nextConfig
