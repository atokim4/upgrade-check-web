import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";
import { runChecks } from "./lib/checks.ts";
import { GitHub, GitHubError, type RateLimit } from "./lib/github.ts";
import { loadFromFiles, loadFromGitHub, type LoadedRepo, type LocalFile } from "./lib/loader.ts";
import { InputError, parseRepoInput, repoLabel, type RepoRef } from "./lib/repo-input.ts";
import { collectDropped, pickedFiles } from "./ui/drop.ts";
import { renderError, renderReport, type ErrorView } from "./ui/render.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("check-form");
const input = $<HTMLInputElement>("repo-input");
const button = $<HTMLButtonElement>("check-button");
const fieldError = $<HTMLParagraphElement>("repo-error");
const folderInput = $<HTMLInputElement>("folder-input");
const rateEl = $<HTMLParagraphElement>("rate");
const status = $<HTMLElement>("status");
const statusText = $<HTMLParagraphElement>("status-text");
const progress = $<HTMLProgressElement>("status-progress");
const results = $<HTMLElement>("results");

const time = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function showRate(rate: RateLimit): void {
  rateEl.textContent =
    rate.remaining > 0
      ? `GitHub lets this browser make ${rate.remaining} more anonymous API requests until ${time(rate.resetAt)}. Each check uses 2.`
      : `GitHub's anonymous limit for your network is used up until ${time(rate.resetAt)}.`;
  rateEl.classList.toggle("is-low", rate.remaining < 6);
}

const gh = new GitHub(undefined, showRate);
let running = false;

function setBusy(busy: boolean, text = ""): void {
  running = busy;
  button.disabled = busy;
  folderInput.disabled = busy;
  form.setAttribute("aria-busy", String(busy));
  status.hidden = !busy;
  statusText.textContent = text;
  progress.removeAttribute("value");
}

function onProgress(done: number, total: number): void {
  statusText.textContent = total ? `Reading files: ${done} of ${total}` : "No files to read";
  progress.max = Math.max(total, 1);
  progress.value = done;
}

function show(repo: LoadedRepo): void {
  statusText.textContent = "Running the checks";
  const report = runChecks(repo);
  renderReport(results, repo, report);
  results.hidden = false;
  results.focus({ preventScroll: true });
  results.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function errorView(err: unknown, ref?: RepoRef): ErrorView {
  if (err instanceof GitHubError) {
    switch (err.kind) {
      case "not-found":
        return { title: "Can't read this repository", body: `${err.message} This page only reads public repositories and never asks for a token.`, offerLocal: true };
      case "rate-limited":
        return {
          title: "GitHub's anonymous limit is used up",
          body: `${err.message}${err.rate ? ` It resets at ${time(err.rate.resetAt)}.` : " It resets within the hour."} Each check needs 2 requests.`,
          offerLocal: true,
        };
      case "empty":
        return { title: "Nothing to check yet", body: err.message, offerLocal: false };
      default:
        return { title: ref ? `Couldn't finish reading ${repoLabel(ref)}` : "Couldn't finish reading the repository", body: err.message, offerLocal: false };
    }
  }
  return { title: "Something went wrong", body: `The check stopped with: ${(err as Error).message ?? String(err)}`, offerLocal: false };
}

async function checkRepo(raw: string): Promise<void> {
  if (running) return;
  let ref: RepoRef;
  try {
    ref = parseRepoInput(raw);
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    fieldError.textContent = err.message;
    fieldError.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return;
  }
  fieldError.hidden = true;
  input.removeAttribute("aria-invalid");
  const url = new URL(location.href);
  url.searchParams.set("repo", repoLabel(ref));
  history.replaceState(null, "", url);
  document.title = `${repoLabel(ref)} · Upgrade check`;

  setBusy(true, `Asking GitHub for ${repoLabel(ref)}`);
  try {
    show(await loadFromGitHub(ref, gh, onProgress));
  } catch (err) {
    renderError(results, errorView(err, ref));
    results.hidden = false;
    results.focus();
  } finally {
    setBusy(false);
  }
}

async function checkFolder(name: string, files: LocalFile[], truncated: boolean): Promise<void> {
  if (running || !files.length) return;
  const url = new URL(location.href);
  url.searchParams.delete("repo");
  history.replaceState(null, "", url);
  setBusy(true, `Reading ${name}`);
  try {
    show(await loadFromFiles(name, files, onProgress, truncated));
  } catch (err) {
    renderError(results, errorView(err));
    results.hidden = false;
  } finally {
    setBusy(false);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void checkRepo(input.value);
});

for (const chip of document.querySelectorAll<HTMLButtonElement>("[data-example]")) {
  chip.addEventListener("click", () => {
    input.value = chip.dataset.example!;
    void checkRepo(input.value);
  });
}

folderInput.addEventListener("change", () => {
  const picked = pickedFiles([...(folderInput.files ?? [])]);
  folderInput.value = "";
  if (picked) void checkFolder(picked.name, picked.files, picked.truncated);
});

let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  form.classList.add("is-dropping");
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    form.classList.remove("is-dropping");
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  form.classList.remove("is-dropping");
  if (!e.dataTransfer || running) return;
  const dropped = await collectDropped(e.dataTransfer);
  if (dropped) void checkFolder(dropped.name, dropped.files, dropped.truncated);
});

const initial = new URLSearchParams(location.search).get("repo");
if (initial) {
  input.value = initial;
  void checkRepo(initial);
}
