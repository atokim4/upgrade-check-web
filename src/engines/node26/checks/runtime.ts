// Shell commands that stop working on Node 25/26: corepack, yarn in node:26 images, package managers nothing
// installs, and the removed --experimental-transform-types flag.
import { availableAt, type Env, type Model, type PackageManagerPin, type RunCommand } from "../contexts.ts";
import { describe, severityAt } from "../node-version.ts";
import { COREPACK_PIN, YARN1_PIN } from "../rules.ts";
import { lineOf, lineText } from "../sources.ts";
import type { Edit, Finding, Severity } from "../types.ts";

const capForDocs = (env: Env, s: Severity): Severity => (env.where === "doc" && s === "error" ? "warning" : s);

/** USER set to someone other than root before this command: `npm install -g` would hit EACCES. */
function nonRootUser(env: Env, at: number): string | undefined {
  const u = [...env.users].filter((x) => x.at < at).pop();
  return u && u.name !== "root" && u.name !== "0" ? u.name : undefined;
}

function finding(rule: string, severity: Severity, c: RunCommand, message: string, insert?: string): Finding {
  const file = c.env.file;
  const line = lineOf(file.text, c.start);
  const edits: Edit[] | undefined = insert && severity !== "note" && c.editable && !nonRootUser(c.env, c.start) ? [{ start: c.start, end: c.start, text: insert }] : undefined;
  return { rule, severity: capForDocs(c.env, severity), message, file: file.path, line, snippet: lineText(file.text, line).trim(), edits };
}

const isBerry = (pm: PackageManagerPin | undefined) => pm?.name === "yarn" && !/^1\./.test(pm.version);

export function checkCorepack(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const env of model.envs) {
    // One finding per env: the first corepack call is the one that fails; once fixed, the rest work.
    const c = env.commands.find((x) => x.program === "corepack" && !availableAt(env, x.start, "corepack"));
    if (!c) continue;
    const severity = severityAt(c.runtime, 25);
    const user = nonRootUser(env, c.start);
    let message = `\`${c.text}\` runs on ${describe(c.runtime)}: Node 25+ has no corepack binary, so this fails with "corepack: not found". Install it first with \`npm install -g corepack@${COREPACK_PIN}\`.`;
    if (severity === "note") message = `\`${c.text}\` works on ${describe(c.runtime)}, but breaks with "corepack: not found" on Node 25+ (node:lts is 26 now). Install corepack from npm before moving.`;
    if (c.runtime.major === 25) message += ` On Node 25, corepack ${COREPACK_PIN} prints an EBADENGINE warning (it declares ^22.22.2 || ^24.15.0 || >=26.0.0); prefer Node 26.`;
    if (user && severity !== "note") message += ` The stage runs as USER ${user} here, so put the install before the USER line (not rewritten).`;
    out.push(finding("corepack-not-bundled", severity, c, message, `npm install -g corepack@${COREPACK_PIN} && `));
  }
  return out;
}

export function checkYarnInImage(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const env of model.envs) {
    if (!env.image) continue;
    const c = env.commands.find((x) => x.program === "yarn" && !availableAt(env, x.start, "yarn"));
    if (!c || c.runtime.major === undefined) continue;
    const severity = severityAt(c.runtime, 26);
    const pm = model.packageManagerFor(env.file.path);
    const berry = isBerry(pm);
    const insert = berry ? `npm install -g corepack@${COREPACK_PIN} && corepack enable && ` : `npm install -g yarn@${YARN1_PIN} && `;
    const how = berry ? `this repo pins ${pm!.raw}, so install corepack and run \`corepack enable\` first` : `install it first with \`npm install -g yarn@${YARN1_PIN}\``;
    const message = severity === "note"
      ? `\`${c.text}\` works on ${describe(c.runtime)}, but node images stop bundling Yarn 1 at Node 26 ("yarn: not found").`
      : `\`${c.text}\` runs in ${describe(c.runtime)}, and node images no longer bundle Yarn 1 as of Node 26 ("yarn: not found"); ${how}.`;
    out.push(finding("yarn-not-in-node26-image", severity, c, message, insert));
  }
  return out;
}

export function checkPackageManagerInstalled(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const env of model.envs) {
    // Netlify and Vercel install the package manager themselves; a script's machine is unknown.
    if ((env.where !== "docker" && env.where !== "ci") || env.file.kind === "netlify" || env.file.kind === "vercel") continue;
    const pm = model.packageManagerFor(env.file.path);
    if (!pm || (pm.name !== "pnpm" && !isBerry(pm))) continue;
    const programs = pm.name === "pnpm" ? new Set(["pnpm", "pnpx"]) : new Set(["yarn"]);
    const tool = pm.name as "pnpm" | "yarn";
    const c = env.commands.find((x) => programs.has(x.program));
    // A preinstalled Yarn 1 (GitHub-hosted runners) refuses to run a Yarn 2+ project without corepack.
    if (!c || availableAt(env, c.start, tool, { ignorePreinstalled: tool === "yarn" })) continue;
    // corepack and yarn-in-image findings already cover these envs.
    if (env.commands.some((x) => x.program === "corepack" && x.start < c.start)) continue;
    if (tool === "yarn" && env.image) continue;
    if (severityAt(c.runtime, 25) === "note") continue;
    const insert = tool === "pnpm" ? `npm install -g pnpm@${pm.version} && ` : undefined;
    const message = `\`${c.text}\` needs ${pm.raw} from package.json, but nothing installs ${tool} before it on ${describe(c.runtime)} (no corepack on Node 25+).${
      tool === "pnpm" ? ` Install it first: \`npm install -g pnpm@${pm.version}\`${env.where === "ci" && env.file.kind === "workflow" ? " or pnpm/action-setup" : ""}.` : " Install corepack from npm and run `corepack enable` first."
    }`;
    out.push(finding("package-manager-not-installed", "warning", c, message, insert));
  }
  return out;
}

const FLAG = /(^|[\s"'=])--experimental-transform-types\b/g;

export function checkTransformTypesFlag(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const file of model.files) {
    if (file.kind === "source" || file.kind === "lockfile") continue;
    for (const m of file.text.matchAll(FLAG)) {
      const at = m.index! + m[1]!.length;
      const line = lineOf(file.text, at);
      const text = lineText(file.text, line).trim();
      if (text.startsWith("#") || text.startsWith("//")) continue;
      const cmd = model.envs.filter((e) => e.file === file).flatMap((e) => e.commands).find((c) => c.start <= at && at <= c.end);
      const runtime = cmd?.runtime ?? model.envs.find((e) => e.file === file)?.runtime ?? model.pinFor(file.path);
      const severity = severityAt(runtime, 26);
      out.push({
        rule: "removed-transform-types-flag",
        severity: file.kind === "agent-doc" && severity === "error" ? "warning" : severity,
        message: `--experimental-transform-types was removed in Node 26, which exits with "bad option" (here: ${describe(runtime)}). Drop it; enums, namespaces and parameter properties then need tsc or tsx.`,
        file: file.path,
        line,
        snippet: text,
      });
    }
  }
  return out;
}
