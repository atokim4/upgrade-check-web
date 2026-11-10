/** A public GitHub repository and, optionally, the branch, tag or commit to read. */
export interface RepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit SHA. Undefined means the default branch. */
  ref?: string;
}

export class InputError extends Error {}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Reads what people paste: `owner/repo`, `owner/repo@ref`, `https://github.com/owner/repo`, a `.git` clone URL,
 * or a link to a branch, tag, commit or file (`/tree/<ref>`, `/blob/<ref>/…`, `/commit/<sha>`).
 * A ref with a slash in it only works in the `@ref` form, because a tree URL doesn't say where the ref ends.
 */
export function parseRepoInput(raw: string): RepoRef {
  let text = raw.trim();
  if (!text) throw new InputError("Paste a GitHub repository, for example vercel/next.js or https://github.com/owner/repo.");

  let ref: string | undefined;
  const at = /^([^@\s]+)@([^\s]+)$/.exec(text);
  if (at && !/^git@/.test(text) && !/^[a-z]+:\/\//i.test(at[2]!)) {
    text = at[1]!;
    ref = at[2];
  }

  text = text.replace(/^git@github\.com:/i, "https://github.com/");
  text = text.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  if (/^[a-z]+:\/\//i.test(text) || /^[\w.-]+\.[a-z]{2,}\//i.test(text)) {
    throw new InputError("Only github.com repositories can be read from here. For other hosts, run the CLI on a local checkout.");
  }

  const parts = text.split(/[?#]/)[0]!.split("/").filter(Boolean);
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/i, "");
  if (!owner || !repo) throw new InputError("That doesn't look like a repository. Use owner/repo, for example vercel/next.js.");
  if (!OWNER.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") {
    throw new InputError(`"${owner}/${repo}" isn't a valid GitHub repository name.`);
  }

  const kind = parts[2];
  if (!ref && (kind === "tree" || kind === "blob" || kind === "commit") && parts[3]) ref = decodeURIComponent(parts[3]);
  if (ref !== undefined && !/^[\w./-]{1,250}$/.test(ref)) throw new InputError(`"${ref}" isn't a valid branch, tag or commit.`);
  return { owner, repo, ref };
}

export const repoLabel = (r: RepoRef) => `${r.owner}/${r.repo}${r.ref ? `@${r.ref}` : ""}`;
