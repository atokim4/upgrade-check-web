// Types for the `node:path` alias (see vite.config.ts and src/lib/path-shim.ts).
declare module "node:path" {
  export { basename, extname, normalize, posix } from "./lib/path-shim.ts";
}
