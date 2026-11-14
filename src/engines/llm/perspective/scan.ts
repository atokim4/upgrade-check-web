import { COMMENT, type Language, lex } from "../source.ts";
import type { Finding } from "../types.ts";

// String helpers instead of node:path: this module also runs in the browser (upgrade-check-web).
const basename = (file: string) => file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
const extname = (file: string) => {
  const name = basename(file);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
};

/** perspectiveapi.com: "The service will remain active until December 31, 2026". Requests fail after this day. */
export const PERSPECTIVE_SHUTDOWN = "2026-12-31";

const REPLACEMENT =
  "Make the base URL configurable and point it at a replacement that speaks the same wire format " +
  "(for example a self-hosted perspective-compat), or move to another moderation API.";

/** Longer lines are minified bundles: findings there point at build output, not source. */
const MAX_LINE_LENGTH = 2_000;
/** Prose: a URL in a README or a changelog describes the API, it doesn't call it. */
const PROSE_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc", ".txt", ".html", ".htm"]);
/** Files the lexer reads, so comments and docstrings can be told from code. */
const LEXED: Record<string, Language> = {
  ".py": "py", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".ts": "js", ".tsx": "js",
  ".mts": "js", ".cts": "js", ".vue": "js", ".svelte": "js",
};
const COMMENT_LINE = /^\s*(?:#|\/\/|\/\*|\*|<!--|--\s)/;

const HOST = /commentanalyzer\.googleapis\.com/i;
/** A URL split over two string pieces: `"https://commentanalyzer." + "googleapis.com/..."`. */
const SPLIT_URL = /https?:\/\/commentanalyzer\b/i;
/** The discovery document the generated Google clients load the service from. */
const DISCOVERY = /commentanalyzer\.googleapis\.com\/\$discovery/i;
/** The Google API client for the service, in the forms the generated clients use. */
const GOOGLE_CLIENT = [
  /\bbuild\(\s*["']commentanalyzer["']/, // googleapiclient.discovery.build("commentanalyzer", ...)
  /\.commentanalyzer\s*\(/, // google.commentanalyzer({ version: "v1alpha1" })
  /(?<![\w-])commentanalyzer_v1alpha1\b/, // googleapis Node types, Python service objects
  /api\/commentanalyzer\/v1alpha1/, // google.golang.org/api/commentanalyzer/v1alpha1
  /(?<![\w-])commentanalyzer\s*:\s*[A-Z]\w*/, // gapi.client typings: `commentanalyzer: GapiCommentAnalyzer`
];
/** `discovery.build(` with the service name on the next line. */
const BUILD_OPEN = /\bbuild\(\s*$/;
const LONE_SERVICE = /^\s*["']commentanalyzer["']\s*,?\s*$/;
/** An environment or settings lookup. */
const CONFIG_READ =
  /os\.getenv|os\.environ|getenv\(|process\.env|import\.meta\.env|Deno\.env|ENV\s*(?:\[|\.fetch)|\benv\(|SiteSetting|\bsettings?\s*[.[(]|\bconfig\s*[.[(]|\bconf\.get\(|\benviron\.get\(/i;
/** What a lookup's fallback looks like right before the URL's opening quote: `, "` `?? "` `|| "` `or "`. */
const FALLBACK_BEFORE_URL = /(?:,|\?\?|\|\||\bor)\s*[frbu]?["'`]$/i;
/** A line that is only a string literal (plus closing punctuation): an argument of a call above it. */
const LONE_STRING = /^\s*(?:f|r|b)?["'`][^"'`]*["'`]\s*[),;]*\s*$/;
/** The name being assigned is a default: `TOXICITY_ENDPOINT_DEFAULT =`, `const DefaultHost =`, YAML `default:`. */
const DEFAULT_ASSIGNMENT =
  /^\s*(?:(?:export|public|private|protected|static|final|const|let|var|readonly|val)\s+)*[\w.$]*default\w*\s*(?::[^=]*)?(?:=|:(?!:))/i;

/** `add_argument("--url", default="https://...")`, `{ defaultUrl: "https://..." }`. */
const DEFAULT_ARGUMENT = /(?:^|[^\w$])default\w*\s*[=:]\s*[frbu]?["'`]$/i;

const KEY_ENV = /(?:^|[^A-Za-z0-9])(?:\w+_)?PERSPECTIVE_(?:API_)?KEY\b/i;

/** Client libraries whose requests go to the Google endpoint, per manifest type. */
const NPM_CLIENT = /"(perspective-api-client|@conversationai\/perspectiveapi-js-client)"\s*:/;
const COMPOSER_CLIENT = /"(bredmor\/comment-analyzer|freema\/perspective-api-bundle)"\s*:/;
const GEM_CLIENT = /^\s*gem\s+["'](google_perspective)["']/;
/**
 * PyPI `perspective` (conway/perspective) and `perspectiveapi`. FINOS's `perspective-python` is a different
 * project, and so is conda's `perspective`, so environment.yml is not read.
 */
const PYPI_NAME = "(perspective|perspectiveapi)\\s*(?:\\[[^\\]]*\\])?";
const PYPI_LINE = new RegExp(`^\\s*${PYPI_NAME}\\s*(?:[=<>!~]=?|@|;|#|$)`); // requirements.txt, setup.cfg
const PYPI_QUOTED = new RegExp(`["']${PYPI_NAME}\\s*(?:[=<>!~;@][^"']*)?["']`); // PEP 621 / setup.py lists
const PYPI_TABLE = new RegExp(`^\\s*${PYPI_NAME}\\s*=\\s*["'{*]`); // Poetry, Pipfile
/** Keys whose quoted values name packages of the project itself, not dependencies. */
const OWN_PACKAGE_KEY = /^\s*(?:name|include|packages|py_modules|module|from)\s*[=:]/;
/** setup(name="x", packages=["perspective"], ...): drop the own-package arguments, keep install_requires. */
const OWN_PACKAGE_ARG = /\b(?:name|packages|py_modules)\s*=\s*(?:\[[^\]]*\]|"[^"]*"|'[^']*')/g;
/** Poetry and Pipfile tables whose keys are package names. */
const DEPENDENCY_TABLE = /^(?:tool\.poetry(?:\.group\.[\w-]+)?\.(?:dev-)?dependencies|packages|dev-packages)$/;
const REQUIREMENTS = /^requirements[\w.-]*\.(?:txt|in)$/i;
const PYTHON_MANIFEST = /^(?:requirements[\w.-]*\.(?:txt|in)|pyproject\.toml|setup\.py|setup\.cfg|Pipfile)$/i;

function shutdownWhen(today: string): { urgent: boolean; text: string } {
  const days = Math.round((Date.parse(PERSPECTIVE_SHUTDOWN) - Date.parse(today)) / 86_400_000);
  if (days < 0) return { urgent: true, text: `stopped after ${PERSPECTIVE_SHUTDOWN}` };
  const left = days === 0 ? "today is the last day" : days === 1 ? "1 day left" : `${days} days left`;
  return { urgent: days <= 30, text: `stops after ${PERSPECTIVE_SHUTDOWN} (${left})` };
}

function pythonClient(name: string, line: string, inDependencyTable: boolean): string | null {
  if (COMMENT_LINE.test(line)) return null;
  if (REQUIREMENTS.test(name) || name.toLowerCase() === "setup.cfg") {
    const hit = PYPI_LINE.exec(line);
    if (hit) return hit[1]!;
  }
  if (OWN_PACKAGE_KEY.test(line)) return null;
  const deps = line.replace(OWN_PACKAGE_ARG, "");
  return (PYPI_QUOTED.exec(deps) ?? (inDependencyTable ? PYPI_TABLE.exec(deps) : null))?.[1] ?? null;
}

function manifestClient(file: string, line: string, inDependencyTable: boolean): string | null {
  const name = basename(file);
  if (name === "package.json") return NPM_CLIENT.exec(line)?.[1] ?? null;
  if (name === "composer.json") return COMPOSER_CLIENT.exec(line)?.[1] ?? null;
  if (name === "Gemfile") return GEM_CLIENT.exec(line)?.[1] ?? null;
  if (PYTHON_MANIFEST.test(name)) return pythonClient(name, line, inDependencyTable);
  return null;
}

/** Cuts a trailing `#` or `//` comment that is outside quotes (for files the lexer doesn't read). */
function stripTrailingComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ((ch === "#" || (ch === "/" && line[i + 1] === "/")) && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Whether the string literal starting at `start` is a statement of its own, not a value or an argument. */
function standsAlone(text: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && " \t".includes(text[i]!)) i--;
  if (i >= 0 && text[i] !== "\n" && text[i] !== "\r") return false; // something before it on its line
  while (i >= 0 && " \t\r\n".includes(text[i]!)) i--;
  if (i < 0) return true;
  if (text[i] === ":") {
    // `def f():` / `class C:` then a docstring; `key: """..."""` is a value.
    const lineStart = text.lastIndexOf("\n", i) + 1;
    return /^\s*(?:async\s+def|def|class)\b/.test(text.slice(lineStart, i));
  }
  if ("=([{,+".includes(text[i]!)) return false;
  return !/\breturn$/.test(text.slice(Math.max(0, i - 6), i + 1));
}

/**
 * The lines with comments blanked out, and for Python and JS also block strings (docstrings, multi-line
 * template literals): they describe code. Line numbers stay the same.
 */
function codeLines(file: string, text: string): string[] {
  const language = LEXED[extname(file).toLowerCase()];
  if (!language) return text.split(/\r?\n/).map(stripTrailingComment);
  const source = lex(text, language);
  const chars = text.split("");
  for (let i = 0; i < chars.length; i++) {
    if (source.mask[i] === COMMENT && chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  }
  for (const s of source.strings) {
    // Only a block string that stands alone as a statement (a docstring, a comment block) is prose;
    // `URL = """https://..."""` or `post(\`...\`)` is a value.
    if (!s.block || !standsAlone(text, s.start)) continue;
    for (let i = s.start; i < s.end; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  }
  return chars.join("").split(/\r?\n/);
}

/**
 * Scans one file for calls to Google's Perspective API (Comment Analyzer), which stops after 2026-12-31:
 * the endpoint host, the Google API client for the service, client packages in manifests, and (only when
 * nothing else in the file points at the API) a Perspective key variable.
 */
export function scanPerspective(file: string, text: string, today = new Date().toISOString().slice(0, 10)): Finding[] {
  const ext = extname(file).toLowerCase();
  const manifest = ["package.json", "composer.json", "Gemfile"].includes(basename(file)) || PYTHON_MANIFEST.test(basename(file));
  if (PROSE_EXTENSIONS.has(ext) && !manifest) return [];
  const when = shutdownWhen(today);
  const findings: Finding[] = [];
  const raw = text.split(/\r?\n/);
  const lines = manifest ? raw : codeLines(file, text);
  let keyLine = 0;
  let dependencyTable = false; // TOML: inside a Poetry / Pipfile dependency table

  const push = (line: number, rule: string, severity: Finding["severity"], message: string) =>
    findings.push({ file, line, provider: "perspective", rule, severity, message, urgent: when.urgent });

  lines.forEach((content, index) => {
    if (content.length > MAX_LINE_LENGTH) return;
    const line = index + 1;
    const previous = lines[index - 1] ?? "";

    if (manifest) {
      const section = /^\s*\[([^\]]+)\]\s*$/.exec(content);
      if (section) dependencyTable = DEPENDENCY_TABLE.test(section[1]!.trim());
      const client = manifestClient(file, content, dependencyTable);
      if (client) {
        push(line, "client-package", "error",
          `Depends on ${client}, a client for Google's Perspective API, which ${when.text}. ${REPLACEMENT}`);
      }
      return;
    }
    if (COMMENT_LINE.test(content)) return;

    const host = HOST.exec(content);
    if (host) {
      const quote = Math.max(content.lastIndexOf('"', host.index), content.lastIndexOf("'", host.index), content.lastIndexOf("`", host.index));
      const before = quote >= 0 ? content.slice(0, quote + 1) : "";
      const lone = LONE_STRING.test(content);
      const above = lines.slice(Math.max(0, index - 2), index).join(" ");
      const fallback =
        (CONFIG_READ.test(before) && FALLBACK_BEFORE_URL.test(before)) ||
        (lone && CONFIG_READ.test(above) && /,\s*$/.test(previous.trimEnd() === "" ? above : previous));
      const named =
        DEFAULT_ASSIGNMENT.test(content) || (lone && DEFAULT_ASSIGNMENT.test(previous)) ||
        DEFAULT_ARGUMENT.test(before);
      if (fallback || named) {
        push(line, "endpoint-default", "warn",
          `Perspective endpoint used as a default (${fallback ? "the fallback of a setting lookup" : "a value named as a default"}); ` +
          `the default ${when.text}. Make sure deployments set the real value to a replacement before then.`);
      } else if (DISCOVERY.test(content)) {
        push(line, "google-client", "error",
          `Loads the Perspective discovery document from commentanalyzer.googleapis.com, which ${when.text}. ` +
          REPLACEMENT + " With the Google client, the replacement also has to serve the discovery document " +
          "(or switch the call to plain HTTP).");
      } else {
        push(line, "endpoint", "error",
          `Hard-coded Perspective API endpoint (commentanalyzer.googleapis.com), which ${when.text}. ${REPLACEMENT}`);
      }
      return;
    }
    if (SPLIT_URL.test(content)) {
      push(line, "endpoint", "error",
        `Perspective API endpoint built from pieces (commentanalyzer.googleapis.com), which ${when.text}. ${REPLACEMENT}`);
      return;
    }
    // `build("commentanalyzer", ..., discoveryServiceUrl="https://commentanalyzer...")` is one call: report the URL line.
    const urlBelow = lines.slice(index + 1, index + 6).some((l) => DISCOVERY.test(l));
    const client = GOOGLE_CLIENT.some((re) => re.test(content)) || (LONE_SERVICE.test(content) && BUILD_OPEN.test(previous));
    if (client && !urlBelow) {
      push(line, "google-client", "error",
        `Calls Perspective through the Google API client (service "commentanalyzer"), which ${when.text}. ` +
        "The generated client takes a root URL option (rootUrl / client_options api_endpoint); " + REPLACEMENT);
      return;
    }
    if (!keyLine && KEY_ENV.test(content)) keyLine = line;
  });

  if (findings.length === 0 && keyLine) {
    push(keyLine, "api-key", "warn",
      `Reads a Perspective API key; the API ${when.text}. Check where the key is used: ` +
      "the request may go through a library or a URL built elsewhere.");
  }
  return findings;
}
