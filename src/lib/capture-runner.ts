import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRepoContext, parseGitHubUrl } from "@/lib/repo-context";
import type { AgentLog, DemoCapturePlan, DemoCaptureResult, RepoContext } from "@/lib/types";

const CAPTURE_ROOT = path.join(tmpdir(), "demomaster-captures");
const LOCAL_RUN_ROOT = path.join(tmpdir(), "demomaster-runs");
const VIEWPORT = { width: 1280, height: 720 };
const PUBLIC_CAPTURE_TIMEOUT_MS = 45000;
const LOCAL_INSTALL_TIMEOUT_MS = 180000;
const LOCAL_BOOT_TIMEOUT_MS = 70000;

type CaptureProvider = DemoCaptureResult["provider"];

interface CaptureAttempt {
  capture?: DemoCaptureResult;
  entries: AgentLog["entries"];
}

export async function runBrowserCapture(repoUrl: string, plan: DemoCapturePlan): Promise<{
  capture: DemoCaptureResult;
  agentLog: AgentLog;
}> {
  const entries: AgentLog["entries"] = [];
  const repo = await loadRepoContext(repoUrl);
  const publicCandidates = publicUrlCandidates(repo, plan);

  if (publicCandidates.length) {
    entries.push({
      step: "Find public demo URL",
      status: "done",
      message: `Trying ${publicCandidates[0]} before local install.`,
    });
    const publicAttempt = await capturePublicUrl(publicCandidates[0], repoUrl);
    entries.push(...publicAttempt.entries);
    if (publicAttempt.capture?.status === "ready") {
      return result(publicAttempt.capture, entries);
    }
  } else {
    entries.push({
      step: "Find public demo URL",
      status: "skipped",
      message: "No public homepage or hosted demo URL was found in GitHub metadata or sampled repo files.",
    });
  }

  const localAttempt = await captureLocalRepo(repoUrl, plan, entries);
  entries.push(...localAttempt.entries);
  if (localAttempt.capture) return result(localAttempt.capture, entries);

  return result(
    {
      status: "error",
      provider: "local-runner",
      message: "Public URL capture and local runner capture both failed.",
      logs: entries,
    },
    entries,
  );
}

function result(capture: DemoCaptureResult, entries: AgentLog["entries"]) {
  capture.logs = entries;
  return {
    capture,
    agentLog: {
      agent: "Browser Capture Agent" as const,
      provider: "browser" as const,
      entries,
    },
  };
}

async function capturePublicUrl(url: string, repoUrl: string): Promise<CaptureAttempt> {
  try {
    const capture = await captureUrl(url, "public-url", "Captured the public demo URL with Playwright.", repoUrl);
    return {
      capture,
      entries: [
        {
          step: "Record public URL",
          status: "done",
          message: `Captured ${url}.`,
        },
      ],
    };
  } catch (error) {
    return {
      entries: [
        {
          step: "Record public URL",
          status: "error",
          message: errorMessage(error, "Public URL capture failed."),
        },
      ],
    };
  }
}

async function captureLocalRepo(repoUrl: string, plan: DemoCapturePlan, previousEntries: AgentLog["entries"]): Promise<CaptureAttempt> {
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    return {
      entries: [
        {
          step: "Run local repo",
          status: "skipped",
          message: "Local runner currently accepts GitHub repository URLs only.",
        },
      ],
    };
  }

  let child: ChildProcess | undefined;
  let runDir = "";
  try {
    await mkdir(LOCAL_RUN_ROOT, { recursive: true });
    runDir = await mkdtemp(path.join(LOCAL_RUN_ROOT, "run-"));
    const appDir = path.join(runDir, "app");
    const cloneUrl = githubCloneUrl(parsed.owner, parsed.repo);
    const branchArgs = parsed.branch ? ["--branch", parsed.branch] : [];

    await runCommand("git", ["clone", "--depth=1", ...branchArgs, cloneUrl, appDir], runDir, 60000);
    previousEntries.push({
      step: "Clone repository locally",
      status: "done",
      message: `Cloned ${parsed.owner}/${parsed.repo} into a temporary local runner.`,
    });

    const packageJsonPath = path.join(appDir, "package.json");
    if (!existsSync(packageJsonPath)) throw new Error("No package.json found at the repository root.");

    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
    const manager = detectPackageManager(appDir);
    await enableCorepack(manager, appDir);
    await runInstall(manager, appDir);
    previousEntries.push({
      step: "Install dependencies",
      status: "done",
      message: `${installLabel(manager)} completed in the temporary local runner.`,
    });

    const script = chooseRunScript(packageJson.scripts || {});
    if (!script) throw new Error("No dev, start, or preview script found in package.json.");
    const port = await freePort(0);
    child = startApp(manager, script, appDir, port);
    const targetUrl = await waitForHttp(`http://127.0.0.1:${port}`, LOCAL_BOOT_TIMEOUT_MS);
    previousEntries.push({
      step: "Run repository locally",
      status: "done",
      message: `${runLabel(manager, script)} responded on ${targetUrl}.`,
    });

    const capture = await captureUrl(targetUrl, "local-runner", "Captured the repository running in a local temporary runner, then stopped and removed the runner.", repoUrl);
    return {
      capture,
      entries: [
        {
          step: "Record local app",
          status: "done",
          message: "Recorded a real browser session from the local runner.",
        },
        {
          step: "Clean up local runner",
          status: "done",
          message: "Stopped the temporary app process and removed the cloned working folder after recording.",
        },
      ],
    };
  } catch (error) {
    return {
      entries: [
        {
          step: "Run local repo",
          status: "error",
          message: errorMessage(error, "Local runner capture failed."),
        },
      ],
    };
  } finally {
    stopProcess(child);
    if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function captureUrl(url: string, provider: CaptureProvider, message: string, repoUrl: string): Promise<DemoCaptureResult> {
  const { chromium } = await import("playwright");
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dir = path.join(CAPTURE_ROOT, runId);
  const videoDir = path.join(dir, "videos");
  await mkdir(videoDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  const page = await context.newPage();
  let videoPath = "";
  let video: ReturnType<typeof page.video> | null = null;
  let interactionSummary: string[] = [];

  try {
    await withTimeout(page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }), PUBLIC_CAPTURE_TIMEOUT_MS, "Page did not load in time.");
    video = page.video();
    await page.waitForTimeout(1800);
    interactionSummary = await performDemoInteractionFlow(page, repoUrl);
    await page.screenshot({ path: path.join(dir, "capture.png"), fullPage: false });
    await page.waitForTimeout(900);
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    videoPath = video ? await video.path().catch(() => "") : "";
    await browser.close().catch(() => undefined);
  }

  if (videoPath) await copyFile(videoPath, path.join(dir, "capture.webm")).catch(() => undefined);
  await writeFile(path.join(dir, "meta.json"), JSON.stringify({ url, provider, capturedAt: new Date().toISOString(), interactionSummary }, null, 2));

  return {
    status: "ready",
    provider,
    runId,
    targetUrl: url,
    screenshotUrl: `/api/captures/${runId}/capture.png`,
    videoUrl: existsSync(path.join(dir, "capture.webm")) ? `/api/captures/${runId}/capture.webm` : undefined,
    interactionSummary,
    message,
    logs: [],
  };
}

async function performDemoInteractionFlow(page: import("playwright").Page, repoUrl: string) {
  const summary = ["Opened the live product page in a browser."];
  await page.mouse.move(170, 120);
  await page.waitForTimeout(450);

  const input = await findRepoLikeInput(page);
  if (input) {
    await input.click({ timeout: 2500 }).catch(() => undefined);
    summary.push("Focused the main repository or URL input field.");
    await page.waitForTimeout(300);

    const generateButton = await findGenerateButton(page);
    if (generateButton && (await isButtonSafeForFastValidation(generateButton))) {
      await input.fill("", { timeout: 2500 }).catch(() => undefined);
      await page.waitForTimeout(450);
      await generateButton.click({ timeout: 2500 }).catch(() => undefined);
      summary.push("Triggered the empty-input state to show the validation or ready-state behavior.");
      await page.waitForTimeout(1300);
    }

    await input.click({ timeout: 2500 }).catch(() => undefined);
    await input.fill(repoUrl, { timeout: 2500 }).catch(() => undefined);
    summary.push(`Entered the target URL or repository: ${repoUrl}.`);
    await page.waitForTimeout(750);

    const button = generateButton || (await findGenerateButton(page));
    if (button) {
      const box = await button.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        summary.push("Hovered the primary generate/start action without launching a long recursive job.");
        await page.waitForTimeout(1000);
      }
    }

    return summary;
  }

  summary.push(...(await runPublicProductFlow(page)));
  return summary;
}

async function findRepoLikeInput(page: import("playwright").Page) {
  const selectors = [
    'input[placeholder*="github" i]',
    'input[placeholder*="repo" i]',
    'input[placeholder*="url" i]',
    'input[name*="repo" i]',
    'input[name*="url" i]',
    'input[type="url"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.count().catch(() => 0))) continue;
    const visible = await locator.isVisible().catch(() => false);
    const enabled = await locator.isEnabled().catch(() => false);
    if (!visible || !enabled) continue;
    return locator;
  }

  const fallback = page.locator("input").first();
  if ((await fallback.count().catch(() => 0)) && (await fallback.isVisible().catch(() => false))) return fallback;
  return null;
}

async function findGenerateButton(page: import("playwright").Page) {
  const candidates = [
    page.getByRole("button", { name: /generate/i }).first(),
    page.getByRole("button", { name: /start/i }).first(),
    page.getByRole("button", { name: /run/i }).first(),
    page.locator("button").first(),
  ];

  for (const locator of candidates) {
    if (!(await locator.count().catch(() => 0))) continue;
    if ((await locator.isVisible().catch(() => false)) && (await locator.isEnabled().catch(() => false))) return locator;
  }

  return null;
}

async function isButtonSafeForFastValidation(button: import("playwright").Locator) {
  const type = await button.getAttribute("type").catch(() => "");
  return type === "button";
}

async function exploreVisiblePage(page: import("playwright").Page) {
  await page.mouse.move(320, 260);
  await page.waitForTimeout(700);

  const buttons = page.locator("button");
  const count = Math.min(await buttons.count().catch(() => 0), 3);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const box = await button.boundingBox().catch(() => null);
    if (!box) continue;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
  }

  await page.mouse.wheel(0, 420).catch(() => undefined);
  await page.waitForTimeout(900);
}

async function runPublicProductFlow(page: import("playwright").Page) {
  const summary: string[] = [];
  const primary = await findPrimaryProductAction(page);
  if (primary) {
    const label = await primary.innerText().catch(() => "primary call to action");
    const box = await primary.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(500);
    }
    await primary.click({ timeout: 2500 }).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    summary.push(`Clicked the primary action "${cleanInline(label)}" and showed the next product step.`);
  }

  const formInputs = page.locator("input, textarea");
  const inputCount = await formInputs.count().catch(() => 0);
  if (inputCount > 0) {
    const first = formInputs.first();
    if (await first.isVisible().catch(() => false)) {
      await first.click({ timeout: 2500 }).catch(() => undefined);
      await page.waitForTimeout(400);
      summary.push("Focused the first form field on the next step.");
    }

    const submit = await findSubmitLikeButton(page);
    if (submit && (await submit.isEnabled().catch(() => false))) {
      const label = await submit.innerText().catch(() => "submit");
      await submit.click({ timeout: 2500 }).catch(() => undefined);
      await page.waitForTimeout(1200);
      summary.push(`Clicked "${cleanInline(label)}" with empty fields to demonstrate the guarded form state.`);
    }
  } else {
    await exploreVisiblePage(page);
    summary.push("Scrolled and hovered visible product sections to show the main offering and supporting content.");
  }

  return summary.length ? summary : ["Explored the visible product page without submitting data."];
}

async function findPrimaryProductAction(page: import("playwright").Page) {
  const labels = [
    /create a story/i,
    /start creating/i,
    /get started/i,
    /try/i,
    /start/i,
    /create/i,
  ];

  for (const label of labels) {
    const locator = page.getByRole("button", { name: label }).first();
    if ((await locator.count().catch(() => 0)) && (await locator.isVisible().catch(() => false))) return locator;
  }

  const link = page.getByRole("link", { name: /get started|start|create|try/i }).first();
  if ((await link.count().catch(() => 0)) && (await link.isVisible().catch(() => false))) return link;
  return null;
}

async function findSubmitLikeButton(page: import("playwright").Page) {
  const labels = [/sign in/i, /sign up/i, /continue/i, /submit/i, /create/i, /generate/i];
  for (const label of labels) {
    const locator = page.getByRole("button", { name: label }).first();
    if ((await locator.count().catch(() => 0)) && (await locator.isVisible().catch(() => false))) return locator;
  }
  return null;
}

function cleanInline(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function publicUrlCandidates(repo: RepoContext, plan: DemoCapturePlan) {
  const urls = [
    plan.targetUrl,
    repo.homepage,
    ...repo.files.flatMap((file) => extractUrls(file.content)),
  ]
    .filter((url): url is string => Boolean(url))
    .map((url) => normalizePublicUrl(url))
    .filter((url): url is string => Boolean(url))
    .filter(isCaptureCandidate);

  return [...new Set(urls)].sort((a, b) => publicUrlScore(b) - publicUrlScore(a));
}

function extractUrls(text: string) {
  return text.match(/https?:\/\/[^\s"'`)<\]}]+/g) || [];
}

function normalizePublicUrl(raw: string) {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function isCaptureCandidate(raw: string) {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (isPrivateHost(host)) return false;
    if (host === "github.com" || host.endsWith(".github.com")) return false;
    if (/\.(png|jpe?g|gif|webp|svg|mp4|mov|mp3|wav|zip|tar|gz|pdf)$/i.test(url.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function publicUrlScore(raw: string) {
  const host = new URL(raw).hostname.toLowerCase();
  if (/(vercel\.app|netlify\.app|pages\.dev|github\.io|onrender\.com|railway\.app|fly\.dev|herokuapp\.com)$/.test(host)) return 100;
  if (/demo|app|preview|launch|live/.test(raw.toLowerCase())) return 50;
  return 10;
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,2})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function detectPackageManager(appDir: string) {
  if (existsSync(path.join(appDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(appDir, "yarn.lock"))) return "yarn";
  return "npm";
}

async function enableCorepack(manager: string, cwd: string) {
  if (manager === "npm") return;
  await runCommand("corepack", ["enable"], cwd, 30000).catch(() => undefined);
}

async function runInstall(manager: string, cwd: string) {
  if (manager === "pnpm") return runCommand("corepack", ["pnpm", "install", "--no-frozen-lockfile"], cwd, LOCAL_INSTALL_TIMEOUT_MS);
  if (manager === "yarn") return runCommand("corepack", ["yarn", "install"], cwd, LOCAL_INSTALL_TIMEOUT_MS);
  return runCommand("npm", ["install"], cwd, LOCAL_INSTALL_TIMEOUT_MS);
}

function startApp(manager: string, script: string, cwd: string, port: number) {
  const command = manager === "npm" ? "npm" : "corepack";
  const args = manager === "npm" ? ["run", script] : [manager, "run", script];
  return spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      BROWSER: "none",
      CI: "1",
      HOST: "127.0.0.1",
      HOSTNAME: "127.0.0.1",
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(port),
      VITE_HOST: "127.0.0.1",
    },
  });
}

function chooseRunScript(scripts: Record<string, string>) {
  return ["dev", "start", "preview"].find((script) => scripts[script]);
}

function installLabel(manager: string) {
  if (manager === "pnpm") return "pnpm install";
  if (manager === "yarn") return "yarn install";
  return "npm install";
}

function runLabel(manager: string, script: string) {
  return manager === "npm" ? `npm run ${script}` : `${manager} run ${script}`;
}

async function runCommand(command: string, args: string[], cwd: string, timeoutMs: number) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out.`));
    }, timeoutMs);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`${command} ${redact(args.join(" "))} failed. ${redact(output.slice(-900))}`);
  }
}

function githubCloneUrl(owner: string, repo: string) {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return `https://github.com/${owner}/${repo}.git`;
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

function redact(value: string) {
  return value
    .replace(/x-access-token:[^@\s]+@github\.com/gi, "x-access-token:[redacted]@github.com")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
}

async function waitForHttp(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2500) });
      if (response.status < 500) return url;
    } catch {
      await sleep(1500);
    }
  }
  throw new Error(`Local app did not respond on ${url}.`);
}

async function freePort(preferred: number) {
  const net = await import("node:net");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const port = attempt === 0 && preferred > 0 ? preferred : 4100 + Math.floor(Math.random() * 20000);
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  throw new Error("Could not find a free local port.");
}

function stopProcess(child?: ChildProcess) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
