// Version pins and ranges: floating tags (with --pin), engines that leave out 26, a repo pin that differs from
// what CI runs, locked dependencies whose engines leave out 26, and native addons that need ABI 147 binaries.
import semver from "semver";
import type { Model, PackageJson, VersionRef } from "../contexts.ts";
import { ABI, describe, LTS_MAJOR, pinnedTag, type NodeRuntime } from "../node-version.ts";
import { lineOf, lineText, parseJson } from "../sources.ts";
import type { Edit, Finding, SourceFile } from "../types.ts";

/** The latest Node 26 release when these rules were written (nodejs.org/dist/index.json). */
export const NODE26 = "26.13.0";

export interface VersionOptions {
  /** Major to pin floating versions to (`--pin 26`); no rewrite without it. */
  pin?: number;
}

function at(file: SourceFile, offset: number, rule: string, severity: Finding["severity"], message: string, edits?: Edit[]): Finding {
  const line = lineOf(file.text, offset);
  return { rule, severity, message, file: file.path, line, snippet: lineText(file.text, line).trim(), edits };
}

function pinEdit(v: VersionRef, pin: number): Edit | undefined {
  if (v.indirect) return undefined;
  const written = v.file.text.slice(v.start, v.end);
  if (v.what === "docker-image" && v.image) return { start: v.start, end: v.end, text: `${v.image.repo}:${pinnedTag(v.image.tag, pin)}` };
  if (v.what === "docker-arg") return { start: v.start, end: v.end, text: pinnedTag(written, pin) };
  return { start: v.start, end: v.end, text: String(pin) };
}

/** A FROM line that takes its tag from a global ARG is reported (and pinned) at the ARG. */
const shadowedByArg = (model: Model, v: VersionRef) => v.what === "docker-image" && v.indirect && model.versions.some((x) => x.what === "docker-arg" && x.file === v.file);

export function checkFloating(model: Model, options: VersionOptions): Finding[] {
  const out: Finding[] = [];
  for (const v of model.versions) {
    if (!v.runtime.floating || v.image?.digest || shadowedByArg(model, v)) continue;
    const written = v.file.text.slice(v.start, v.end);
    const pin = options.pin ?? LTS_MAJOR;
    const suggestion = v.what === "docker-image" && v.image ? `${v.image.repo}:${pinnedTag(v.image.tag, pin)}` : v.what === "docker-arg" ? pinnedTag(written, pin) : String(pin);
    const edit = options.pin !== undefined ? pinEdit(v, options.pin) : undefined;
    out.push(at(v.file, v.start, "floating-node-version", "note",
      `\`${written}\` floats: ${describe(v.runtime)}. Pin a major (\`${suggestion}\`) so the next Node release does not change your build${options.pin === undefined ? "; `--fix --pin 26` does it" : ""}.`,
      edit ? [edit] : undefined));
  }
  return out;
}

/** Every runtime the repo is known to run on (Dockerfiles, CI jobs, netlify, the repo pin). */
function runtimes(model: Model): NodeRuntime[] {
  return [...model.versions.map((v) => v.runtime), ...model.envs.flatMap((e) => e.commands.map((c) => c.runtime)), model.repoPin];
}

const satisfies = (v: string, range: string) => semver.satisfies(v, range, { includePrerelease: false });

export function checkEngines(model: Model): Finding[] {
  const out: Finding[] = [];
  const all = runtimes(model);
  const reaches26 = all.some((r) => r.floating || (r.major ?? 0) >= 26);
  const on25 = all.some((r) => r.major === 25 && !r.floating);
  for (const file of model.files.filter((f) => f.kind === "package")) {
    const json = parseJson<PackageJson>(file.text);
    const range = json?.engines?.node;
    if (typeof range !== "string" || !semver.validRange(range)) continue;
    const offset = Math.max(0, file.text.search(/"engines"\s*:\s*\{[^}]*"node"/));
    const nodeAt = file.text.indexOf('"node"', offset);
    if (!satisfies(NODE26, range)) {
      const runsOn = all.find((r) => r.floating || (r.major ?? 0) >= 26);
      out.push(at(file, nodeAt, "engines-exclude-node26", reaches26 ? "warning" : "note",
        `engines.node "${range}" does not allow Node ${NODE26}${runsOn ? `, but ${describe(runsOn)} runs this repo` : ""}: npm warns EBADENGINE, engine-strict installs fail. Add 26 when the tests pass on it.`));
    } else if (on25 && !satisfies("25.9.0", range)) {
      out.push(at(file, nodeAt, "engines-exclude-node26", "warning",
        `engines.node "${range}" leaves out Node 25, which a Dockerfile or job here runs. Move that job to 26 or widen the range.`));
    }
  }
  return out;
}

export function checkMismatch(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const v of model.versions) {
    if (v.what === "version-file" || shadowedByArg(model, v)) continue;
    const pin = model.pinFor(v.file.path);
    if (pin.major === undefined || pin.floating) continue;
    const m = v.runtime.major;
    if (m === undefined || m === pin.major || m < 25) continue;
    out.push(at(v.file, v.start, "node-version-mismatch", "warning",
      `The repo pins Node ${pin.major} (${pin.label}), but this runs ${describe(v.runtime)}. Pin it to ${pin.major}, or move the repo pin to ${m} after testing on it.`));
  }
  return out;
}

interface LockPackage {
  name: string;
  version?: string;
  engines?: unknown;
  hasInstallScript?: boolean;
  gypfile?: boolean;
  dependencies?: Record<string, string>;
  dev?: boolean;
}

function npmLockPackages(text: string): LockPackage[] {
  const json = parseJson<{ packages?: Record<string, Omit<LockPackage, "name">> }>(text);
  if (!json?.packages) return [];
  return Object.entries(json.packages)
    .filter(([path]) => path.includes("node_modules/"))
    .map(([path, p]) => ({ ...p, name: path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length) }));
}

/** `engines: {node: '>=18'}` under each `name@version:` key of a pnpm-lock.yaml. */
function pnpmLockEngines(text: string): { name: string; range: string; at: number }[] {
  const out: { name: string; range: string; at: number }[] = [];
  let current: string | undefined;
  let offset = 0;
  for (const l of text.split("\n")) {
    const key = /^ {2}['"]?\/?(@?[^@\s'"]+)[@/]([^:'"(\s]+)[^:]*['"]?:\s*$/.exec(l);
    if (key) current = `${key[1]}@${key[2]}`;
    const eng = /^ {4}engines:\s*\{\s*node:\s*['"]?([^'"}]+?)['"]?\s*[,}]/.exec(l);
    if (eng && current) out.push({ name: current, range: eng[1]!.trim(), at: offset });
    offset += l.length + 1;
  }
  return out;
}

const listed = (names: string[], max = 8) => `${names.slice(0, max).join(", ")}${names.length > max ? ` and ${names.length - max} more` : ""}`;

export function checkDependencyEngines(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const file of model.files.filter((f) => f.kind === "lockfile")) {
    const bad: string[] = [];
    if (file.path.endsWith("pnpm-lock.yaml")) {
      for (const p of pnpmLockEngines(file.text)) if (semver.validRange(p.range) && !satisfies(NODE26, p.range)) bad.push(`${p.name} (${p.range})`);
    } else {
      for (const p of npmLockPackages(file.text)) {
        const range = typeof p.engines === "object" && p.engines !== null ? (p.engines as { node?: unknown }).node : undefined;
        if (typeof range === "string" && semver.validRange(range) && !satisfies(NODE26, range)) bad.push(`${p.name}@${p.version ?? "?"} (${range})`);
      }
    }
    const unique = [...new Set(bad)];
    if (unique.length) {
      out.push(at(file, 0, "dependency-engines-exclude-node26", "note",
        `${unique.length} locked package(s) declare engines.node without ${NODE26}: ${listed(unique)}. npm warns EBADENGINE for each; update them or check them on 26.`));
    }
  }
  return out;
}

/** Build helpers that compile or download a binary for one NODE_MODULE_VERSION. node-addon-api alone is Node-API (ABI-stable). */
const ABI_TOOLS = ["nan", "bindings", "prebuild-install", "node-pre-gyp", "@mapbox/node-pre-gyp", "node-gyp-build", "node-gyp", "cmake-js"];

export function checkNativeAddons(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const file of model.files.filter((f) => f.kind === "lockfile" && !f.path.endsWith("pnpm-lock.yaml"))) {
    const native = npmLockPackages(file.text)
      .filter((p) => p.hasInstallScript && (p.gypfile || ABI_TOOLS.some((t) => p.dependencies?.[t] !== undefined)))
      .map((p) => `${p.name}@${p.version ?? "?"}`);
    const unique = [...new Set(native)];
    if (!unique.length) continue;
    out.push(at(file, 0, "native-addon-rebuild", "note",
      `${unique.length} native addon(s) build or download a binary per Node ABI: ${listed(unique)}. Node 26 is NODE_MODULE_VERSION ${ABI[26]} (24 was ${ABI[24]}): reinstall on 26, and check each has a Node 26 prebuild or that python3, make and g++ are in the image.`));
  }
  return out;
}

