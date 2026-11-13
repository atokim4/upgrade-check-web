import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // The synced engines import basename/extname/posix from node:path; the browser gets a small shim.
  resolve: { alias: { "node:path": fileURLToPath(new URL("./src/lib/path-shim.ts", import.meta.url)) } },
  build: { target: "es2022", sourcemap: false },
  test: { include: ["test/**/*.test.ts"] },
});
