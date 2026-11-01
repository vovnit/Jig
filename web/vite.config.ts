import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

// META_API_KEY from the repo's .env stays on the dev server: the proxy adds it to model
// requests, so the playground can build apps without anyone pasting a key into it.
const key = loadEnv("development", fileURLToPath(new URL("..", import.meta.url)), "").META_API_KEY;

export default defineConfig({
  define: { __DEV_MODEL_KEY__: JSON.stringify(Boolean(key)) },
  plugins: [tapePlugin()],
  // Bundled sounds (`@chime` and the like) are served at /sounds/<name>.wav from the repo's assets folder.
  publicDir: fileURLToPath(new URL("../assets", import.meta.url)),
  // sqlite-wasm loads its .wasm next to its own module, which prebundling would break.
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  // The browser would need CORS headers from the Meta Model API; the playground goes through the dev server instead.
  server: {
    // Saving a recorded tape must not reload the page, which would start the demo again.
    watch: { ignored: ["**/demo/tapes/**"] },
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

/** Dev-only: saves a recorded demo tape (`POST /__jig/tape?name=<name>`) to `demo/tapes/`. */
function tapePlugin(): Plugin {
  return {
    name: "jig-tape",
    configureServer(server) {
      server.middlewares.use("/__jig/tape", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method not allowed");
          return;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const name = url.searchParams.get("name") ?? "";
        if (!/^[a-z0-9-]+$/.test(name)) {
          res.statusCode = 400;
          res.end("Bad tape name");
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            const body = raw ? JSON.parse(raw) : {};
            const dir = fileURLToPath(new URL("../demo/tapes/", import.meta.url));
            mkdirSync(dir, { recursive: true });
            writeFileSync(`${dir}${name}.json`, `${JSON.stringify(body, null, 2)}\n`);
            res.statusCode = 200;
            res.end("{}");
          } catch (e) {
            res.statusCode = 400;
            res.end(String((e as Error)?.message ?? e));
          }
        });
      });
    },
  };
}
