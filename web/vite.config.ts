import { defineConfig } from "vite";

export default defineConfig({
  // sqlite-wasm loads its .wasm next to its own module, which prebundling would break.
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  // The browser would need CORS headers from the Meta Model API; the playground goes through the dev server instead.
  server: { proxy: { "/meta-api": { target: "https://api.meta.ai", changeOrigin: true, rewrite: (p) => p.replace(/^\/meta-api/, "") } } },
});
