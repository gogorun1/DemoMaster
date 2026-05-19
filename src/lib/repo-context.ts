import type { RepoContext, RepoFileSummary } from "@/lib/types";

interface GitHubRepoInfo {
  default_branch: string;
  description?: string;
  homepage?: string;
  language?: string;
}

interface GitHubTreeItem {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

interface GitHubTreeResponse {
  tree: GitHubTreeItem[];
  truncated: boolean;
}

const MAX_FILES = 12;
const MAX_FILE_CHARS = 3200;
const MAX_TOTAL_CHARS = 36000;
const GITHUB_FETCH_TIMEOUT_MS = 12000;

const IMPORTANT_FILE = /(^readme|package\.json$|pnpm-workspace|turbo\.json|next\.config|vite\.config|src\/|app\/|pages\/|components\/|lib\/|server\/|api\/|docs\/|prisma\/|schema|routes|README)/i;
const SKIP_FILE = /(^|\/)(node_modules|\.git|\.next|dist|build|coverage|out|vendor|public\/.*\.(png|jpe?g|gif|webp|avif|mp4|mov|mp3|wav)|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)(\/|$)/i;
const TEXT_FILE = /\.(md|mdx|txt|json|ts|tsx|js|jsx|mjs|cjs|css|scss|html|py|go|rs|java|kt|swift|rb|php|yml|yaml|toml|prisma|sql)$/i;

export function parseGitHubUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2], branch: undefined as string | undefined };

  try {
    const url = new URL(trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed);
    if (!/github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const branch = parts[2] === "tree" && parts[3] ? parts.slice(3).join("/") : undefined;
    return { owner: parts[0], repo: parts[1], branch };
  } catch {
    return null;
  }
}

export async function loadRepoContext(repoUrl: string): Promise<RepoContext> {
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    return {
      source: "manual",
      repoUrl,
      fileTree: [],
      files: [],
      warnings: ["Only GitHub repository URLs are automatically inspected in this MVP."],
    };
  }

  const warnings: string[] = [];
  const headers = githubHeaders();

  try {
    const repoInfo = await githubFetch<GitHubRepoInfo>(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`,
      headers,
    );
    const branch = parsed.branch ?? repoInfo.default_branch;
    const tree = await githubFetch<GitHubTreeResponse>(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      headers,
    );

    if (tree.truncated) {
      warnings.push("GitHub returned a truncated tree; DemoMaster sampled the most relevant files.");
    }

    const fileTree = tree.tree
      .filter((item) => item.type === "blob")
      .map((item) => item.path)
      .sort((a, b) => a.localeCompare(b));

    const fileResults = await Promise.allSettled(
      selectFiles(tree.tree).map(async (file) => {
        const raw = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${branch}/${file.path}`;
        const content = await fetchText(raw, headers);
        const truncated = content.length > MAX_FILE_CHARS;
        return {
          path: file.path,
          content: truncated ? `${content.slice(0, MAX_FILE_CHARS)}\n\n[truncated]` : content,
        };
      }),
    );

    const files: RepoFileSummary[] = [];
    let totalChars = 0;
    for (const result of fileResults) {
      if (result.status === "rejected") {
        warnings.push("Could not read one sampled file.");
        continue;
      }
      if (totalChars >= MAX_TOTAL_CHARS) break;
      totalChars += result.value.content.length;
      files.push(result.value);
    }

    return {
      source: "github",
      repoUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      branch,
      description: repoInfo.description,
      homepage: repoInfo.homepage,
      language: repoInfo.language,
      fileTree,
      files,
      warnings,
    };
  } catch (error) {
    return {
      source: "unavailable",
      repoUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: parsed.branch,
      fileTree: [],
      files: [],
      warnings: [`GitHub inspection failed: ${error instanceof Error ? error.message : "unknown error"}`],
    };
  }
}

function githubHeaders() {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "DemoMaster",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function githubFetch<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetchWithTimeout(url, { headers, cache: "no-store" }, GITHUB_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function fetchText(url: string, headers: Record<string, string>) {
  const response = await fetchWithTimeout(url, { headers, cache: "no-store" }, GITHUB_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function selectFiles(items: GitHubTreeItem[]) {
  return items
    .filter((item) => item.type === "blob")
    .filter((item) => !SKIP_FILE.test(item.path))
    .filter((item) => TEXT_FILE.test(item.path) || /(^|\/)(Dockerfile|Procfile|Makefile)$/i.test(item.path))
    .sort((a, b) => scoreFile(b) - scoreFile(a))
    .slice(0, MAX_FILES);
}

function scoreFile(item: GitHubTreeItem) {
  let score = 0;
  const path = item.path.toLowerCase();
  if (IMPORTANT_FILE.test(item.path)) score += 30;
  if (path.includes("readme")) score += 40;
  if (path.endsWith("package.json")) score += 32;
  if (path.includes("/app/") || path.startsWith("app/")) score += 18;
  if (path.includes("/components/") || path.startsWith("components/")) score += 14;
  if (path.includes("/api/") || path.includes("route.")) score += 12;
  if (path.includes("test") || path.includes("spec")) score -= 8;
  if ((item.size ?? 0) > 50000) score -= 18;
  return score;
}
