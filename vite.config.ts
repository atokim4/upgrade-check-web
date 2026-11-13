import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { deadlinePages, TEMPLATE } from "./build/deadline-pages.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // The synced engines import basename/extname/posix from node:path; the browser gets a small shim.
  resolve: { alias: { "node:path": here("./src/lib/path-shim.ts") } },
  // Several real HTML pages, no SPA fallback: an unknown path is a 404.
  appType: "mpa",
  plugins: [deadlinePages()],
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: here("./index.html"),
        deadlines: here("./deadlines/index.html"),
        page: here(`./${TEMPLATE}`),
      },
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
