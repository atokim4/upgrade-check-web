// The few node:path helpers the synced engines use, for the browser. Vite aliases `node:path` to this file.
// Paths here are always repo-relative with forward slashes.

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

export function normalize(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else out.push(part);
  }
  const joined = (absolute ? "/" : "") + out.join("/");
  if (!joined) return absolute ? "/" : ".";
  return path.endsWith("/") && out.length ? `${joined}/` : joined;
}

export const posix = { basename, extname, normalize };
