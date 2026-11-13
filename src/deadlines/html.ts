/**
 * HTML for the deadline pages, rendered at build time (scripts/deadline-pages.ts) so every page is real HTML
 * that works without JavaScript. The browser script only fills in the countdowns from the visitor's clock.
 */
import versions from "../engines/versions.json" with { type: "json" };
import type { CheckerId } from "../lib/types.ts";
import { CHECKER_NAMES, DEADLINES, PAGES, READ_ON, SITE, deadlinesFor, type Deadline, type DeadlinePage, type Source } from "./data.ts";
import { formatDay } from "./time.ts";

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
/** Escapes plain text for HTML text and attribute values. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

const scanUrl = (checkers: readonly CheckerId[], repo?: string) =>
  `/?only=${checkers.join(",")}${repo ? `&repo=${encodeURIComponent(repo).replace(/%2F/g, "/").replace(/%40/g, "@")}` : ""}`;

/** Earliest first; deadlines without a date go last. */
export const byDate = (list: readonly Deadline[]): Deadline[] => [...list].sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));

function timeTag(d: Deadline, cls: string): string {
  if (!d.date) return `<span class="${cls} is-tbd">No date yet</span>`;
  const label = (d.approx ? "About " : "") + formatDay(d.date, d.approx);
  return `<time class="${cls}" datetime="${d.approx ? d.date.slice(0, 7) : d.date}">${label}</time>`;
}

/** Filled by the browser script; empty until then, so a page without JS just shows the date. */
const countdownSlot = (d: Deadline) => `<span class="countdown" data-countdown data-date="${d.date ?? ""}"${d.approx ? " data-approx" : ""}></span>`;

const checkerLinks = (ids: readonly CheckerId[]) => ids.map((id) => `<a href="${scanUrl([id])}">${esc(CHECKER_NAMES[id])}</a>`).join(", ");

/** One row of the /deadlines timetable. */
function timetableRow(d: Deadline): string {
  const name = d.page ? `<a href="/${d.page}">${esc(d.name)}</a>` : esc(d.name);
  return `<li class="tt-row" data-row data-date="${d.date ?? ""}">
  ${timeTag(d, "tt-date")}
  ${countdownSlot(d)}
  <div class="tt-body">
    <h2 class="tt-name">${name}</h2>
    <p class="tt-what">${esc(d.what)}</p>
    <p class="tt-meta"><a href="${esc(d.source.url)}" rel="noopener">${esc(d.source.label)}</a><span class="tt-sep" aria-hidden="true"> / </span>Checked by ${checkerLinks(d.checkers)}</p>
  </div>
</li>`;
}

/** The /deadlines list, earliest first. */
export function renderTimetable(list: readonly Deadline[] = DEADLINES): string {
  return `<ol class="timetable" aria-label="Shutdowns and breaking releases by date">\n${byDate(list).map(timetableRow).join("\n")}\n</ol>`;
}

/** The short list under the scanner's headline. */
export function renderHeroList(list: readonly Deadline[] = DEADLINES): string {
  return byDate(list)
    .map((d) => {
      const when = d.date
        ? `<time datetime="${d.approx ? d.date.slice(0, 7) : d.date}">${d.approx ? formatDay(d.date, true) : formatDay(d.date).replace(/ \d{4}$/, "")}</time>`
        : `<span class="tbd">Not dated</span>`;
      const name = d.page ? `<a href="/${d.page}">${esc(d.name)}</a>` : esc(d.name);
      return `<li>${when} <span>${name}</span></li>`;
    })
    .join("\n");
}

const uniqueSources = (page: DeadlinePage): Source[] => {
  const all = [...deadlinesFor(page.slug).map((d) => d.source), ...(page.moreSources ?? [])];
  return all.filter((s, i) => all.findIndex((t) => t.url === s.url) === i);
};

const paragraphs = (list: readonly string[]) => list.map((p) => `<p>${p}</p>`).join("\n");

/** The checker ids a page's scanner runs. */
export const pageCheckers = (page: DeadlinePage): CheckerId[] => [...new Set(deadlinesFor(page.slug).flatMap((d) => d.checkers))];

/** Command-line versions that also rewrite code (`--fix`); the others report only. */
const HAS_FIX: ReadonlySet<CheckerId> = new Set(["supabase-cli-v3", "node26", "prisma", "llm", "deno"]);

function cliLine(ids: readonly CheckerId[]): string {
  const repos = ids.flatMap((id) => {
    const v = (versions as Record<string, { repo: string } | undefined>)[id];
    return v ? [`<a href="https://github.com/${v.repo}">${esc(v.repo)}</a>`] : [];
  });
  const fix = ids.some((id) => HAS_FIX.has(id)) ? ", with a <code>--fix</code> for the safe rewrites," : "";
  return repos.length
    ? `The same rules run offline${fix} in ${repos.join(" and ")} (MIT).`
    : "These rules live only on this site; there is no command-line version.";
}

/** The <main> of a deadline page. */
export function renderPageMain(page: DeadlinePage): string {
  const deadlines = byDate(deadlinesFor(page.slug));
  if (!deadlines.length) throw new Error(`No deadline points at page ${page.slug}`);
  const ids = pageCheckers(page);
  const sources = uniqueSources(page)
    .map((s) => `<li><a href="${esc(s.url)}" rel="noopener">${esc(s.label)}</a></li>`)
    .join("");
  const tag = deadlines
    .map(
      (d) =>
        `<li class="tag-line" data-row data-date="${d.date ?? ""}">${timeTag(d, "tag-date")}<span class="tag-what">${esc(d.name)}</span>${countdownSlot(d)}</li>`,
    )
    .join("");
  const others = PAGES.filter((p) => p.slug !== page.slug)
    .map((p) => `<li><a href="/${p.slug}">${esc(p.h1)}</a></li>`)
    .join("\n");

  return `<nav class="crumbs wrap" aria-label="Breadcrumb"><ol><li><a href="/">Upgrade check</a></li><li><a href="/deadlines">Deadlines</a></li><li><span aria-current="page">${esc(page.crumb)}</span></li></ol></nav>
<main id="main" class="wrap article">
  <header class="article-head">
    <div class="tag-wrap"><ul class="tag" aria-label="Dates">${tag}</ul></div>
    <h1>${esc(page.h1)}</h1>
  </header>
  <div class="prose">
    ${paragraphs(page.intro)}
    <h2>What breaks</h2>
    ${paragraphs(page.breaks)}
    <h2>How to fix it</h2>
    ${paragraphs(page.fix)}
  </div>
  <section class="scan" aria-labelledby="scan-title">
    <h2 id="scan-title">Check a repository for this</h2>
    <p>${esc(page.scans)}</p>
    <form class="intake" action="/" method="get">
      <input type="hidden" name="only" value="${ids.join(",")}" />
      <label for="repo-input" class="intake-label">Public GitHub repository</label>
      <div class="intake-row">
        <input id="repo-input" name="repo" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="owner/repo or https://github.com/owner/repo" aria-describedby="scan-hint" />
        <button type="submit" class="btn btn-primary">Check repo</button>
      </div>
      <p id="scan-hint" class="hint">Runs in your browser with 2 anonymous GitHub API requests. Example: <a href="${esc(scanUrl(ids, page.example))}">${esc(page.example)}</a>.</p>
    </form>
    <p class="cli-note">${cliLine(ids)}</p>
  </section>
  <section class="sources" aria-labelledby="sources-title">
    <h2 id="sources-title">Sources</h2>
    <ul>${sources}</ul>
    <p>Dates and wording re-read on the official pages on <time datetime="${READ_ON}">${formatDay(READ_ON)}</time>. Vendors move dates; the official page wins.</p>
  </section>
  <nav class="more" aria-labelledby="more-title">
    <h2 id="more-title">Other deadlines</h2>
    <ul>${others}</ul>
    <p><a href="/deadlines">Every deadline by date, with days left</a></p>
  </nav>
</main>`;
}

export function renderSitemap(lastmod: string = READ_ON): string {
  const urls = ["/", "/deadlines", ...PAGES.map((p) => `/${p.slug}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n")}
</urlset>
`;
}

export const ROBOTS = `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`;

/** The shared page footer. */
export const FOOTER = `<footer class="colophon">
  <div class="wrap">
    <p>
      A personal project by Sunnatulla E. The checks come from the open-source scanners
      <a href="https://github.com/atokim4/supabase-cli-v3-upgrade">supabase-cli-v3-upgrade</a>,
      <a href="https://github.com/atokim4/node26-lts-upgrade">node26-lts-upgrade</a>,
      <a href="https://github.com/atokim4/vibe-preflight">vibe-preflight</a>,
      <a href="https://github.com/atokim4/prisma-accelerate-exit">prisma-accelerate-exit</a>,
      <a href="https://github.com/atokim4/llm-retire-scan">llm-retire-scan</a>,
      <a href="https://github.com/atokim4/deno-exit">deno-exit</a>,
      <a href="https://github.com/atokim4/pg18-upgrade-check">pg18-upgrade-check</a> and
      <a href="https://github.com/atokim4/n8n-v3-check">n8n-v3-check</a>, bundled for the browser; the Gemini and
      Custom Search rules live only on this site.
      <a href="https://github.com/atokim4/upgrade-check-web">Source of this page</a> (MIT).
    </p>
    <p><a href="/deadlines">All deadlines</a> · <a href="/sitemap.xml">Sitemap</a></p>
    <p>Not affiliated with any of the companies or projects named here.</p>
  </div>
</footer>`;
