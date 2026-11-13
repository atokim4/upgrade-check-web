import type { FixKind } from "./types.js";

/**
 * What each Deno.* API becomes on Node. `auto` entries are rewritten by source.ts; the rest are reported with the
 * replacement text. Shapes were checked against docs.deno.com/api/deno and nodejs.org/api.
 */
export interface ApiRule {
  fix: FixKind;
  replacement: string;
  why?: string;
  /** Rule id used in findings; defaults to "deno-api". */
  rule?: string;
}

export const API_RULES: Record<string, ApiRule> = {
  "env.get": { fix: "auto", replacement: "process.env[name]" },
  "env.set": { fix: "auto", replacement: "process.env[name] = value" },
  "env.has": { fix: "auto", replacement: "process.env[name] !== undefined" },
  "env.delete": { fix: "auto", replacement: "delete process.env[name]" },
  "env.toObject": { fix: "auto", replacement: "({ ...process.env })" },
  args: { fix: "auto", replacement: "process.argv.slice(2)" },
  exit: { fix: "auto", replacement: "process.exit()" },
  cwd: { fix: "auto", replacement: "process.cwd()" },
  chdir: { fix: "auto", replacement: "process.chdir()" },
  pid: { fix: "auto", replacement: "process.pid" },
  ppid: { fix: "auto", replacement: "process.ppid" },
  execPath: { fix: "auto", replacement: "process.execPath" },
  memoryUsage: { fix: "auto", replacement: "process.memoryUsage()" },
  hostname: { fix: "auto", replacement: "hostname() from node:os" },
  osRelease: { fix: "auto", replacement: "release() from node:os" },
  loadavg: { fix: "auto", replacement: "loadavg() from node:os" },
  inspect: { fix: "auto", replacement: "inspect() from node:util" },
  addSignalListener: { fix: "auto", replacement: "process.on(signal, handler)" },
  removeSignalListener: { fix: "auto", replacement: "process.off(signal, handler)" },
  readTextFile: { fix: "auto", replacement: 'readFile(path, "utf8") from node:fs/promises' },
  readTextFileSync: { fix: "auto", replacement: 'readFileSync(path, "utf8") from node:fs' },
  readFile: { fix: "auto", replacement: "readFile(path) from node:fs/promises" },
  readFileSync: { fix: "auto", replacement: "readFileSync(path) from node:fs" },
  writeTextFile: { fix: "auto", replacement: "writeFile(path, text) from node:fs/promises" },
  writeTextFileSync: { fix: "auto", replacement: "writeFileSync(path, text) from node:fs" },
  writeFile: { fix: "auto", replacement: "writeFile(path, data) from node:fs/promises" },
  writeFileSync: { fix: "auto", replacement: "writeFileSync(path, data) from node:fs" },
  mkdir: { fix: "auto", replacement: "mkdir(path, options) from node:fs/promises" },
  mkdirSync: { fix: "auto", replacement: "mkdirSync(path, options) from node:fs" },
  remove: { fix: "auto", replacement: "rm(path, { recursive: true }) from node:fs/promises" },
  removeSync: { fix: "auto", replacement: "rmSync(path, { recursive: true }) from node:fs" },
  rename: { fix: "auto", replacement: "rename() from node:fs/promises" },
  renameSync: { fix: "auto", replacement: "renameSync() from node:fs" },
  copyFile: { fix: "auto", replacement: "copyFile() from node:fs/promises" },
  copyFileSync: { fix: "auto", replacement: "copyFileSync() from node:fs" },
  realPath: { fix: "auto", replacement: "realpath() from node:fs/promises" },
  realPathSync: { fix: "auto", replacement: "realpathSync() from node:fs" },
  chmod: { fix: "auto", replacement: "chmod() from node:fs/promises" },
  symlink: { fix: "auto", replacement: "symlink(target, path) from node:fs/promises" },
  unrefTimer: { fix: "manual", replacement: "keep the Timeout object and call timeout.unref()", why: "Node timers are objects, not numeric ids" },
  refTimer: { fix: "manual", replacement: "timeout.ref() on the Timeout object" },
  truncate: { fix: "auto", replacement: "truncate() from node:fs/promises" },
  "errors.NotFound": { fix: "auto", replacement: 'error code "ENOENT"' },
  "errors.AlreadyExists": { fix: "auto", replacement: 'error code "EEXIST"' },
  "errors.PermissionDenied": { fix: "auto", replacement: 'error code "EACCES" / "EPERM"' },
  "errors.IsADirectory": { fix: "auto", replacement: 'error code "EISDIR"' },
  "errors.NotADirectory": { fix: "auto", replacement: 'error code "ENOTDIR"' },
  serve: { fix: "auto", replacement: "serve({ fetch, port }) from @hono/node-server" },
  test: { fix: "auto", replacement: 'test(name, fn) from "node:test"' },

  stat: {
    fix: "manual",
    replacement: "stat() from node:fs/promises, then call isFile() / isDirectory() as methods",
    why: "Deno's FileInfo.isFile is a boolean; Node's Stats.isFile is a method, so `if (info.isFile)` would always be true",
  },
  statSync: { fix: "manual", replacement: "statSync() from node:fs, isFile() / isDirectory() are methods", why: "FileInfo booleans vs Stats methods" },
  lstat: { fix: "manual", replacement: "lstat() from node:fs/promises, isSymbolicLink() is a method", why: "FileInfo booleans vs Stats methods" },
  lstatSync: { fix: "manual", replacement: "lstatSync() from node:fs", why: "FileInfo booleans vs Stats methods" },
  readDir: {
    fix: "manual",
    replacement: "readdir(path, { withFileTypes: true }) from node:fs/promises; isFile() / isDirectory() are methods on Dirent",
    why: "Deno.readDir is an async iterator of plain objects",
  },
  readDirSync: { fix: "manual", replacement: "readdirSync(path, { withFileTypes: true })", why: "iterator of plain objects vs Dirent[]" },
  open: { fix: "manual", replacement: "open() from node:fs/promises (FileHandle) or createReadStream/createWriteStream", why: "Deno.FsFile and FileHandle differ" },
  create: { fix: "manual", replacement: "open(path, \"w\") from node:fs/promises", why: "returns a Deno.FsFile" },
  makeTempDir: { fix: "auto", replacement: 'mkdtemp(join(tmpdir(), "prefix-")) from node:fs/promises + node:os' },
  makeTempDirSync: { fix: "auto", replacement: 'mkdtempSync(join(tmpdir(), "prefix-")) from node:fs + node:os' },
  makeTempFile: { fix: "manual", replacement: "mkdtemp() + a file name inside it" },
  watchFs: { fix: "manual", replacement: "watch() from node:fs/promises", why: "event shapes differ" },
  upgradeWebSocket: {
    fix: "manual",
    replacement: "ws (WebSocketServer({ noServer: true }) + the server's 'upgrade' event), or upgradeWebSocket from @hono/node-server with ws",
    why: "Node's HTTP server has no Request → WebSocket upgrade API",
  },
  Command: {
    fix: "manual",
    replacement: "execFile / spawn from node:child_process (promisify(execFile) for .output())",
    why: "output() returns { code, success, stdout: Uint8Array }",
  },
  run: { fix: "manual", replacement: "spawn() from node:child_process", why: "Deno.run was removed in Deno 2" },
  permissions: { fix: "manual", replacement: "delete the check, or run Node with --permission and --allow-fs-read/--allow-fs-write" },
  build: { fix: "manual", replacement: "process.platform / process.arch", why: 'Deno.build.os is "windows"/"darwin"/"linux"; process.platform is "win32"/"darwin"/"linux"' },
  version: { fix: "manual", replacement: "process.versions (process.versions.node)" },
  stdout: { fix: "manual", replacement: "process.stdout.write()", why: "Deno.stdout.write takes bytes and returns a promise" },
  stderr: { fix: "manual", replacement: "process.stderr.write()" },
  stdin: { fix: "manual", replacement: "process.stdin / node:readline/promises" },
  isatty: { fix: "manual", replacement: "isatty() from node:tty or process.stdout.isTTY" },
  noColor: { fix: "manual", replacement: "process.env.NO_COLOR !== undefined" },
  mainModule: { fix: "manual", replacement: "import.meta.main / pathToFileURL(process.argv[1])" },
  connect: { fix: "manual", replacement: "node:net connect()" },
  connectTls: { fix: "manual", replacement: "node:tls connect()" },
  listen: { fix: "manual", replacement: "node:net createServer().listen()" },
  listenTls: { fix: "manual", replacement: "node:tls createServer()" },
  resolveDns: { fix: "manual", replacement: "node:dns/promises resolve()" },
  dlopen: { fix: "manual", replacement: "a Node-API addon or koffi" },
  consoleSize: { fix: "manual", replacement: "process.stdout.columns / rows" },
  bench: { fix: "manual", replacement: "a benchmark runner (mitata, tinybench)" },
  openKv: {
    fix: "decision",
    rule: "deno-kv",
    replacement: "export the data first, then pick a store (see MIGRATION.md)",
    why: "Deno KV has no Node runtime; Deploy's KV goes away with Deploy",
  },
  Kv: { fix: "decision", rule: "deno-kv", replacement: "your new store's client type" },
  AtomicOperation: { fix: "decision", rule: "deno-kv", replacement: "transactions in the new store" },
  AtomicCheck: { fix: "decision", rule: "deno-kv", replacement: "transactions in the new store" },
  KvU64: { fix: "decision", rule: "deno-kv", replacement: "a BigInt column / counter in the new store" },
  cron: {
    fix: "decision",
    rule: "deno-cron",
    replacement: "Workers Cron Triggers, node-cron with { timezone: 'UTC' }, or the host's scheduler",
    why: "Deno.cron schedules are UTC and run inside Deno/Deploy",
  },
};

/** Key into API_RULES for a Deno.* member chain like ["env", "get"]. */
export function ruleKey(chain: readonly string[]): string | null {
  const [first, second] = chain;
  if (!first) return null;
  if (second && (first === "env" || first === "errors" || `${first}.${second}` in API_RULES)) return `${first}.${second}`;
  // Deno.Kv* types and classes (KvKey, KvEntryMaybe, KvListSelector …) all belong to Deno KV.
  if (/^Kv[A-Z0-9]/.test(first) && !(first in API_RULES)) return "Kv";
  return first;
}

export const ERROR_CODES: Record<string, string[]> = {
  NotFound: ["ENOENT"],
  AlreadyExists: ["EEXIST"],
  PermissionDenied: ["EACCES", "EPERM"],
  IsADirectory: ["EISDIR"],
  NotADirectory: ["ENOTDIR"],
};

/** Deno.* call → Node function and module for the simple 1:1 renames. */
export const FS_RENAMES: Record<string, { name: string; module: string; utf8?: boolean; maxArgs: number }> = {
  readTextFile: { name: "readFile", module: "node:fs/promises", utf8: true, maxArgs: 1 },
  readTextFileSync: { name: "readFileSync", module: "node:fs", utf8: true, maxArgs: 1 },
  readFile: { name: "readFile", module: "node:fs/promises", maxArgs: 1 },
  readFileSync: { name: "readFileSync", module: "node:fs", maxArgs: 1 },
  writeTextFile: { name: "writeFile", module: "node:fs/promises", maxArgs: 2 },
  writeTextFileSync: { name: "writeFileSync", module: "node:fs", maxArgs: 2 },
  writeFile: { name: "writeFile", module: "node:fs/promises", maxArgs: 2 },
  writeFileSync: { name: "writeFileSync", module: "node:fs", maxArgs: 2 },
  mkdir: { name: "mkdir", module: "node:fs/promises", maxArgs: 2 },
  mkdirSync: { name: "mkdirSync", module: "node:fs", maxArgs: 2 },
  rename: { name: "rename", module: "node:fs/promises", maxArgs: 2 },
  renameSync: { name: "renameSync", module: "node:fs", maxArgs: 2 },
  copyFile: { name: "copyFile", module: "node:fs/promises", maxArgs: 2 },
  copyFileSync: { name: "copyFileSync", module: "node:fs", maxArgs: 2 },
  realPath: { name: "realpath", module: "node:fs/promises", maxArgs: 1 },
  realPathSync: { name: "realpathSync", module: "node:fs", maxArgs: 1 },
  chmod: { name: "chmod", module: "node:fs/promises", maxArgs: 2 },
  truncate: { name: "truncate", module: "node:fs/promises", maxArgs: 2 },
  symlink: { name: "symlink", module: "node:fs/promises", maxArgs: 2 },
  hostname: { name: "hostname", module: "node:os", maxArgs: 0 },
  osRelease: { name: "release", module: "node:os", maxArgs: 0 },
  loadavg: { name: "loadavg", module: "node:os", maxArgs: 0 },
  inspect: { name: "inspect", module: "node:util", maxArgs: 2 },
};

/** Deno.* members that are plain renames onto `process`. */
export const PROCESS_RENAMES: Record<string, { text: string; call: boolean }> = {
  exit: { text: "process.exit", call: true },
  cwd: { text: "process.cwd", call: true },
  chdir: { text: "process.chdir", call: true },
  execPath: { text: "process.execPath", call: true },
  memoryUsage: { text: "process.memoryUsage", call: true },
  addSignalListener: { text: "process.on", call: true },
  removeSignalListener: { text: "process.off", call: true },
  pid: { text: "process.pid", call: false },
  ppid: { text: "process.ppid", call: false },
};
