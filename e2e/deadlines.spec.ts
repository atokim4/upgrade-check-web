import { expect, test } from "@playwright/test";

// The detect-only engines on real public repos (2 API requests each), pinned to the commit checked on 2026-11-13.

const section = (page: import("@playwright/test").Page, name: string) => page.getByRole("region", { name: new RegExp(`^${name}`) });

test("Prisma Accelerate and GPT-4o in one repo (Codehagen/Badget)", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && m.location().url !== "about:srcdoc" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?repo=Codehagen/Badget@16a677f95361");
  await expect(page.locator(".verdict h2")).toBeVisible({ timeout: 60_000 });

  const prisma = section(page, "Prisma Accelerate shutdown");
  await expect(prisma.locator(".finding", { hasText: "dependency" })).toContainText("package.json:32");
  await expect(prisma.locator(".finding", { hasText: "generate-flag" })).toHaveCount(2);
  await expect(prisma).toContainText("npx github:atokim4/prisma-accelerate-exit . --fix");

  const llm = section(page, "OpenAI and Claude model retirements");
  await expect(llm.locator(".finding", { hasText: "gpt-4o shuts down on 2027-01-14" }).first()).toContainText("src/actions/ai-budget-actions.ts:173");
  await expect(page.locator(".clean-list")).toContainText("Supabase CLI v3");
  await expect(page.locator(".not-used")).toContainText("Deno Deploy and Val Town");
  expect(errors).toEqual([]);
});

test("?only= runs one checker: Gemini 2.5 (google-gemini/gemini-fullstack-langgraph-quickstart)", async ({ page }) => {
  await page.goto("/?only=gemini-25&repo=google-gemini/gemini-fullstack-langgraph-quickstart@e34e569de465");
  await expect(page.locator(".verdict h2")).toBeVisible({ timeout: 60_000 });
  const gemini = section(page, "Gemini 2.5 on the Gemini API");
  await expect(gemini.locator(".finding", { hasText: "gemini-2.5-flash from 2026-12-01 will be answered by gemini-3.5-flash-lite" })).toContainText(
    "backend/src/agent/configuration.py:19",
  );
  await expect(page.locator("section.checker")).toHaveCount(1);
  await expect(page.locator(".clean-list")).toHaveCount(0);
});
