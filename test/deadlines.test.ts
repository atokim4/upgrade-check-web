import { describe, expect, it } from "vitest";
import { fillPage, fillShared } from "../build/deadline-pages.ts";
import { CHECKERS } from "../src/lib/checks.ts";
import { CHECKER_NAMES, DEADLINES, PAGES, SITE } from "../src/deadlines/data.ts";
import { byDate, esc, pageCheckers, renderSitemap, renderTimetable } from "../src/deadlines/html.ts";
import { countdown, daysBetween, formatDay, localDay } from "../src/deadlines/time.ts";

const TEMPLATE = `<title>__DL_TITLE__</title><meta name="description" content="__DL_DESCRIPTION__" /><link rel="canonical" href="__DL_CANONICAL__" /><!--dl:main--><!--dl:footer-->`;
const words = (html: string) => html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;

describe("date maths", () => {
  it("counts calendar days across months, years and DST changes", () => {
    expect(daysBetween("2026-11-13", "2026-11-30")).toBe(17);
    expect(daysBetween("2026-11-13", "2027-01-14")).toBe(62);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-11-13", "2026-11-12")).toBe(-1);
  });

  it("takes the visitor's local date", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("says upcoming, today, passed and undated", () => {
    expect(countdown("2026-11-30", "2026-11-13")).toMatchObject({ state: "upcoming", figure: "17", caption: "days left" });
    expect(countdown("2026-11-14", "2026-11-13")).toMatchObject({ caption: "day left", sentence: "1 day left." });
    expect(countdown("2026-11-13", "2026-11-13").state).toBe("today");
    expect(countdown("2026-11-12", "2026-11-13")).toMatchObject({ state: "passed", figure: "1", caption: "day ago" });
    expect(countdown(null, "2026-11-13").state).toBe("undated");
    expect(countdown("2027-04-09", "2026-11-13", true)).toMatchObject({ figure: "~147", sentence: "About 147 days left." });
  });

  it("formats dates without the browser locale", () => {
    expect(formatDay("2027-01-14")).toBe("14 Jan 2027");
    expect(formatDay("2027-04-09", true)).toBe("Apr 2027");
    expect(formatDay(null)).toBe("No date yet");
    expect(() => formatDay("2027-4-9")).toThrow();
  });
});

describe("deadline data", () => {
  it("uses the scanner's own checker names", () => {
    for (const c of CHECKERS) expect(CHECKER_NAMES[c.id]).toBe(c.name);
  });

  it("links every deadline to an existing page and every page to at least one deadline", () => {
    const slugs = new Set(PAGES.map((p) => p.slug));
    for (const d of DEADLINES) if (d.page) expect(slugs, d.id).toContain(d.page);
    for (const p of PAGES) expect(DEADLINES.some((d) => d.page === p.slug), p.slug).toBe(true);
    expect(PAGES.map((p) => p.slug).sort()).toEqual(
      [
        "gpt-4o-shutdown",
        "prisma-accelerate-shutdown",
        "claude-sonnet-4-5-retirement",
        "google-custom-search-api-shutdown",
        "deno-deploy-val-town-exit",
        "gemini-2-5-shutdown",
        "postgres-18-docker-upgrade",
        "n8n-3-migration",
      ].sort(),
    );
  });

  it("has valid dates and https sources", () => {
    for (const d of DEADLINES) {
      if (d.date) expect(d.date, d.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.source.url, d.id).toMatch(/^https:\/\//);
    }
  });

  it("keeps titles and descriptions to search-result length, and each page 150-300 words", () => {
    for (const p of PAGES) {
      expect(p.title.length, p.slug).toBeLessThanOrEqual(65);
      expect(p.description.length, p.slug).toBeLessThanOrEqual(160);
      expect(p.description.length, p.slug).toBeGreaterThanOrEqual(110);
      const n = words([...p.intro, ...p.breaks, ...p.fix].join(" "));
      expect(n, p.slug).toBeGreaterThanOrEqual(150);
      expect(n, p.slug).toBeLessThanOrEqual(300);
    }
  });

  it("has no em or en dashes in the copy", () => {
    const copy = JSON.stringify([PAGES, DEADLINES.map((d) => [d.name, d.what])]);
    expect(copy).not.toMatch(/[–—]/);
  });
});

describe("rendered pages", () => {
  it("sorts by date with undated deadlines last", () => {
    const sorted = byDate(DEADLINES);
    expect(sorted.at(-1)!.date).toBeNull();
    const dated = sorted.filter((d) => d.date).map((d) => d.date!);
    expect(dated).toEqual([...dated].sort());
  });

  it("renders one page per slug with its own title, description, canonical, one H1 and a prefilled scanner", () => {
    for (const p of PAGES) {
      const html = fillPage(TEMPLATE, p.slug);
      expect(html).toContain(`<title>${esc(p.title)}</title>`);
      expect(html).toContain(`content="${esc(p.description)}"`);
      expect(html).toContain(`<link rel="canonical" href="${SITE}/${p.slug}" />`);
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).toContain(`<input type="hidden" name="only" value="${pageCheckers(p).join(",")}" />`);
      expect(html).toContain(`/?only=${pageCheckers(p).join(",")}&amp;repo=${p.example}`);
      expect(html).not.toMatch(/__DL_|<!--dl:/);
    }
  });

  it("fails loudly for an unknown page", () => {
    expect(() => fillPage(TEMPLATE, "nope")).toThrow(/Unknown/);
  });

  it("lists every deadline on the timetable with its source and checker link", () => {
    const html = renderTimetable();
    expect(html.match(/<li class="tt-row"/g)).toHaveLength(DEADLINES.length);
    for (const d of DEADLINES) {
      expect(html).toContain(esc(d.source.url));
      for (const id of d.checkers) expect(html).toContain(`href="/?only=${id}"`);
    }
    expect(fillShared("<!--dl:timetable--><!--dl:hero-->")).not.toContain("<!--dl:");
  });

  it("puts the scanner, /deadlines and every page in the sitemap", () => {
    const xml = renderSitemap();
    expect(xml.match(/<loc>/g)).toHaveLength(PAGES.length + 2);
    for (const p of PAGES) expect(xml).toContain(`<loc>${SITE}/${p.slug}</loc>`);
  });
});
