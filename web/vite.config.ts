import { defineConfig } from "vite";

export default defineConfig({
  // sqlite-wasm loads its .wasm next to its own module, which prebundling would break.
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
});
