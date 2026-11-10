import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022", sourcemap: false },
  test: { include: ["test/**/*.test.ts"] },
});
