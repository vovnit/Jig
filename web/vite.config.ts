import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// META_API_KEY from the repo's .env stays on the dev server: the proxy adds it to model
// requests, so the playground can build apps without anyone pasting a key into it.
const key = loadEnv("development", fileURLToPath(new URL("..", import.meta.url)), "").META_API_KEY;

export default defineConfig({
  define: { __DEV_MODEL_KEY__: JSON.stringify(Boolean(key)) },
  // sqlite-wasm loads its .wasm next to its own module, which prebundling would break.
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  // The browser would need CORS headers from the Meta Model API; the playground goes through the dev server instead.
  server: {
    proxy: {
      "/meta-api": {
        target: "https://api.meta.ai",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/meta-api/, ""),
        configure: (proxy) => {
          if (key) proxy.on("proxyReq", (req) => req.setHeader("Authorization", `Bearer ${key}`));
        },
      },
    },
  },
});
