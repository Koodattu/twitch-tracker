import { fileURLToPath } from "node:url";

const apiProxyTarget = process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  reactStrictMode: true,
  cacheMaxMemorySize: 50 * 1024 * 1024,
  experimental: {
    // The container's tmpfs cannot retain an unbounded fetch cache.
    isrFlushToDisk: false
  },
  turbopack: {
    root: workspaceRoot
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiProxyTarget}/api/:path*`
      }
    ];
  }
};

export default nextConfig;
