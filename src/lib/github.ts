import type { RepoRef } from "./repo-input.ts";
import type { TreeEntry } from "./select.ts";

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: Date;
}

export type GitHubErrorKind = "not-found" | "empty" | "rate-limited" | "network" | "http";

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly rate?: RateLimit,
  ) {
    super(message);
  }
}

export interface Tree {
  /** The commit the tree belongs to (40 hex). */
  sha: string;
  entries: TreeEntry[];
  /** GitHub cut the listing short (over 100,000 entries or 7 MB). */
  truncated: boolean;
}

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

function rateFrom(headers: Headers): RateLimit | undefined {
  const limit = Number(headers.get("x-ratelimit-limit"));
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!headers.has("x-ratelimit-remaining") || !Number.isFinite(remaining)) return undefined;
  return { limit, remaining, resetAt: new Date(reset * 1000) };
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/**
 * Unauthenticated GitHub access from the browser: two REST calls per scan (the commit, then its tree), and file
 * contents from raw.githubusercontent.com, which doesn't count against the API limit.
 */
export class GitHub {
  /** The API limit as of the last response. */
  rate: RateLimit | undefined;

  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly onRate: (rate: RateLimit) => void = () => {},
  ) {}

  private async api(path: string, accept: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${path}`, { headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" } });
    } catch {
      throw new GitHubError("network", "Couldn't reach api.github.com. Check your connection (or an ad blocker) and try again.");
    }
    const rate = rateFrom(res.headers);
    if (rate) {
      this.rate = rate;
      this.onRate(rate);
    }
    if ((res.status === 403 || res.status === 429) && (rate?.remaining === 0 || res.headers.has("retry-after"))) {
      throw new GitHubError("rate-limited", "GitHub's limit for anonymous requests from your network is used up.", rate);
    }
    return res;
  }

  /** The commit SHA of `ref` (or of the default branch). */
  async resolve(r: RepoRef): Promise<string> {
    const res = await this.api(`/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(r.ref ?? "HEAD")}`, "application/vnd.github.sha");
    if (res.status === 404 || res.status === 422) {
      throw new GitHubError(
        "not-found",
        r.ref
          ? `GitHub has no ${r.owner}/${r.repo} with a branch, tag or commit "${r.ref}", or the repository is private.`
          : `GitHub has no public repository ${r.owner}/${r.repo}. It may be private or the name may be misspelled.`,
      );
    }
    if (res.status === 409) throw new GitHubError("empty", `${r.owner}/${r.repo} has no commits yet.`);
    if (!res.ok) throw new GitHubError("http", `GitHub answered ${res.status} for ${r.owner}/${r.repo}. Try again in a minute.`);
    const sha = (await res.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubError("http", "GitHub sent an unexpected answer for the commit. Try again in a minute.");
    return sha;
  }

  async tree(r: RepoRef, sha: string): Promise<Tree> {
    const res = await this.api(`/repos/${r.owner}/${r.repo}/git/trees/${sha}?recursive=1`, "application/vnd.github+json");
    if (!res.ok) throw new GitHubError("http", `GitHub answered ${res.status} for the file list. Try again in a minute.`);
    const body = (await res.json()) as { tree?: { path: string; type: string; size?: number }[]; truncated?: boolean };
    const entries = (body.tree ?? []).filter((e) => e.type === "blob").map((e) => ({ path: e.path, size: e.size ?? 0 }));
    return { sha, entries, truncated: body.truncated === true };
  }

  /** A file's text at a commit. */
  async raw(r: RepoRef, sha: string, path: string, signal?: AbortSignal): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${RAW}/${r.owner}/${r.repo}/${sha}/${encodePath(path)}`, { signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new GitHubError("network", `Couldn't download ${path} from raw.githubusercontent.com.`);
    }
    if (!res.ok) throw new GitHubError("http", `raw.githubusercontent.com answered ${res.status} for ${path}.`);
    return res.text();
  }
}
