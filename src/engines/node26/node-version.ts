import semver from "semver";

/**
 * What `lts` and `current` resolve to today. From https://nodejs.org/dist/index.json: v26.13.0 (2026-10-28) is the
 * first release with `"lts": "Lithium"`, and 27.0.0 is still an alpha, so both floating names give Node 26.
 */
export const LTS_MAJOR = 26;
export const CURRENT_MAJOR = 26;
export const AS_OF = "2026-11-10";

/** LTS codenames from https://nodejs.org/dist/index.json (the `lts` field of each line's releases). */
export const CODENAMES: Record<string, number> = {
  argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22,
  krypton: 24, lithium: 26,
};

/** NODE_MODULE_VERSION per major (the `modules` field in index.json). */
export const ABI: Record<number, number> = { 20: 115, 22: 127, 24: 137, 25: 141, 26: 147 };

export interface NodeRuntime {
  /** Major the runtime resolves to today; undefined when it can't be known from the repo. */
  major: number | undefined;
  /** The name moves to a new major on its own (node:lts, lts/*, latest, an open range). */
  floating?: "lts" | "current";
  /** How it was chosen, for messages: "node:lts-alpine", "setup-node lts/*", ".nvmrc 22". */
  label: string;
}

export const UNKNOWN: NodeRuntime = { major: undefined, label: "an unknown Node version" };

const floating = (kind: "lts" | "current", label: string): NodeRuntime => ({ major: kind === "lts" ? LTS_MAJOR : CURRENT_MAJOR, floating: kind, label });

/**
 * A version spec as setup-node, nvm and .node-version accept it: `26`, `26.x`, `v26.1.0`, `lts/*`, `lts/jod`,
 * `node`, `latest`, `>=22`. Returns undefined for things that aren't a version (an unresolved `${{ … }}`).
 */
export function fromSpec(raw: string, label = raw): NodeRuntime | undefined {
  const spec = raw.trim().replace(/^['"]|['"]$/g, "").trim().toLowerCase();
  if (!spec || spec.includes("${") || spec.includes("$(")) return undefined;
  if (spec === "lts/*" || spec === "lts" || spec === "lts/-0" || spec === "--lts") return floating("lts", label);
  if (spec === "node" || spec === "latest" || spec === "current" || spec === "stable" || spec === "*" || spec === "x") return floating("current", label);
  const rel = /^lts\/-(\d+)$/.exec(spec);
  if (rel) return { major: LTS_MAJOR - 2 * Number(rel[1]), label };
  const code = /^lts\/([a-z]+)$/.exec(spec) ?? /^([a-z]+)$/.exec(spec);
  if (code && CODENAMES[code[1]!] !== undefined) return { major: CODENAMES[code[1]!], label };
  const exact = /^v?(\d+)(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?(?:-[\w.]+)?$/.exec(spec);
  if (exact) return { major: Number(exact[1]), label };
  const range = semver.validRange(spec);
  if (!range) return undefined;
  // setup-node and nvm pick the newest version a range allows, so an open range is as floating as `latest`.
  if (semver.intersects(range, "99.x")) return floating("current", label);
  for (let m = CURRENT_MAJOR; m >= 4; m--) if (semver.intersects(range, `${m}.x`)) return { major: m, label };
  return undefined;
}

export interface DockerNodeImage {
  runtime: NodeRuntime;
  /** The image reference as written, and where its tag sits (for --pin). */
  repo: string;
  tag: string | undefined;
  digest: boolean;
}

/** `node`, `library/node`, `docker.io/library/node`, `public.ecr.aws/docker/library/node`, `cimg/node`… */
const NODE_REPO = /^(?:[\w.-]+(?::\d+)?\/)*node$/;
const VARIANT = /^(?:alpine[\d.]*|slim|bookworm|bullseye|buster|trixie|stretch|jessie|bookworm-slim|bullseye-slim|trixie-slim|buster-slim)$/;

/** Parses an image reference; undefined unless it's an official-style `node` image. */
export function fromDockerImage(ref: string): DockerNodeImage | undefined {
  const at = ref.indexOf("@");
  const digest = at !== -1;
  const name = digest ? ref.slice(0, at) : ref;
  const colon = name.lastIndexOf(":");
  const hasTag = colon > name.lastIndexOf("/");
  const repo = hasTag ? name.slice(0, colon) : name;
  const tag = hasTag ? name.slice(colon + 1) : undefined;
  if (!NODE_REPO.test(repo.toLowerCase())) return undefined;
  const t = (tag ?? "latest").toLowerCase();
  if (t.includes("$")) return { runtime: { major: undefined, label: ref }, repo, tag, digest };
  const label = ref;
  let runtime: NodeRuntime;
  const num = /^(\d+)(?:[.-]|$)/.exec(t);
  const lts = /^lts(?:-(.+))?$/.exec(t);
  const code = /^([a-z]+)(?:-|$)/.exec(t);
  if (num) runtime = { major: Number(num[1]), label };
  else if (lts) {
    const rest = lts[1]?.split("-")[0];
    runtime = rest && CODENAMES[rest] !== undefined ? { major: CODENAMES[rest], label } : floating("lts", label);
  } else if (t === "latest" || t === "current" || t.startsWith("current-") || VARIANT.test(t)) runtime = floating("current", label);
  else if (code && CODENAMES[code[1]!] !== undefined) runtime = { major: CODENAMES[code[1]!], label };
  else runtime = { major: undefined, label };
  return { runtime, repo, tag, digest };
}

/**
 * Images known to carry their own Node: Playwright installs Node 26 in images built from microsoft/playwright
 * 38fb53bf4c (2026-10-29, utils/docker/Dockerfile.noble NODE_VERSION=26; it was 24 before) and adds Yarn 1 with
 * `npm install -g yarn`, but no corepack. The image tag doesn't say which side of that commit it was built on.
 */
export function fromKnownImage(ref: string): { runtime: NodeRuntime; yarn: boolean } | undefined {
  if (/^mcr\.microsoft\.com\/playwright(?:\/[\w-]+)?(?::|@|$)/.test(ref)) {
    return { runtime: { major: undefined, label: `${ref} (Playwright images ship Node 26 since 2026-10-29)` }, yarn: true };
  }
  return undefined;
}

/** The tag that pins a floating node image to `major`, keeping its variant: lts-alpine -> 26-alpine, latest -> 26. */
export function pinnedTag(tag: string | undefined, major: number): string {
  const t = tag ?? "latest";
  if (t === "latest" || t === "lts" || t === "current") return String(major);
  const prefixed = /^(?:lts|current)-(.+)$/.exec(t);
  if (prefixed) return `${major}-${prefixed[1]}`;
  if (VARIANT.test(t)) return `${major}-${t}`;
  return t;
}

/** Severity for something that stops working at `removedIn`: error when the runtime is there (or moves there on its own), a warning when it can't be told, a note for a pin below it. */
export function severityAt(runtime: NodeRuntime, removedIn: number): "error" | "warning" | "note" {
  if (runtime.major === undefined) return "warning";
  return runtime.major >= removedIn ? "error" : "note";
}

export function describe(runtime: NodeRuntime): string {
  if (runtime.major === undefined) return runtime.label;
  if (runtime.floating === "lts") return `${runtime.label} (Node ${runtime.major} LTS since 2026-10-28)`;
  if (runtime.floating) return `${runtime.label} (Node ${runtime.major} today)`;
  return `${runtime.label} (Node ${runtime.major})`;
}
