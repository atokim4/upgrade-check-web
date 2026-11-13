import type { FixKind } from "./types.js";

export type SpecKind =
  | "node"
  | "jsr"
  | "npm"
  | "deno-std"
  | "deno-x"
  | "esm-sh"
  | "cdn"
  | "esm-town"
  | "val-town-std"
  | "url"
  | "relative"
  | "bare";

export interface SpecPlan {
  kind: SpecKind;
  fix: FixKind;
  message: string;
  /** npm package name the code imports after the move. */
  name?: string;
  /** package.json dependency value (semver range or `npm:` alias). */
  dep?: string;
  /** New specifier text for the import, when the import has to change. */
  rewrite?: string;
  /** Suggested replacement for manual items. */
  replacement?: string;
  /** Extra caveat reported next to an otherwise automatic move. */
  caveat?: { fix: FixKind; message: string; replacement?: string };
}

/** Exact versions from deno.lock (`jsr:@std/path@^1` → `1.0.8`). */
export type LockedVersions = Map<string, string>;

const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

export function isValidNpmName(name: string): boolean {
  return NPM_NAME.test(name) && name.length <= 214;
}

interface PackageRef {
  name: string;
  version: string | null;
  /** "" or "/sub/path" */
  subpath: string;
}

/** Splits `@scope/name@1.2/sub` or `name@^1/sub` (no protocol). */
export function parsePackageRef(ref: string): PackageRef | null {
  const m = /^((?:@[^/@]+\/)?[^/@]+)(?:@([^/]*))?(\/.*)?$/.exec(ref);
  if (!m || !m[1]) return null;
  return { name: m[1], version: m[2] ? m[2] : null, subpath: m[3] ?? "" };
}

/** `@std/path` → `@jsr/std__path` (jsr.io/docs/npm-compatibility). */
export function jsrNpmName(name: string): string | null {
  const m = /^@([^/]+)\/([^/]+)$/.exec(name);
  return m ? `@jsr/${m[1]}__${m[2]}` : null;
}

function pinned(version: string | null, locked: string | undefined): { range: string; unpinned: boolean } {
  if (version && version !== "*" && version !== "latest") return { range: version, unpinned: false };
  if (locked) return { range: `^${locked}`, unpinned: false };
  return { range: "*", unpinned: true };
}

/** @std modules that call Deno.* at runtime (grep of the published @jsr/std__* tarballs, 2026-11-13). */
const STD_DENO_ONLY: Record<string, { paths: RegExp; hint: string }> = {
  "@std/dotenv": { paths: /.*/, hint: "`node --env-file=.env` or `process.loadEnvFile()`" },
  "@std/fs": {
    paths: /^(?:|\/(?:exists|walk|ensure[-_]\w+|copy|move|empty[-_]dir|expand[-_]glob|mod))$/,
    hint: "node:fs / node:fs/promises (existsSync, readdir({ recursive }), mkdir({ recursive }), cp, rename, glob)",
  },
  "@std/http": { paths: /^\/(?:file[-_]server|unstable[-_]file[-_]server)$/, hint: "a static-file middleware (sirv, hono/serve-static)" },
  "@std/log": { paths: /^(?:|\/mod|\/(?:rotating[-_])?file[-_]handler)$/, hint: "a Node logger (pino) for file output" },
  "@std/net": { paths: /.*/, hint: "node:net (listen on port 0 to get a free port)" },
  "@std/testing": {
    paths: /^\/(?:unstable[-_])?(?:snapshot|bdd)$/,
    hint: "node:test has describe/it/before/after (bdd); snapshots: t.assert.snapshot or Vitest toMatchSnapshot",
  },
  "@std/fmt": { paths: /^\/printf$/, hint: "util.format / util.inspect (only the %i and %I verbs call Deno.inspect)" },
  "@std/cli": {
    paths: /^\/(?:prompt[-_]secret|unstable[-_]\w+)$/,
    hint: "a Node prompt/spinner package; parseArgs also works with process.argv.slice(2)",
  },
};

function stdCaveat(name: string, subpath: string): SpecPlan["caveat"] {
  const rule = STD_DENO_ONLY[name];
  if (!rule || !rule.paths.test(subpath)) return undefined;
  return {
    fix: "manual",
    message: `${name}${subpath} calls Deno.* inside the package, so it installs under Node but fails at runtime`,
    replacement: rule.hint,
  };
}

/** Old deno.land/std modules that Node covers natively. */
const STD_NODE_HINT: Record<string, string> = {
  path: "node:path (or jsr:@std/path, which runs on Node)",
  fs: "node:fs/promises",
  dotenv: "`node --env-file=.env` or `process.loadEnvFile()`",
  flags: "node:util parseArgs",
  assert: "node:assert/strict (or jsr:@std/assert)",
  testing: "node:assert/strict + node:test (or jsr:@std/assert)",
  uuid: "crypto.randomUUID()",
  http: "Deno.serve-style handler on @hono/node-server; std/http/server.ts `serve` was removed from std long ago",
  encoding: "jsr:@std/encoding, or Buffer / TextEncoder",
  async: "jsr:@std/async",
  datetime: "jsr:@std/datetime",
  crypto: "node:crypto / globalThis.crypto",
  log: "a Node logger (pino) or jsr:@std/log",
  io: "node:stream / Web Streams",
  streams: "jsr:@std/streams or Web Streams",
};

/**
 * deno.land/x modules and where they went. `same: true` = the npm package is published from the same source with the
 * same version numbers (checked on npm and cdn.deno.land 2026-11-13), so the URL's version can be kept as is.
 */
const DENO_X_PACKAGES: Record<string, { name: string; same?: boolean }> = {
  hono: { name: "hono", same: true },
  grammy: { name: "grammy", same: true },
  zod: { name: "zod", same: true },
  // cdn.deno.land meta upload_options: panva/jose dist/deno at the npm tag; porsager/postgres deno/ at the npm tag.
  jose: { name: "jose", same: true },
  postgresjs: { name: "postgres", same: true },
  oak: { name: "jsr:@oak/oak (JSR versions start at 12.6.2)" },
  djwt: { name: "jsr:@zaubrik/djwt (only 3.0.2 on JSR)" },
  cliffy: { name: "jsr:@cliffy/command 1.x (renumbered from 0.x)" },
  discordeno: { name: "@discordeno/bot (new major, different API)" },
  postgres: { name: "pg or postgres (different API from deno-postgres)" },
  mongo: { name: "mongodb (different API)" },
  dotenv: { name: "`node --env-file=.env`" },
  bcrypt: { name: "bcryptjs (different API)" },
  sqlite: { name: "node:sqlite DatabaseSync (different API)" },
  redis: { name: "redis or ioredis (different API)" },
  opine: { name: "express (opine is an Express port)" },
  aleph: { name: "no Node port: pick a framework" },
};

const VAL_TOWN_STD: Record<string, string> = {
  sqlite: "D1 on Workers; on Node: the Turso/libSQL client (@libsql/client) or node:sqlite with an export",
  blob: "R2 on Workers; on Node: object storage (S3/R2) or the file system",
  email: "a mail API (Cloudflare Email Service, Resend, SES)",
  openai: "the openai npm package (or Cloudflare AI Gateway)",
  utils: "serveFile/readFile → node:fs/promises readFile + a static-asset middleware (docs.val.town/migration/cloudflare)",
  fetch: "global fetch",
  set: "your own storage",
};

/** Val Town std modules that hold no data: replacing them is code work, not a hosting decision. */
const VAL_TOWN_HELPERS = new Set(["utils", "fetch"]);

function npmLike(kind: SpecKind, host: string, ref: string, locked: string | undefined, query: string): SpecPlan {
  const parsed = parsePackageRef(ref);
  if (!parsed || !isValidNpmName(parsed.name)) {
    return { kind, fix: "manual", message: `${host} URL that is not a plain package path: find the npm package or vendor the file` };
  }
  const { range, unpinned } = pinned(parsed.version, locked);
  const fileLike = /\.[cm]?[jt]sx?$|\.json$/.test(parsed.subpath);
  const plan: SpecPlan = {
    kind,
    fix: fileLike ? "manual" : "auto",
    name: parsed.name,
    dep: range,
    rewrite: parsed.name + parsed.subpath,
    message: `${host} import → npm package ${parsed.name}@${range}`,
  };
  if (fileLike) {
    plan.message = `${host} import of a file inside ${parsed.name}: check the package's exports for the matching subpath`;
    plan.replacement = `${parsed.name}${parsed.subpath}`;
    delete plan.rewrite;
  } else if (unpinned) {
    plan.caveat = { fix: "manual", message: `${parsed.name} has no version in the URL: pin the one you tested` };
  } else if (query) {
    plan.caveat = { fix: "info", message: `${host} query ${query} dropped (CDN build flags do not apply to npm installs)` };
  }
  return plan;
}

function jsrPlan(ref: string, locked: string | undefined): SpecPlan {
  const parsed = parsePackageRef(ref);
  const npmName = parsed ? jsrNpmName(parsed.name) : null;
  if (!parsed || !npmName) return { kind: "jsr", fix: "manual", message: `JSR specifier jsr:${ref} could not be parsed` };
  const { range, unpinned } = pinned(parsed.version, locked);
  const plan: SpecPlan = {
    kind: "jsr",
    fix: "auto",
    name: parsed.name,
    dep: `npm:${npmName}@${range}`,
    rewrite: parsed.name + parsed.subpath,
    message: `JSR import → ${parsed.name} from npm.jsr.io (${npmName}@${range})`,
    caveat: stdCaveat(parsed.name, parsed.subpath),
  };
  if (!plan.caveat && unpinned) {
    plan.caveat = { fix: "manual", message: `jsr:${parsed.name} has no version and no deno.lock entry: pin one` };
  }
  return plan;
}

/**
 * Plans the Node-side form of one import specifier, as written in source or as an import-map target.
 * Returns null for specifiers that need nothing (node:, relative, bare npm names).
 */
export function planSpecifier(spec: string, lock: LockedVersions = new Map()): SpecPlan | null {
  if (spec.startsWith("node:")) return null;
  if (/^\.{0,2}\//.test(spec) || spec.startsWith("file:")) return null;

  if (spec.startsWith("jsr:")) {
    const ref = spec.slice(4).replace(/^\//, "");
    return jsrPlan(ref, lock.get(spec) ?? lock.get(`jsr:${parsePackageRef(ref)?.name ?? ""}`));
  }
  if (spec.startsWith("npm:")) {
    const ref = spec.slice(4).replace(/^\//, "");
    const name = parsePackageRef(ref)?.name ?? "";
    return npmLike("npm", "npm:", ref, lock.get(spec) ?? lock.get(`npm:${name}`), "");
  }

  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = decodeURIComponent(url.pathname);
  const host = url.hostname.replace(/^www\./, "");

  if (host === "deno.land") {
    const std = /^\/std(?:@([^/]+))?\/([^/]+)(\/.*)?$/.exec(path);
    if (std) {
      const mod = std[2] ?? "";
      return {
        kind: "deno-std",
        fix: "manual",
        message: `deno.land/std${std[1] ? `@${std[1]}` : ""}/${mod} (pre-JSR std; JSR @std/${mod} 1.x changed some APIs)`,
        replacement: STD_NODE_HINT[mod] ?? `jsr:@std/${mod} if it exists on JSR, else vendor the file`,
      };
    }
    const x = /^\/x\/([^/@]+)(?:@([^/]+))?(\/.*)?$/.exec(path);
    if (x) {
      const mod = x[1] ?? "";
      const known = DENO_X_PACKAGES[mod];
      const version = x[2]?.replace(/^v(?=\d)/, "") ?? null;
      const isEntry = !x[3] || /^\/(mod|index|deps)\.[jt]s$/.test(x[3]);
      if (known?.same && isEntry && version) {
        return {
          kind: "deno-x",
          fix: "auto",
          name: known.name,
          dep: version,
          rewrite: known.name,
          message: `deno.land/x/${mod}@${x[2]} → npm package ${known.name}@${version} (same version as the URL)`,
        };
      }
      return {
        kind: "deno-x",
        fix: "manual",
        message: `deno.land/x/${mod}${x[2] ? `@${x[2]}` : ""}${x[3] ?? ""}: find its npm/JSR package or vendor the file`,
        replacement: known?.name,
      };
    }
    return { kind: "url", fix: "manual", message: `deno.land URL ${path}: vendor the file or find the package` };
  }

  if (host === "esm.town" || (host === "val.town" && path.startsWith("/v/"))) {
    const std = /^\/v\/std\/([^/?]+)/.exec(path);
    if (std) {
      const mod = (std[1] ?? "").replace(/\.(ts|tsx|js)$/, "");
      if (VAL_TOWN_HELPERS.has(mod)) {
        return {
          kind: "val-town-std",
          fix: "manual",
          message: `Val Town std/${mod}: a code helper (no stored data), stops loading with Val Town (read-only 2026-12-10, off 2027-01-10)`,
          replacement: VAL_TOWN_STD[mod],
        };
      }
      return {
        kind: "val-town-std",
        fix: "decision",
        message: `Val Town std/${mod}: a hosted service that stops with Val Town (read-only 2026-12-10, off 2027-01-10)`,
        replacement: VAL_TOWN_STD[mod] ?? "a service of your own",
      };
    }
    return {
      kind: "esm-town",
      fix: "manual",
      message: "esm.town import of another val: copy that val's files into the project and import them relatively",
      replacement: "vendored copy with its license and attribution (docs.val.town/migration/cloudflare/migrate-code)",
    };
  }

  if (host === "esm.sh") {
    let ref = path.replace(/^\/(?:v\d+|stable)\//, "/").slice(1).replace(/^\*/, "");
    if (ref.startsWith("jsr/")) return jsrPlan(ref.slice(4), undefined);
    if (ref.startsWith("gh/")) {
      return { kind: "esm-sh", fix: "manual", message: "esm.sh/gh/ import of a GitHub repo: vendor it or find its npm package" };
    }
    ref = ref.replace(/\/(?:es20\d\d|esnext|deno|denonext|node)\/.*$/, "");
    return npmLike("esm-sh", "esm.sh", ref, undefined, url.search);
  }

  const cdn =
    host === "cdn.jsdelivr.net" && path.startsWith("/npm/")
      ? path.slice(5).replace(/\/\+esm$/, "")
      : host === "unpkg.com" || host === "cdn.skypack.dev"
        ? path.slice(1)
        : host === "ga.jspm.io" && path.startsWith("/npm:")
          ? path.slice(5)
          : null;
  if (cdn !== null) return npmLike("cdn", host, cdn, undefined, url.search);

  return {
    kind: "url",
    fix: "manual",
    message: `URL import from ${host}: use an npm package if there is one, else vendor the file with attribution`,
  };
}
