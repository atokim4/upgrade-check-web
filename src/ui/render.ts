import type { CheckerReport, Finding, Report, Severity } from "../lib/checks.ts";
import type { LoadedRepo } from "../lib/loader.ts";
import { copyButton, h, icon, ICONS, richText } from "./dom.ts";

const SEVERITY_LABEL: Record<Severity, string> = { error: "Breaks", warning: "Likely breaks", note: "Note" };
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Link to the line on GitHub, or undefined for a local folder. */
function lineUrl(repo: LoadedRepo, f: Finding): string | undefined {
  if (repo.source.kind !== "github") return undefined;
  const { owner, repo: name } = repo.source.ref;
  const path = f.file.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${owner}/${name}/blob/${repo.source.sha}/${path}#L${f.line}`;
}

function diffBlock(diff: string): HTMLPreElement {
  const pre = h("pre", { class: "diff", tabindex: 0, "aria-label": "Suggested change as a unified diff" });
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    const kind = line.startsWith("+++") || line.startsWith("---") ? "head" : line.startsWith("@@") ? "hunk" : line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx";
    pre.append(h("span", { class: `d-${kind}` }, line), "\n");
  }
  return pre;
}

function findingItem(repo: LoadedRepo, f: Finding): HTMLLIElement {
  const url = lineUrl(repo, f);
  const where = `${f.file}:${f.line}`;
  const location = url ? h("a", { href: url, class: "loc", target: "_blank", rel: "noopener" }, where) : h("span", { class: "loc" }, where);
  const details = h(
    "details",
    { class: "explain" },
    h("summary", {}, f.diff ? "Why, and the fix" : "Why, and what to change"),
    h("dl", {}, h("dt", {}, "Why it breaks"), h("dd", {}, richText(f.why)), h("dt", {}, "What to change"), h("dd", {}, richText(f.fix))),
    f.diff && h("div", { class: "fix" }, h("div", { class: "fix-bar" }, h("span", {}, "Safe automatic fix"), copyButton("Copy diff", () => f.diff!)), diffBlock(f.diff)),
    h("p", { class: "source" }, h("a", { href: f.sourceUrl, target: "_blank", rel: "noopener" }, "Source for this rule", icon(ICONS.external, "icon icon-inline"))),
  );
  return h(
    "li",
    { class: `finding sev-${f.severity}` },
    h("div", { class: "finding-head" }, h("span", { class: "sev" }, SEVERITY_LABEL[f.severity]), h("h4", {}, richText(f.title))),
    h(
      "p",
      { class: "finding-where" },
      location,
      h("span", { class: "rule" }, f.rule),
      f.approx && h("span", { class: "approx", title: "Found by a text pattern that stands in for the CLI's syntax-tree check. Worth a look; the CLI confirms it." }, "pattern match"),
    ),
    f.snippet && h("pre", { class: "snippet" }, f.snippet.trim()),
    h("p", { class: "message" }, richText(f.message)),
    details,
  );
}

/** The CLI's repo and version, or the official page for rules that live only here. */
function sourceLink(c: CheckerReport): HTMLAnchorElement {
  const text = c.version ? `${c.repoUrl.replace("https://github.com/", "")} ${c.version}` : "official notice";
  return h("a", { href: c.repoUrl, target: "_blank", rel: "noopener" }, text);
}

/** Checkers that ran and found nothing, one line each. */
function cleanList(clean: CheckerReport[]): HTMLElement {
  return h(
    "section",
    { class: "clean-list", "aria-labelledby": "clean-heading" },
    h("h3", { id: "clean-heading" }, icon(ICONS.check), `Checked, nothing breaks (${clean.length})`),
    h(
      "ul",
      {},
      ...clean.map((c) =>
        h(
          "li",
          {},
          h("span", { class: "clean-name" }, c.name),
          h("span", { class: "clean-meta" }, `${plural(c.rulesChecked, "check")} · `, sourceLink(c)),
          ...c.notes.map((n) => h("span", { class: "clean-note" }, n)),
        ),
      ),
    ),
  );
}

function checkerSection(repo: LoadedRepo, c: CheckerReport): HTMLElement {
  const main = c.findings.filter((f) => f.severity !== "note");
  const notes = c.findings.filter((f) => f.severity === "note");
  const headingId = `checker-${c.id}`;
  const count = main.length ? plural(main.length, "finding") : "Nothing breaks";
  const body: (Node | false)[] = [];
  if (main.length) body.push(h("ol", { class: "findings" }, ...main.map((f) => findingItem(repo, f))));
  else body.push(h("p", { class: "clean" }, icon(ICONS.check), h("span", {}, `No breaking change found by the ${plural(c.rulesChecked, "check")} of this group.`)));
  if (notes.length) {
    body.push(h("details", { class: "notes" }, h("summary", {}, `${plural(notes.length, "note")} (no action needed)`), h("ol", { class: "findings" }, ...notes.map((f) => findingItem(repo, f)))));
  }
  for (const n of c.notes) body.push(h("p", { class: "checker-note" }, icon(ICONS.info), h("span", {}, n)));

  const tools = h("div", { class: "checker-tools" });
  if (c.patch) tools.append(copyButton("Copy all fixes as one patch", () => c.patch!, "btn"));
  if (c.cli) {
    const { label, command } = c.cli;
    tools.append(h("p", { class: "cli" }, `${label}: `, h("code", {}, command), " ", copyButton("Copy", () => command, "btn btn-small btn-quiet")));
  }

  return h(
    "section",
    { class: `checker ${main.length ? "has-findings" : "is-clean"}`, "aria-labelledby": headingId },
    h(
      "header",
      { class: "checker-head" },
      h("h3", { id: headingId }, c.name, h("span", { class: "count" }, count)),
      h("p", { class: "about" }, c.about, " ", sourceLink(c)),
    ),
    ...body,
    tools,
  );
}

function coverage(repo: LoadedRepo): HTMLElement {
  const read = repo.texts.size;
  const left = Object.values(repo.plan.skipped).reduce((a, b) => a + b, 0);
  const parts = [`Read ${read} of the ${plural(repo.paths.length, "file")} in ${repo.source.kind === "github" ? "the repo" : "the folder"}`];
  if (repo.source.kind === "github") parts[0] += ` at ${repo.source.sha.slice(0, 7)}`;
  let text = `${parts[0]}: CI, Docker, package and framework config files first, then workflow JSON, SQL migrations and source code.`;
  if (left) text += ` ${plural(left, "file")} that a check could look at ${left === 1 ? "was" : "were"} left out to keep this quick (mostly source files); the CLI reads everything.`;
  if (repo.listTruncated) text += " The file list itself was cut short because the repository is very large.";
  if (repo.unreadable.length) text += ` ${plural(repo.unreadable.length, "file")} couldn't be downloaded and ${repo.unreadable.length === 1 ? "was" : "were"} skipped: ${repo.unreadable.slice(0, 3).join(", ")}${repo.unreadable.length > 3 ? ", …" : ""}.`;
  return h("p", { class: "coverage" }, text);
}

const breaks = (c: CheckerReport) => c.findings.some((f) => f.severity !== "note");

export function renderReport(target: HTMLElement, repo: LoadedRepo, report: Report): void {
  const all = report.checkers.flatMap((c) => c.findings);
  // Checkers with something to change first, then the ones with notes only; clean ones collapse into one list.
  const withFindings = report.checkers.filter((c) => c.findings.length).sort((a, b) => Number(breaks(b)) - Number(breaks(a)));
  const clean = report.checkers.filter((c) => !c.findings.length);
  const breaking = all.filter((f) => f.severity !== "note");
  const errors = all.filter((f) => f.severity === "error").length;
  const fixable = breaking.filter((f) => f.diff).length;
  const label = repo.source.kind === "github" ? `${repo.source.ref.owner}/${repo.source.ref.repo}` : `${repo.name} (local folder)`;
  const title = breaking.length
    ? breaking.length === 1
      ? `1 line to change${errors ? ", and it breaks for sure" : ""}`
      : `${breaking.length} lines to change${errors ? `, ${errors === breaking.length ? "all" : errors} of them break for sure` : ""}`
    : "Nothing here breaks on these upgrades";
  const sub = breaking.length
    ? fixable
      ? `${fixable === breaking.length ? (fixable === 1 ? "It has" : "All have") : `${fixable} ${fixable === 1 ? "has" : "have"}`} a safe automatic fix you can copy as a diff.`
      : "None of them can be rewritten automatically; each one says what to change."
    : "That covers what the checks could see. Read the coverage line below before you rely on it.";

  target.replaceChildren(
    h(
      "header",
      { class: `verdict ${breaking.length ? "is-bad" : "is-good"}` },
      h("p", { class: "verdict-repo" }, label),
      h("h2", {}, title),
      h("p", {}, sub),
    ),
    coverage(repo),
    ...withFindings.map((c) => checkerSection(repo, c)),
    ...(clean.length ? [cleanList(clean)] : []),
    ...(report.notUsed.length ? [h("p", { class: "not-used" }, `Not used in the files read, so not run: ${report.notUsed.map((c) => c.name).join(", ")}.`)] : []),
  );
}

export interface ErrorView {
  title: string;
  body: string;
  /** Show the local options (folder, CLI). */
  offerLocal: boolean;
}

export function renderError(target: HTMLElement, view: ErrorView): void {
  const children: Node[] = [h("h2", {}, view.title), h("p", {}, view.body)];
  if (view.offerLocal) {
    children.push(
      h("p", {}, "You can still check it: choose its folder above (the files stay on your computer), or run the scanners on a checkout:"),
      h(
        "pre",
        { class: "snippet" },
        [
          "npx github:atokim4/supabase-cli-v3-upgrade .",
          "npx github:atokim4/node26-lts-upgrade .",
          "npx github:atokim4/vibe-preflight --only breaking .",
          "npx github:atokim4/prisma-accelerate-exit .",
          "npx github:atokim4/deno-exit .",
        ].join("\n"),
      ),
    );
  }
  target.replaceChildren(h("div", { class: "problem", role: "alert" }, icon(ICONS.alert, "icon icon-lg"), h("div", {}, ...children)));
}
