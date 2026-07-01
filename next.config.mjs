/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // sql.js ships an emscripten UMD glue that breaks when webpacked into the
  // server bundle ("Cannot set properties of undefined (setting 'exports')").
  // Keep it external so Next requires it from node_modules at runtime.
  serverExternalPackages: ["sql.js"],
  // sql.js ships a .wasm file we load at runtime; make sure webpack doesn't try
  // to bundle the node-only `fs`/`path` fallbacks into the client build.
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    return config;
  },
};

export default nextConfig;
