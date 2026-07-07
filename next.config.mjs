/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // sql.js ships an emscripten UMD glue that breaks when webpacked into the
  // server bundle ("Cannot set properties of undefined (setting 'exports')").
  // Keep it external so Next requires it from node_modules at runtime.
  serverExternalPackages: ["sql.js"],
  // sql.js loads its .wasm at runtime via a constructed fs path, so Next's file
  // tracer can't see it. Force-include it (+ the wasm-JS glue) in the serverless
  // function bundle so gear-asset SQLite queries work on Vercel.
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/sql.js/dist/sql-wasm.wasm"],
  },
  // sql.js ships a .wasm file we load at runtime; make sure webpack doesn't try
  // to bundle the node-only `fs`/`path` fallbacks into the client build.
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    return config;
  },
  // Baseline security headers. A full Content-Security-Policy is intentionally
  // deferred (needs per-env tuning for Next dev's eval + WebGL/blob usage) and
  // is documented in SECURITY.md as a follow-up.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
