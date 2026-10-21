#!/usr/bin/env node
// Generate language statistics for a GitHub profile README.
//
// Output (in the directory given as the first argument, default "generated"):
//   languages.svg  - a "Top Languages" card (light/dark aware)
//
// Environment variables:
//   GITHUB_TOKEN       (required) token used for the GitHub API
//   GITHUB_USER        (required) user whose repositories are counted
//   INCLUDE_PRIVATE    "true" to include private repositories (needs a PAT)
//   EXCLUDE_LANGUAGES  comma separated language names to ignore
//   EXCLUDE_REPOS      comma separated repository names to ignore
//   TOP_N              number of languages to show before "Other" (default 8)
//
// Percentages use the same per-language byte counts as GitHub's language bar
// (REST: GET /repos/{owner}/{repo}/languages, computed by Linguist).

import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";
const FALLBACK_COLOR = "#8b949e";

// Subset of Linguist's colors. Unknown languages fall back to gray.
const COLORS = {
  Rust: "#dea584",
  Python: "#3572A5",
  JavaScript: "#f1e05a",
  TypeScript: "#3178c6",
  "C++": "#f34b7d",
  C: "#555555",
  "C#": "#178600",
  Java: "#b07219",
  Kotlin: "#A97BFF",
  Swift: "#F05138",
  Go: "#00ADD8",
  Zig: "#ec915c",
  Nix: "#7e7eff",
  Shell: "#89e051",
  Lua: "#000080",
  HTML: "#e34c26",
  CSS: "#563d7c",
  SCSS: "#c6538c",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  QML: "#44a51c",
  Typst: "#239dad",
  TeX: "#3D6117",
  Haskell: "#5e5086",
  OCaml: "#ef7a08",
  Elixir: "#6e4a7e",
  Ruby: "#701516",
  PHP: "#4F5D95",
  Dart: "#00B4AB",
  Scala: "#c22d40",
  R: "#198CE7",
  Perl: "#0298c3",
  Makefile: "#427819",
  Dockerfile: "#384d54",
  PowerShell: "#012456",
  Batchfile: "#C1F12E",
  "Vim Script": "#199f4b",
  "Emacs Lisp": "#c065db",
  "Jupyter Notebook": "#DA5B0B",
  GLSL: "#5686a5",
  WGSL: "#1a5e9a",
  Verilog: "#b2b7f8",
  VHDL: "#adb2cb",
  SystemVerilog: "#DAE1C2",
  Assembly: "#6E4C13",
};

export function parseList(value) {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- GitHub API

async function api(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "profile-language-stats",
    },
  });
  if (!res.ok) {
    const err = new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function paginate(path, token) {
  const items = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const batch = await api(`${path}${sep}per_page=100&page=${page}`, token);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

export async function collectLanguages({
  user,
  token,
  includePrivate = false,
  excludeRepos = [],
  log = () => {},
}) {
  // /user/repos works only with a user token (PAT) and includes private repos.
  // /users/{user}/repos works with any token but returns public repos only.
  const path = includePrivate
    ? "/user/repos?affiliation=owner&visibility=all"
    : `/users/${encodeURIComponent(user)}/repos?type=owner`;
  const skip = new Set(excludeRepos.map((r) => r.toLowerCase()));

  const repos = (await paginate(path, token)).filter(
    (r) =>
      r.owner.login.toLowerCase() === user.toLowerCase() &&
      !r.fork &&
      !skip.has(r.name.toLowerCase()),
  );
  log(`Counting ${repos.length} repositories (forks excluded)`);

  const perRepo = await mapLimit(repos, 8, async (repo) => {
    try {
      return await api(`/repos/${repo.full_name}/languages`, token);
    } catch (e) {
      // Empty or inaccessible repositories are skipped; anything else
      // (rate limit, auth failure, ...) should fail the run loudly.
      if (e.status === 404 || e.status === 409) return {};
      throw e;
    }
  });

  const totals = new Map();
  for (const langs of perRepo) {
    for (const [name, bytes] of Object.entries(langs)) {
      totals.set(name, (totals.get(name) ?? 0) + bytes);
    }
  }
  return { totals, repoCount: repos.length };
}

// ------------------------------------------------------------- aggregation

export function summarize(totals, { exclude = [], top = 8 } = {}) {
  const skip = new Set(exclude.map((l) => l.toLowerCase()));
  const entries = [...totals]
    .filter(([name]) => !skip.has(name.toLowerCase()))
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
  if (total === 0) return { total: 0, items: [] };

  const toItem = ([name, bytes]) => ({
    name,
    bytes,
    percent: (bytes / total) * 100,
    color: COLORS[name] ?? FALLBACK_COLOR,
  });

  const items = entries.slice(0, top).map(toItem);
  const rest = entries.slice(top);
  if (rest.length > 0) {
    const bytes = rest.reduce((sum, [, b]) => sum + b, 0);
    items.push({
      name: "Other",
      bytes,
      percent: (bytes / total) * 100,
      color: FALLBACK_COLOR,
    });
  }
  return { total, items };
}

// --------------------------------------------------------------- rendering

const esc = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const fmt = (p) => `${p.toFixed(1)}%`;

export function renderSvg({ items }) {
  const W = 495;
  const PAD = 25;
  const BAR_W = W - PAD * 2;
  const COL_W = 230;
  const ROW_H = 25;
  const LEGEND_Y = 95;

  const rows = Math.ceil(items.length / 2);
  const H = items.length === 0 ? 90 : LEGEND_Y + rows * ROW_H + 5;
  const summary = items.map((i) => `${i.name} ${fmt(i.percent)}`).join(", ");

  let x = PAD;
  const segments = items
    .map((item) => {
      const w = (item.percent / 100) * BAR_W;
      const rect = `<rect x="${x.toFixed(2)}" y="52" width="${w.toFixed(2)}" height="10" fill="${item.color}"/>`;
      x += w;
      return rect;
    })
    .join("\n    ");

  const legend = items
    .map((item, i) => {
      const lx = PAD + (i % 2) * COL_W;
      const ly = LEGEND_Y + Math.floor(i / 2) * ROW_H;
      return [
        `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${item.color}"/>`,
        `<text class="name" x="${lx + 16}" y="${ly}">${esc(item.name)}</text>`,
        `<text class="pct" x="${lx + COL_W - 30}" y="${ly}" text-anchor="end">${fmt(item.percent)}</text>`,
      ].join("\n  ");
    })
    .join("\n  ");

  const body =
    items.length === 0
      ? `<text class="pct" x="${PAD}" y="70">No language data</text>`
      : `<clipPath id="bar"><rect x="${PAD}" y="52" width="${BAR_W}" height="10" rx="5"/></clipPath>
  <g clip-path="url(#bar)">
    ${segments}
  </g>
  ${legend}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
  <title id="title">Top Languages: ${esc(summary)}</title>
  <style>
    :root { --bg: #ffffff; --border: #d0d7de; --text: #1f2328; --muted: #656d76; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #0d1117; --border: #30363d; --text: #e6edf3; --muted: #8d96a0; }
    }
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .title { font-size: 18px; font-weight: 600; fill: var(--text); }
    .name { font-size: 13px; fill: var(--text); }
    .pct { font-size: 13px; fill: var(--muted); }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="var(--bg)" stroke="var(--border)"/>
  <text class="title" x="${PAD}" y="35">Top Languages</text>
  ${body}
</svg>
`;
}

// -------------------------------------------------------------------- main

async function main() {
  const outDir = process.argv[2] ?? "generated";
  const token = process.env.GITHUB_TOKEN;
  const user = process.env.GITHUB_USER;
  if (!token || !user) {
    throw new Error("GITHUB_TOKEN and GITHUB_USER must be set");
  }

  const { totals } = await collectLanguages({
    user,
    token,
    includePrivate: process.env.INCLUDE_PRIVATE === "true",
    excludeRepos: parseList(process.env.EXCLUDE_REPOS),
    log: (m) => console.log(m),
  });

  const stats = summarize(totals, {
    exclude: parseList(process.env.EXCLUDE_LANGUAGES),
    top: Number(process.env.TOP_N) || 8,
  });

  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}/languages.svg`, renderSvg(stats));

  for (const item of stats.items) console.log(`${item.name}: ${fmt(item.percent)}`);
}

// Run only when executed directly (not when imported, e.g. by tests).
// realpath: Node resolves symlinks in import.meta.url but not in argv[1].
const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
