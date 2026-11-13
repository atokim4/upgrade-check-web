import { expect, test, type Page } from "@playwright/test";
import { PAGES } from "../src/deadlines/data.ts";

// The deadline pages. The first tests make no GitHub requests; the engine tests start from each page's example
// link (2 anonymous API requests each), on repos pinned to the commit checked on 2026-11-13.

const SITE = "https://upgrade-check-2026.netlify.app";
const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && m.location().url !== "about:srcdoc" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
};

test("every deadline page is real HTML with its title, canonical, H1 and a scanner form for its checker", async ({ page }) => {
  for (const p of PAGES) {
    const res = await page.goto(`/${p.slug}`);
    expect(res?.status(), p.slug).toBe(200);
    await expect(page).toHaveTitle(p.title);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${SITE}/${p.slug}`);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", p.description);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.h1);
    await expect(page.locator('form[action="/"] input[name="only"]')).toHaveCount(1);
    await expect(page.locator(".tag .cd-fig").first()).not.toBeEmpty();
  }
});

test("/deadlines counts days from the visitor's clock and marks today", async ({ page }) => {
  const errors = errorsOf(page);
  await page.clock.setFixedTime(new Date(2026, 10, 13, 9, 0));
  await page.goto("/deadlines");
  const row = (name: string) => page.locator(".tt-row", { hasText: name });
  await expect(row("GPT-4o and GPT-4.1 shut down").locator(".countdown")).toContainText("62 days left");
  await expect(row("Node.js 26 becomes LTS")).toHaveAttribute("data-state", "passed");
  await expect(row("Deno Deploy shuts down").locator(".cd-fig")).toHaveText("~147");
  await expect(row("n8n 3.0")).toHaveAttribute("data-state", "undated");
  // The today rule sits right before the first date still ahead.
  await expect(page.locator(".tt-now + .tt-row .tt-name")).toHaveText("Claude Sonnet 4.5 retires");
  await expect(page.locator("[data-today]")).toHaveText("By your clock it is 13 Nov 2026: 5 of these dates have passed, 11 are still ahead.");
  expect(errors).toEqual([]);
});

test("a later clock moves the today rule", async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 11, 2, 9, 0));
  await page.goto("/deadlines");
  await expect(page.locator(".tt-row", { hasText: "Prisma Accelerate shuts down" }).locator(".countdown")).toContainText("1 day ago");
  await expect(page.locator(".tt-now + .tt-row .tt-name")).toHaveText("Val Town goes read-only");
});

test("the page form sends the repo to the scanner limited to that checker", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) => route.abort());
  await page.goto("/prisma-accelerate-shutdown");
  await page.getByLabel("Public GitHub repository").fill("someone/app");
  await page.getByRole("button", { name: "Check repo" }).click();
  await expect(page).toHaveURL(/\/\?only=prisma&repo=someone%2Fapp$/);
  await expect(page.locator("#only-note")).toHaveText("Only checking: Prisma Accelerate shutdown. You can also run every check.");
  await expect(page.locator("#repo-input")).toHaveValue("someone/app");
});

test("sitemap and robots", async ({ request }) => {
  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const p of PAGES) expect(sitemap).toContain(`<loc>${SITE}/${p.slug}</loc>`);
  expect(await (await request.get("/robots.txt")).text()).toContain(`Sitemap: ${SITE}/sitemap.xml`);
});

/** Opens a deadline page, follows its example link and waits for the report. */
async function scanExample(page: Page, slug: string) {
  const errors = errorsOf(page);
  await page.goto(`/${slug}`);
  await page.locator("#scan-hint a").click();
  await expect(page.locator(".verdict h2")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("section.checker")).toHaveCount(1);
  return errors;
}
const section = (page: Page, name: string) => page.getByRole("region", { name: new RegExp(`^${name}`) });

test.describe("engines on real repos @network", () => {
  test("OpenAI: GPT-4o in father-bot/chatgpt_telegram_bot", async ({ page }) => {
    const errors = await scanExample(page, "gpt-4o-shutdown");
    await expect(section(page, "OpenAI and Claude model retirements").locator(".finding", { hasText: "gpt-4o" }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("OpenAI: o3 with tools in pixeltable/pixelagent", async ({ page }) => {
    const errors = await scanExample(page, "gpt-5-o3-shutdown");
    const llm = section(page, "OpenAI and Claude model retirements");
    await expect(llm.locator(".finding", { hasText: "o3-2025-04-16" }).first()).toContainText("slack-agent/agent.py:8");
    await expect(llm).toContainText("goes through code this tool doesn't know");
    expect(errors).toEqual([]);
  });

  test("Google Custom Search endpoint in assafelovic/gpt-researcher", async ({ page }) => {
    const errors = await scanExample(page, "google-custom-search-api-shutdown");
    await expect(section(page, "Google Custom Search JSON API").locator(".finding", { hasText: "endpoint" }).first()).toContainText(
      "retrievers/google/google.py:79",
    );
    expect(errors).toEqual([]);
  });

  test("Deno KV in 0f-0b/kv-relay", async ({ page }) => {
    const errors = await scanExample(page, "deno-deploy-val-town-exit");
    await expect(section(page, "Deno Deploy and Val Town").locator(".finding", { hasText: "Deno KV" }).first()).toContainText("main.ts:92");
    expect(errors).toEqual([]);
  });

  test("Postgres 18 data mount in 3Corners-Labs/OpenPlanner", async ({ page }) => {
    const errors = await scanExample(page, "postgres-18-docker-upgrade");
    await expect(section(page, "Postgres 18 in Docker")).toContainText("docker-compose.yml:245");
    expect(errors).toEqual([]);
  });

  test("undeclared @eslint/js and globals in aggre/ullr's ESLint 10 bump", async ({ page }) => {
    const errors = await scanExample(page, "eslint-10-upgrade");
    const eslint = section(page, "ESLint 10");
    await expect(eslint).toContainText("eslint.config.mjs:1");
    await expect(eslint).toContainText("globals");
    expect(errors).toEqual([]);
  });

  test("n8n 3.0 removed node versions in enescingoz/awesome-n8n-templates", async ({ page }) => {
    const errors = await scanExample(page, "n8n-3-migration");
    const n8n = section(page, "n8n 3.0 workflows");
    await expect(n8n.locator(".finding").first()).toBeVisible();
    await expect(n8n).toContainText(/Edit Image|AI Agent/);
    expect(errors).toEqual([]);
  });
});
