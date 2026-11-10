// Works out which Node each shell command runs on: the Dockerfile stage's base image, the CI job's setup-node
// version or container image, the GitLab job image, NODE_VERSION in netlify.toml, or the repo's own pin
// (.nvmrc, .node-version, volta, devEngines). Everything the rules need about "where does this run" is here.
import { dockerRun, findCommands, provides, shellScript, type Command } from "./commands.ts";
import { fromDockerImage, fromKnownImage, fromSpec, UNKNOWN, type DockerNodeImage, type NodeRuntime } from "./node-version.ts";
import {
  lineOffsets, markdownCodeSpans, netlifyCommandSpans, packageScriptSpans, parseJson, vercelCommandSpans, yamlShellSpans, type Span,
} from "./sources.ts";
import type { SourceFile } from "./types.ts";

export type Where = "docker" | "ci" | "script" | "doc";
export type Tool = "corepack" | "pnpm" | "yarn";

/** One place commands run in order: a Dockerfile stage, a CI job, or a whole script file. */
export interface Env {
  id: string;
  file: SourceFile;
  where: Where;
  /** Runs inside an official `node` image (Dockerfile stage, container job, GitLab image), where only npm comes with Node. */
  image: boolean;
  /** Tools on PATH before any step runs (GitHub-hosted runners ship Yarn 1). */
  preinstalled: Set<Tool>;
  /** Steps outside the shell that install a tool, by offset (pnpm/action-setup). */
  installs: { at: number; tool: Tool }[];
  /** Dockerfile `USER` instructions, by offset. */
  users: { at: number; name: string }[];
  parent?: Env;
  /** The Node the env starts on (a Dockerfile stage's base image). */
  runtime: NodeRuntime;
  commands: RunCommand[];
}

export interface RunCommand extends Command {
  env: Env;
  runtime: NodeRuntime;
  /** Exec-form or JSON-escaped text: an insert at `start` would not be valid there. */
  editable: boolean;
}

/** A place that names a Node version: a FROM tag, setup-node input, container image, .nvmrc, NODE_VERSION. */
export interface VersionRef {
  file: SourceFile;
  /** Offsets of the text a --pin would replace. */
  start: number;
  end: number;
  runtime: NodeRuntime;
  what: "docker-image" | "docker-arg" | "setup-node" | "version-file" | "netlify";
  image?: DockerNodeImage;
  /** Written through a variable or expression: reported, never rewritten. */
  indirect: boolean;
}

export interface SetupNodeStep {
  at: number;
  line: number;
  ref: string;
  inputs: Record<string, string>;
  runtime: NodeRuntime | undefined;
}

export interface CacheStep {
  at: number;
  line: number;
  path: string;
  key: string;
}

export interface Job {
  file: SourceFile;
  name: string;
  env: Env;
  start: number;
  end: number;
  setupNode: SetupNodeStep[];
  caches: CacheStep[];
  container?: NodeRuntime;
}

export interface PackageManagerPin {
  name: string;
  version: string;
  /** As written in package.json. */
  raw: string;
  file: SourceFile;
}

export interface Model {
  files: SourceFile[];
  envs: Env[];
  versions: VersionRef[];
  jobs: Job[];
  /** The pin of the repo root. */
  repoPin: NodeRuntime;
  /** The nearest pin above a file (a monorepo package's own .nvmrc wins over the root one). */
  pinFor(path: string): NodeRuntime;
  /** The root package.json's packageManager. */
  packageManager?: PackageManagerPin;
  /** The nearest package.json packageManager above a file. */
  packageManagerFor(path: string): PackageManagerPin | undefined;
}

interface Piece {
  start: number;
  end: number;
  runtime: NodeRuntime;
  /** Text to find commands in, when it differs from the file text (JSON escapes masked, same offsets). */
  text?: string;
  quotesSplit?: boolean;
  editable?: boolean;
}

function newEnv(id: string, file: SourceFile, where: Where, runtime: NodeRuntime, image = false): Env {
  return { id, file, where, image, runtime, preinstalled: new Set(), installs: [], users: [], commands: [] };
}

/** Simple `NAME=value` assignments in a file, for `docker run "$IMAGE"`. */
function shellVars(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of text.matchAll(/^[ \t]*(?:export\s+|readonly\s+|local\s+)?([A-Za-z_]\w*)=(['"]?)([^\s'"$]+)\2[ \t]*$/gm)) vars.set(m[1]!, m[3]!);
  return vars;
}

/** What runs inside `docker run IMAGE …`: its own env, on the image's Node. */
function imageEnv(parent: Env, ref: string, at: number): Env {
  const node = fromDockerImage(ref);
  const known = node ? undefined : fromKnownImage(ref);
  const runtime = node?.runtime ?? known?.runtime ?? { major: undefined, label: `image ${ref}` };
  const env = newEnv(`${parent.id}@${at}`, parent.file, "docker", runtime, Boolean(node));
  if (known?.yarn) env.preinstalled.add("yarn");
  return env;
}

function addCommands(env: Env, pieces: Piece[], model?: Model): void {
  const vars = shellVars(env.file.text);
  const add = (target: Env, text: string, start: number, end: number, runtime: NodeRuntime, piece: Piece, depth: number) => {
    for (const c of findCommands(text, start, end, { quotesSplit: piece.quotesSplit })) {
      target.commands.push({ ...c, env: target, runtime, editable: piece.editable ?? true });
      if (depth > 2) continue;
      // bash -c '…': the script runs in the same place.
      const script = shellScript(c);
      if (script) add(target, text, script.start, script.end, runtime, piece, depth + 1);
      // docker run IMAGE …: the rest runs in the image.
      const run = dockerRun(c);
      if (!run?.image) continue;
      const ref = run.image.raw.replace(/^(['"])(.*)\1$/, "$2").replace(/^\$\{?(\w+)\}?$/, (all, name: string) => vars.get(name) ?? all);
      // An image we can't resolve (`$IMAGE` with no assignment, an expression tag) still runs its own Node.
      const inner = imageEnv(target, ref, c.start);
      const head = run.rest[0];
      if (head) {
        const restEnd = c.end;
        const nested = findCommands(text, head.at, restEnd, { quotesSplit: piece.quotesSplit })[0];
        if (nested) {
          // The command words after the image are argv, not shell: report them, never insert into them.
          inner.commands.push({ ...nested, env: inner, runtime: inner.runtime, editable: false });
          const s2 = shellScript(nested);
          if (s2) add(inner, text, s2.start, s2.end, inner.runtime, { ...piece, editable: false }, depth + 1);
        }
      }
      inner.commands.sort((a, b) => a.start - b.start);
      model?.envs.push(inner);
      if (model && fromDockerImage(ref)) {
        const image = fromDockerImage(ref)!;
        const off = run.image.at + (run.image.raw.length - run.image.raw.replace(/^['"]/, "").length);
        if (run.image.raw.replace(/^['"]|['"]$/g, "") === ref && !ref.includes("$")) model.versions.push({ file: env.file, start: off, end: off + ref.length, runtime: image.runtime, what: "docker-image", image, indirect: false });
      }
    }
  };
  for (const p of pieces) add(env, p.text ?? env.file.text, p.start, p.end, p.runtime, p, 0);
  env.commands.sort((a, b) => a.start - b.start);
}

/** Is `tool` on PATH when the command at `at` in `env` runs? */
export function availableAt(env: Env, at: number, tool: Tool, options: { ignorePreinstalled?: boolean } = {}): boolean {
  if (env.preinstalled.has(tool) && !options.ignorePreinstalled) return true;
  if (env.installs.some((i) => i.at < at && i.tool === tool)) return true;
  if (env.commands.some((c) => c.start < at && provides(c).has(tool))) return true;
  return env.parent ? availableAt(env.parent, Number.POSITIVE_INFINITY, tool, options) : false;
}

/** JSON string escapes `\"` and `\\` become blank + char, so the lexer sees shell quotes at the same offsets. */
const maskJsonEscapes = (text: string) => text.replace(/\\(["\\])/g, " $1");

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** The folders from a file's own folder up to the repo root: "a/b/x.sh" -> ["a/b", "a", ""]. */
function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  const out: string[] = [];
  for (let i = parts.length; i >= 0; i--) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** The pin in one folder: .nvmrc, then .node-version, then volta.node and devEngines.runtime in package.json. */
export function pinIn(files: SourceFile[], dir = ""): NodeRuntime | undefined {
  for (const name of [".nvmrc", ".node-version"]) {
    const path = join(dir, name);
    const f = files.find((x) => x.path === path);
    const v = f?.text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    const r = v ? fromSpec(v, `${path} ${v}`) : undefined;
    if (r) return r;
  }
  const pkg = files.find((f) => f.path === join(dir, "package.json"));
  const json = pkg ? parseJson<PackageJson>(pkg.text) : undefined;
  if (typeof json?.volta?.node === "string") {
    const r = fromSpec(json.volta.node, `volta.node ${json.volta.node}`);
    if (r) return r;
  }
  const rt = runtimeEntry(json);
  if (rt) {
    const r = fromSpec(rt, `devEngines.runtime node ${rt}`);
    if (r) return r;
  }
  return undefined;
}

const UNPINNED: NodeRuntime = { ...UNKNOWN, label: "an unpinned Node (no .nvmrc, .node-version or volta pin)" };

export function repoPin(files: SourceFile[]): NodeRuntime {
  return pinIn(files) ?? UNPINNED;
}

export interface PackageJson {
  packageManager?: unknown;
  engines?: { node?: unknown };
  volta?: { node?: unknown };
  devEngines?: { runtime?: unknown; packageManager?: unknown };
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function runtimeEntry(json: PackageJson | undefined): string | undefined {
  const rt = json?.devEngines?.runtime;
  const list = Array.isArray(rt) ? rt : rt ? [rt] : [];
  const node = list.find((r): r is { name: string; version: string } => typeof r === "object" && r !== null && (r as { name?: unknown }).name === "node");
  return typeof node?.version === "string" ? node.version : undefined;
}

function packageManagerOf(files: SourceFile[], dir = ""): PackageManagerPin | undefined {
  const pkg = files.find((f) => f.path === join(dir, "package.json"));
  const json = pkg ? parseJson<PackageJson>(pkg.text) : undefined;
  if (!pkg || !json) return undefined;
  const raw = typeof json.packageManager === "string" ? json.packageManager : undefined;
  const m = raw ? /^(pnpm|yarn|npm|bun)@([^+\s]+)/.exec(raw) : undefined;
  if (raw && m) return { name: m[1]!, version: m[2]!, raw, file: pkg };
  const dev = json.devEngines?.packageManager;
  const d = (Array.isArray(dev) ? dev[0] : dev) as { name?: unknown; version?: unknown } | undefined;
  if (d && typeof d.name === "string" && typeof d.version === "string") return { name: d.name, version: d.version, raw: `${d.name}@${d.version}`, file: pkg };
  return undefined;
}

// ---------------------------------------------------------------------------------------------- Dockerfile

interface Instruction {
  keyword: string;
  /** Offset of the text after the keyword. */
  bodyStart: number;
  end: number;
  heredoc?: Span;
}

export function dockerInstructions(text: string): Instruction[] {
  const lines = text.split("\n");
  const offsets = lineOffsets(lines);
  const out: Instruction[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)([A-Za-z]+)(\s+|$)/.exec(lines[i]!);
    if (!m || lines[i]!.trimStart().startsWith("#")) continue;
    const start = offsets[i]!;
    let j = i;
    while (j < lines.length - 1 && /\\\s*$/.test(lines[j]!)) j++;
    let heredoc: Span | undefined;
    const hd = /<<-?\s*["']?(\w+)["']?/.exec(lines[i]!);
    if (hd && /^(RUN|COPY)$/i.test(m[2]!)) {
      let k = j + 1;
      while (k < lines.length && lines[k]!.trim() !== hd[1]) k++;
      heredoc = { start: offsets[j + 1] ?? text.length, end: offsets[k] ?? text.length };
      j = Math.min(k, lines.length - 1);
    }
    out.push({ keyword: m[2]!.toUpperCase(), bodyStart: start + m[0].length, end: offsets[j]! + lines[j]!.length, heredoc });
    i = j;
  }
  return out;
}

function substitute(value: string, args: Map<string, string>): string {
  return value.replace(/\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)/g, (all, a: string | undefined, def: string | undefined, b: string | undefined) => {
    const v = args.get((a ?? b)!);
    return v !== undefined && v !== "" ? v : def ?? all;
  });
}

function dockerfile(file: SourceFile, model: Model): void {
  const text = file.text;
  const globalArgs = new Map<string, { value: string; start: number; end: number }>();
  const stages = new Map<string, Env>();
  let env: Env | undefined;
  let runtime: NodeRuntime = UNKNOWN;
  let seenFrom = false;
  let index = 0;
  for (const ins of dockerInstructions(text)) {
    const body = text.slice(ins.bodyStart, ins.end);
    if (ins.keyword === "ARG" && !seenFrom) {
      const m = /^\s*(\w+)=("?)([^"\s]*)\2/.exec(body);
      if (m) {
        const valueStart = ins.bodyStart + body.indexOf("=") + 1 + m[2]!.length;
        globalArgs.set(m[1]!, { value: m[3]!, start: valueStart, end: valueStart + m[3]!.length });
      }
      continue;
    }
    if (ins.keyword === "FROM") {
      seenFrom = true;
      const words = [...body.matchAll(/\S+/g)];
      const imageWord = words.find((w) => !w[0].startsWith("--"));
      if (!imageWord) continue;
      const asIdx = words.findIndex((w) => w[0].toLowerCase() === "as");
      const name = asIdx !== -1 ? words[asIdx + 1]?.[0].toLowerCase() : undefined;
      const written = imageWord[0];
      const values = new Map([...globalArgs].map(([k, v]) => [k, v.value]));
      const resolved = substitute(written, values);
      const parent = stages.get(resolved.toLowerCase());
      const id = `${file.path}#stage${index++}${name ? `:${name}` : ""}`;
      env = newEnv(id, file, "docker", UNKNOWN);
      env.parent = parent;
      const image = fromDockerImage(resolved);
      if (parent) {
        runtime = parent.runtime;
        env.image = parent.image;
      } else if (image) {
        runtime = image.runtime;
        env.image = true;
        const at = ins.bodyStart + imageWord.index!;
        const usesArg = written !== resolved;
        model.versions.push({ file, start: at, end: at + written.length, runtime, what: "docker-image", image, indirect: usesArg });
        // A floating value in a global ARG (ARG NODE_VERSION=lts) is where a pin goes.
        const arg = /\$\{?(\w+)/.exec(written);
        const def = arg ? globalArgs.get(arg[1]!) : undefined;
        if (usesArg && def && image.runtime.floating) {
          model.versions.push({ file, start: def.start, end: def.end, runtime, what: "docker-arg", image, indirect: false });
        }
      } else {
        const known = fromKnownImage(resolved);
        runtime = known?.runtime ?? { major: undefined, label: `base image ${resolved}` };
        if (known?.yarn) env.preinstalled.add("yarn");
      }
      env.runtime = runtime;
      if (name) stages.set(name, env);
      model.envs.push(env);
      continue;
    }
    if (!env) continue;
    if (ins.keyword === "USER") {
      env.users.push({ at: ins.bodyStart, name: body.trim().split(":")[0]! });
      continue;
    }
    if (ins.keyword !== "RUN") continue;
    if (ins.heredoc) {
      addCommands(env, [{ ...ins.heredoc, runtime }], model);
      continue;
    }
    // Skip RUN flags (--mount=…, --network=…) so the first command sits at a command position.
    const flags = /^(?:\s*--[\w-]+(?:=\S*)?)*\s*/.exec(body)![0].length;
    const start = ins.bodyStart + flags;
    if (text[start] === "[") {
      // Exec form: ["corepack", "enable"] is one command with JSON-quoted words.
      const argv = parseJson<unknown[]>(text.slice(start, ins.end));
      if (Array.isArray(argv) && typeof argv[0] === "string") {
        env.commands.push({
          start, end: ins.end, program: argv[0].split("/").pop()!, args: argv.slice(1).map(String), words: [], text: text.slice(start, ins.end),
          env, runtime, editable: false,
        });
      }
      continue;
    }
    addCommands(env, [{ start, end: ins.end, runtime }], model);
  }
}

// ---------------------------------------------------------------------------------------------- YAML helpers

interface YLine {
  indent: number;
  text: string;
  at: number;
  line: number;
}

function yamlLines(text: string): YLine[] {
  const lines = text.split("\n");
  const offsets = lineOffsets(lines);
  return lines.map((l, i) => ({ indent: l.length - l.trimStart().length, text: l, at: offsets[i]!, line: i + 1 }));
}

const isBlank = (l: YLine) => l.text.trim() === "" || l.text.trimStart().startsWith("#");

/** `key: value` -> value without quotes or a trailing comment, and the offsets of that value. */
function scalar(l: YLine, key: string): { value: string; start: number; end: number } | undefined {
  const m = new RegExp(`^(\\s*(?:-\\s+)?${key}:[ \\t]*)(.*?)\\s*$`).exec(l.text);
  if (!m) return undefined;
  let value = m[2]!.replace(/\s+#.*$/, "");
  let start = l.at + m[1]!.length;
  const q = value[0];
  if ((q === '"' || q === "'") && value.endsWith(q) && value.length > 1) {
    value = value.slice(1, -1);
    start++;
  }
  return { value, start, end: start + value.length };
}

/** The lines of the block under `lines[i]` (deeper indented), as an index range. */
function blockEnd(lines: YLine[], i: number, baseIndent = lines[i]!.indent): number {
  let j = i + 1;
  for (; j < lines.length; j++) {
    if (isBlank(lines[j]!)) continue;
    if (lines[j]!.indent <= baseIndent) break;
  }
  return j;
}

/** A `key: [a, b]` or a block list under `key:`, with the offset of each item. */
function listValues(lines: YLine[], i: number): { value: string; start: number; end: number }[] {
  const l = lines[i]!;
  const inline = /:\s*\[(.*)\]\s*$/.exec(l.text);
  if (inline) {
    const base = l.at + l.text.indexOf("[") + 1;
    const out: { value: string; start: number; end: number }[] = [];
    for (const m of inline[1]!.matchAll(/\s*(['"]?)([^,'"\]]+)\1\s*(?:,|$)/g)) {
      const v = m[2]!.trim();
      const s = base + m.index! + m[0].indexOf(v);
      if (v) out.push({ value: v, start: s, end: s + v.length });
    }
    return out;
  }
  const one = scalar(l, "[\\w-]+");
  if (one && one.value && !/^[|>]/.test(one.value)) return [one];
  const out: { value: string; start: number; end: number }[] = [];
  for (let k = i + 1; k < blockEnd(lines, i); k++) {
    const m = /^(\s*-\s+)(['"]?)(.*?)\2\s*$/.exec(lines[k]!.text);
    if (m && m[3]) {
      const s = lines[k]!.at + m[1]!.length + m[2]!.length;
      out.push({ value: m[3], start: s, end: s + m[3].length });
    }
  }
  return out;
}

/** The worst of several runtimes for a "does this break on 26" question: unknown, then floating, then the highest. */
export function worst(list: NodeRuntime[]): NodeRuntime {
  if (list.length === 0) return UNKNOWN;
  return [...list].sort((a, b) => (b.major ?? 999) - (a.major ?? 999) || Number(Boolean(b.floating)) - Number(Boolean(a.floating)))[0]!;
}

// ---------------------------------------------------------------------------------------------- GitHub Actions

/** ubuntu-24.04 runner image readme: Node.js 22, Yarn 1.22.22 (github.com/actions/runner-images). */
const HOSTED_UBUNTU = /^(?:ubuntu-latest|ubuntu-24\.04)$/;

function versionFile(model: Model, path: string): NodeRuntime | undefined {
  const clean = path.replace(/^\.\//, "");
  const f = model.files.find((x) => x.path === clean);
  if (!f) return undefined;
  if (clean.endsWith("package.json")) {
    // setup-node reads volta.node, then devEngines.runtime, then engines.node (advanced-usage.md#node-version-file).
    const json = parseJson<PackageJson>(f.text);
    const spec = typeof json?.volta?.node === "string" ? json.volta.node : runtimeEntry(json) ?? (typeof json?.engines?.node === "string" ? json.engines.node : undefined);
    return spec ? fromSpec(spec, `${clean} → ${spec}`) : undefined;
  }
  if (clean.endsWith(".tool-versions")) {
    const m = /^nodejs\s+(\S+)/m.exec(f.text);
    return m ? fromSpec(m[1]!, `${clean} nodejs ${m[1]}`) : undefined;
  }
  const v = f.text.split("\n").map((l) => l.trim()).find(Boolean);
  return v ? fromSpec(v, `${clean} ${v}`) : undefined;
}

function workflow(file: SourceFile, model: Model): void {
  const lines = yamlLines(file.text);
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l.text));
  const ranges: { name: string; from: number; to: number }[] = [];
  if (jobsAt === -1) {
    ranges.push({ name: "action", from: 0, to: lines.length });
  } else {
    const first = lines.slice(jobsAt + 1).find((l) => !isBlank(l));
    const jobIndent = first?.indent ?? 2;
    for (let i = jobsAt + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (isBlank(l)) continue;
      if (l.indent < jobIndent) break;
      const m = /^\s*([\w-]+):\s*$/.exec(l.text);
      if (l.indent === jobIndent && m) ranges.push({ name: m[1]!, from: i, to: blockEnd(lines, i) });
    }
  }
  const spans = yamlShellSpans(file.text);
  for (const r of ranges) {
    const start = lines[r.from]!.at;
    const end = r.to < lines.length ? lines[r.to]!.at : file.text.length;
    const env = newEnv(`${file.path}#${r.name}`, file, "ci", UNKNOWN);
    const job: Job = { file, name: r.name, env, start, end, setupNode: [], caches: [] };
    let runsOn = "";
    const matrix = new Map<string, { value: string; start: number; end: number }[]>();
    for (let i = r.from; i < r.to; i++) {
      const l = lines[i]!;
      if (isBlank(l)) continue;
      const ro = scalar(l, "runs-on");
      if (ro) runsOn = ro.value;
      if (/^\s*matrix:\s*$/.test(l.text)) {
        const mEnd = blockEnd(lines, i);
        const childIndent = lines.slice(i + 1, mEnd).find((x) => !isBlank(x))?.indent;
        for (let k = i + 1; k < mEnd; k++) {
          const key = /^\s*([\w-]+):/.exec(lines[k]!.text);
          if (key && lines[k]!.indent === childIndent) matrix.set(key[1]!, listValues(lines, k));
        }
      }
      const c = scalar(l, "container");
      if (c) {
        const ref = c.value || (() => {
          for (let k = i + 1; k < blockEnd(lines, i); k++) {
            const im = scalar(lines[k]!, "image");
            if (im) return im.value;
          }
          return "";
        })();
        const image = ref ? fromDockerImage(ref) : undefined;
        if (image) {
          job.container = image.runtime;
          env.image = true;
          const off = file.text.indexOf(ref, l.at);
          model.versions.push({ file, start: off, end: off + ref.length, runtime: image.runtime, what: "docker-image", image, indirect: ref.includes("${{") });
        } else if (ref) {
          const known = fromKnownImage(ref);
          job.container = known?.runtime ?? { major: undefined, label: `container ${ref}` };
          if (known?.yarn) env.preinstalled.add("yarn");
        }
      }
      const uses = scalar(l, "uses");
      if (uses) {
        const stepIndent = l.text.indexOf("uses:") - (/^\s*-\s+uses:/.test(l.text) ? 2 : 0);
        const withInputs: Record<string, string> = {};
        const withSpans: Record<string, { start: number; end: number }> = {};
        let k = i + 1;
        for (; k < r.to; k++) {
          const s = lines[k]!;
          if (isBlank(s)) continue;
          if (s.indent <= stepIndent && /^\s*-\s/.test(s.text)) break;
          if (s.indent < stepIndent) break;
          if (/^\s*with:\s*$/.test(s.text)) {
            for (let w = k + 1; w < blockEnd(lines, k); w++) {
              const kv = /^\s*([\w-]+):/.exec(lines[w]!.text);
              const v = kv ? scalar(lines[w]!, kv[1]!) : undefined;
              if (kv && v) {
                let value = v.value;
                if (/^[|>]/.test(value)) value = lines.slice(w + 1, blockEnd(lines, w)).map((x) => x.text.trim()).join("\n");
                withInputs[kv[1]!] = value;
                withSpans[kv[1]!] = { start: v.start, end: v.end };
              }
            }
          }
        }
        const [action, ref = ""] = uses.value.split("@");
        if (action === "actions/setup-node") {
          let runtime: NodeRuntime | undefined;
          const spec = withInputs["node-version"];
          if (spec) {
            const mx = /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/.exec(spec);
            if (mx) {
              const legs = matrix.get(mx[1]!) ?? [];
              const resolved = legs.map((v) => ({ v, r: fromSpec(v.value, `setup-node matrix.${mx[1]} ${v.value}`) }));
              for (const { v, r } of resolved) if (r) model.versions.push({ file, start: v.start, end: v.end, runtime: r, what: "setup-node", indirect: false });
              const known = resolved.map((x) => x.r).filter((x): x is NodeRuntime => Boolean(x));
              runtime = known.length ? worst(known) : { major: undefined, label: `setup-node ${spec}` };
            } else {
              runtime = fromSpec(spec, `setup-node ${spec}`) ?? { major: undefined, label: `setup-node ${spec}` };
              const sp = withSpans["node-version"]!;
              if (!spec.includes("${{")) model.versions.push({ file, start: sp.start, end: sp.end, runtime, what: "setup-node", indirect: false });
            }
          } else if (withInputs["node-version-file"]) {
            runtime = versionFile(model, withInputs["node-version-file"]) ?? { major: undefined, label: `setup-node node-version-file ${withInputs["node-version-file"]}` };
          }
          job.setupNode.push({ at: l.at, line: l.line, ref, inputs: withInputs, runtime });
        } else if (action === "pnpm/action-setup") {
          env.installs.push({ at: l.at, tool: "pnpm" });
        } else if (action === "pnpm/setup") {
          // pnpm/setup installs pnpm and, with `runtime: node@26`, Node itself.
          env.installs.push({ at: l.at, tool: "pnpm" });
          const rt = /^node@(.+)$/.exec(withInputs.runtime ?? "");
          if (rt) {
            const mx = /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/.exec(rt[1]!);
            const legs = mx ? (matrix.get(mx[1]!) ?? []).map((v) => fromSpec(v.value, `pnpm/setup node@${v.value}`)).filter((x): x is NodeRuntime => Boolean(x)) : [];
            const runtime = mx ? (legs.length ? worst(legs) : undefined) : fromSpec(rt[1]!, `pnpm/setup node@${rt[1]}`);
            job.setupNode.push({ at: l.at, line: l.line, ref, inputs: {}, runtime });
          }
        } else if (action === "actions/cache" || action === "actions/cache/restore") {
          job.caches.push({ at: l.at, line: l.line, path: withInputs.path ?? "", key: withInputs.key ?? "" });
        }
        i = Math.max(i, k - 1);
      }
    }
    const hosted = HOSTED_UBUNTU.test(runsOn);
    if (!job.container && hosted) env.preinstalled.add("yarn");
    const before: NodeRuntime = job.container
      ?? (hosted ? { major: 22, label: `the runner's preinstalled Node (${runsOn} image)` } : { major: undefined, label: `the runner's preinstalled Node${runsOn ? ` (${runsOn})` : ""}` });
    const runtimeAt = (at: number): NodeRuntime => {
      if (job.container) return job.container;
      const last = job.setupNode.filter((s) => s.at < at).pop();
      return last?.runtime ?? before;
    };
    env.runtime = before;
    addCommands(env, spans.filter((s) => s.start >= start && s.start < end).map((s) => ({ ...s, runtime: runtimeAt(s.start) })), model);
    model.envs.push(env);
    model.jobs.push(job);
  }
}

// ---------------------------------------------------------------------------------------------- GitLab CI

const GITLAB_RESERVED = new Set(["image", "services", "stages", "variables", "include", "workflow", "default", "cache", "before_script", "after_script", "pages:deploy"]);

function gitlabImage(lines: YLine[], from: number, to: number, indent: number): { ref: string; start: number } | undefined {
  for (let i = from; i < to; i++) {
    const l = lines[i]!;
    if (l.indent !== indent) continue;
    const im = scalar(l, "image");
    if (!im) continue;
    if (im.value) return { ref: im.value, start: im.start };
    for (let k = i + 1; k < blockEnd(lines, i); k++) {
      const n = scalar(lines[k]!, "name");
      if (n) return { ref: n.value, start: n.start };
    }
  }
  return undefined;
}

function gitlab(file: SourceFile, model: Model): void {
  const lines = yamlLines(file.text);
  const top: { name: string; from: number; to: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (isBlank(l) || l.indent !== 0) continue;
    const m = /^([^\s:#][^:]*):/.exec(l.text);
    if (m) top.push({ name: m[1]!.trim(), from: i, to: blockEnd(lines, i, 0) });
  }
  const runtimeOf = (img: { ref: string; start: number } | undefined, what: string): { runtime: NodeRuntime; node: boolean } => {
    if (!img) return { runtime: { major: undefined, label: what }, node: false };
    const image = fromDockerImage(img.ref);
    if (!image) return { runtime: fromKnownImage(img.ref)?.runtime ?? { major: undefined, label: `image ${img.ref}` }, node: false };
    model.versions.push({ file, start: img.start, end: img.start + img.ref.length, runtime: image.runtime, what: "docker-image", image, indirect: img.ref.includes("$") });
    return { runtime: image.runtime, node: true };
  };
  const topImage = gitlabImage(lines, 0, lines.length, 0);
  const def = top.find((t) => t.name === "default");
  const defImage = topImage ?? (def ? gitlabImage(lines, def.from + 1, def.to, 2) : undefined);
  const base = runtimeOf(defImage, "the runner's default image");
  const spans = yamlShellSpans(file.text);
  const spanIn = (from: number, to: number) => {
    const s = lines[from]!.at;
    const e = to < lines.length ? lines[to]!.at : file.text.length;
    return spans.filter((x) => x.start >= s && x.start < e);
  };
  for (const t of top) {
    const isDefault = t.name === "default" || t.name === "before_script" || t.name === "after_script";
    if (GITLAB_RESERVED.has(t.name) && !isDefault) continue;
    const childIndent = lines.slice(t.from + 1, t.to).find((x) => !isBlank(x))?.indent ?? 2;
    const own = isDefault ? undefined : gitlabImage(lines, t.from + 1, t.to, childIndent);
    const r = own ? runtimeOf(own, "") : base;
    const env = newEnv(`${file.path}#${t.name}`, file, "ci", r.runtime, r.node);
    addCommands(env, spanIn(t.from, t.to).map((s) => ({ ...s, runtime: r.runtime })), model);
    model.envs.push(env);
  }
}

// ---------------------------------------------------------------------------------------------- the rest

function jenkinsfile(file: SourceFile, model: Model): void {
  const runtimes: NodeRuntime[] = [];
  const re = /\b(?:image|docker(?:\.image)?)\s*\(?\s*(['"])([^'"\s]+)\1/g;
  for (const m of file.text.matchAll(re)) {
    const image = fromDockerImage(m[2]!);
    if (!image) continue;
    const start = m.index! + m[0].lastIndexOf(m[2]!);
    model.versions.push({ file, start, end: start + m[2]!.length, runtime: image.runtime, what: "docker-image", image, indirect: m[2]!.includes("$") });
    runtimes.push(image.runtime);
  }
  const runtime = runtimes.length ? worst(runtimes) : { major: undefined, label: "the Jenkins agent's Node" };
  const env = newEnv(file.path, file, "ci", runtime, runtimes.length > 0);
  const pieces: Piece[] = [];
  for (const l of yamlLines(file.text)) {
    if (l.text.trimStart().startsWith("//")) continue;
    pieces.push({ start: l.at, end: l.at + l.text.length, runtime, quotesSplit: true, editable: false });
  }
  addCommands(env, pieces, model);
  model.envs.push(env);
}

function netlify(file: SourceFile, model: Model): void {
  const m = /^[ \t]*NODE_VERSION[ \t]*=[ \t]*(["'])([^"'\n]+)\1/m.exec(file.text);
  let runtime = model.pinFor(file.path);
  if (m) {
    const start = m.index + m[0].lastIndexOf(m[2]!);
    runtime = fromSpec(m[2]!, `netlify.toml NODE_VERSION ${m[2]}`) ?? { major: undefined, label: `NODE_VERSION ${m[2]}` };
    model.versions.push({ file, start, end: start + m[2]!.length, runtime, what: "netlify", indirect: false });
  }
  const env = newEnv(file.path, file, "ci", runtime);
  addCommands(env, netlifyCommandSpans(file.text).map((s) => ({ ...s, runtime })), model);
  model.envs.push(env);
}

function versionFileRef(file: SourceFile, model: Model): void {
  const m = /^\s*([^\s#]+)/.exec(file.text);
  if (!m) return;
  const start = m.index + m[0].length - m[1]!.length;
  const runtime = fromSpec(m[1]!, `${file.path} ${m[1]}`);
  if (runtime) model.versions.push({ file, start, end: start + m[1]!.length, runtime, what: "version-file", indirect: false });
}

export function buildModel(files: SourceFile[]): Model {
  const pins = new Map<string, NodeRuntime | undefined>();
  const pms = new Map<string, PackageManagerPin | undefined>();
  const nearest = <T>(cache: Map<string, T | undefined>, read: (dir: string) => T | undefined, path: string): T | undefined => {
    for (const dir of ancestors(path)) {
      if (!cache.has(dir)) cache.set(dir, read(dir));
      const v = cache.get(dir);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const model: Model = {
    files,
    envs: [],
    versions: [],
    jobs: [],
    repoPin: repoPin(files),
    pinFor: (path) => nearest(pins, (dir) => pinIn(files, dir), path) ?? UNPINNED,
    packageManager: packageManagerOf(files),
    packageManagerFor: (path) => nearest(pms, (dir) => packageManagerOf(files, dir), path),
  };
  for (const file of files) {
    switch (file.kind) {
      case "dockerfile":
        dockerfile(file, model);
        break;
      case "workflow":
        workflow(file, model);
        break;
      case "gitlab":
        gitlab(file, model);
        break;
      case "jenkinsfile":
        jenkinsfile(file, model);
        break;
      case "netlify":
        netlify(file, model);
        break;
      case "node-version":
        versionFileRef(file, model);
        break;
      case "vercel": {
        const env = newEnv(file.path, file, "ci", model.pinFor(file.path));
        addCommands(env, vercelCommandSpans(file.text).map((s) => ({ ...s, runtime: model.pinFor(file.path), text: maskJsonEscapes(file.text), editable: false })));
        model.envs.push(env);
        break;
      }
      case "package": {
        const env = newEnv(file.path, file, "script", model.pinFor(file.path));
        const text = maskJsonEscapes(file.text);
        addCommands(env, packageScriptSpans(file.text).map((s) => ({ start: s.start, end: s.end, runtime: model.pinFor(file.path), text })));
        model.envs.push(env);
        break;
      }
      case "shell":
      case "makefile": {
        const env = newEnv(file.path, file, "script", model.pinFor(file.path));
        addCommands(env, [{ start: 0, end: file.text.length, runtime: model.pinFor(file.path) }], model);
        model.envs.push(env);
        break;
      }
      case "agent-doc": {
        const env = newEnv(file.path, file, "doc", model.pinFor(file.path));
        addCommands(env, markdownCodeSpans(file.text).map((s) => ({ ...s, runtime: model.pinFor(file.path) })));
        model.envs.push(env);
        break;
      }
      default:
        break;
    }
  }
  return model;
}
