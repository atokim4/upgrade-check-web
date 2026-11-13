import { expect, test, type Page } from "@playwright/test";

// Live tests against public GitHub repos (2 API requests each). Commits are pinned so the results don't drift.

async function check(page: Page, repo: string) {
  const errors: string[] = [];
  // Netlify's free tier injects a HUD iframe (about:srcdoc) whose inline code our CSP blocks: not the page's errors.
  page.on("console", (m) => m.type() === "error" && m.location().url !== "about:srcdoc" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("Public GitHub repository").fill(repo);
  await page.getByRole("button", { name: "Check repo" }).click();
  await expect(page.locator(".verdict h2")).toBeVisible({ timeout: 60_000 });
  return errors;
}

const section = (page: Page, name: string) => page.getByRole("region", { name: new RegExp(`^${name}`) });

test("Node 26: corepack enable on a node image (kpi-ua/schedule.kpi.ua before its fix PR #631)", async ({ page }) => {
  const errors = await check(page, "kpi-ua/schedule.kpi.ua@6d5e7ba14d");
  const node = section(page, "Node.js 26 LTS");
  const hit = node.locator(".finding", { hasText: "corepack-not-bundled" }).first();
  await expect(hit).toContainText("Dockerfile:5");
  await expect(hit.locator("a.loc")).toHaveAttribute("href", /github\.com\/kpi-ua\/schedule\.kpi\.ua\/blob\/6d5e7ba14d[0-9a-f]{30}\/Dockerfile#L5$/);
  await hit.getByText("Why, and the fix").click();
  await expect(hit.locator(".diff")).toContainText("corepack@0.36.0");
  await expect(page).toHaveURL(/\?repo=kpi-ua%2Fschedule\.kpi\.ua%406d5e7ba14d$/);
  expect(errors).toEqual([]);
});

test("Supabase CLI v3: [inbucket] in config.toml (vercel/nextjs-subscription-payments)", async ({ page }) => {
  const errors = await check(page, "https://github.com/vercel/nextjs-subscription-payments/tree/bdd0813206e47e6b218d42f15a7976c8a0d3c3eb");
  const sb = section(page, "Supabase CLI v3");
  const hit = sb.locator(".finding", { hasText: "inbucket-section" });
  await expect(hit).toContainText("supabase/config.toml:");
  await expect(sb.getByRole("button", { name: "Copy all fixes as one patch" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("expressjs/express: only its eslintrc config trips a checker (ESLint 10), nothing else", async ({ page }) => {
  const errors = await check(page, "expressjs/express@43fca52d28a422c8be48fd489cbd4f2d6152bab6");
  await expect(page.locator(".checker.has-findings")).toHaveCount(1);
  await expect(section(page, "ESLint 10").locator(".finding", { hasText: "eslintrc-only" })).toContainText(".eslintrc.yml:1");
  await expect(section(page, "OpenAI and Claude model retirements").locator(".finding")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a missing repository explains itself", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Public GitHub repository").fill("atokim4/this-repo-does-not-exist-2026");
  await page.getByRole("button", { name: "Check repo" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Can't read this repository" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("npx github:atokim4/node26-lts-upgrade .");
});

test("bad input is caught before any request", async ({ page }) => {
  let requests = 0;
  page.on("request", (r) => r.url().includes("api.github.com") && requests++);
  await page.goto("/");
  await page.getByRole("button", { name: "Check repo" }).click();
  await expect(page.locator("#repo-error")).toContainText("Paste a GitHub repository");
  await expect(page.getByLabel("Public GitHub repository")).toHaveAttribute("aria-invalid", "true");
  expect(requests).toBe(0);
});

test("a local folder is checked without any network request (sample app)", async ({ page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const remote: string[] = [];
  page.on("request", (r) => !r.url().startsWith(origin) && remote.push(r.url()));
  await page.locator("#folder-input").setInputFiles("e2e/fixtures/sample-app");
  await expect(page.locator(".verdict h2")).toHaveText("4 lines to change, 2 of them break for sure");
  await expect(page.locator(".verdict-repo")).toHaveText("sample-app (local folder)");
  await expect(section(page, "Supabase CLI v3").locator(".finding", { hasText: "inbucket-section" })).toContainText("supabase/config.toml:3");
  await expect(section(page, "Node.js 26 LTS").locator(".finding", { hasText: "corepack-not-bundled" })).toContainText("Dockerfile:4");
  await expect(section(page, "Supabase platform changes").locator(".finding", { hasText: "server-adapter-removed" }).first()).toContainText("src/api.ts:2");
  await expect(section(page, "Supabase platform changes").locator(".finding", { hasText: "server-adapter-removed" })).toHaveCount(2);
  await expect(page.locator(".coverage")).toContainText("in the folder");
  expect(remote).toEqual([]);
});
