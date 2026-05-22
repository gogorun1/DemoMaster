import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { loadRepoContext, parseGitHubUrl } from "@/lib/repo-context";
import type { AgentLog, DemoCapturePlan, DemoCaptureResult, RepoContext } from "@/lib/types";
import type { Page } from "playwright-core";

const CAPTURE_ROOT = path.join(tmpdir(), "demomaster-captures");
const LOCAL_RUN_ROOT = path.join(tmpdir(), "demomaster-runs");
const VIEWPORT = { width: 1280, height: 720 };
const PUBLIC_CAPTURE_TIMEOUT_MS = 45000;
const LOCAL_INSTALL_TIMEOUT_MS = 180000;
const LOCAL_BOOT_TIMEOUT_MS = 70000;
const LOCAL_RUNNER_ENABLE_FLAG = "1";
const MAX_PUBLIC_CAPTURE_CANDIDATES = 4;
const SANDBOX_CAPTURE_BACKEND = "sandbox";
const DEFAULT_SANDBOX_TIMEOUT_MS = 300000;
const DEFAULT_SANDBOX_VCPUS = 2;

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
      message: `Found ${publicCandidates.length} public URL candidate${publicCandidates.length === 1 ? "" : "s"}; trying up to ${MAX_PUBLIC_CAPTURE_CANDIDATES} before local install.`,
    });

    for (const candidate of publicCandidates.slice(0, MAX_PUBLIC_CAPTURE_CANDIDATES)) {
      entries.push({
        step: "Try public URL",
        status: "running",
        message: candidate,
      });
      const publicAttempt = await capturePublicUrl(candidate, repoUrl);
      entries.push(...publicAttempt.entries);
      if (publicAttempt.capture?.status === "ready") {
        return result(publicAttempt.capture, entries);
      }
    }
  } else {
    entries.push({
      step: "Find public demo URL",
      status: "skipped",
      message: "No public homepage or hosted demo URL was found in GitHub metadata or sampled repo files.",
    });
  }

  const sandboxAttempt = await captureSandboxRepo(repoUrl, plan, entries);
  entries.push(...sandboxAttempt.entries);
  if (sandboxAttempt.capture) return result(sandboxAttempt.capture, entries);

  const localAttempt = await captureLocalRepo(repoUrl, plan, entries);
  entries.push(...localAttempt.entries);
  if (localAttempt.capture) return result(localAttempt.capture, entries);

  return result(
    {
      status: entries.some((entry) => entry.status === "error") ? "error" : "skipped",
      provider: "local-runner",
      message: captureFailureMessage(entries),
      logs: entries,
    },
    entries,
  );
}

async function captureSandboxRepo(repoUrl: string, plan: DemoCapturePlan, previousEntries: AgentLog["entries"]): Promise<CaptureAttempt> {
  if (process.env.DEMOMASTER_CAPTURE_BACKEND !== SANDBOX_CAPTURE_BACKEND) {
    return {
      entries: [
        {
          step: "Run sandbox repo",
          status: "skipped",
          message: "Sandbox runner is disabled. Set DEMOMASTER_CAPTURE_BACKEND=sandbox to run repositories in isolated Vercel Sandbox microVMs.",
        },
      ],
    };
  }

  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    return {
      entries: [
        {
          step: "Run sandbox repo",
          status: "skipped",
          message: "Sandbox runner currently accepts GitHub repository URLs only.",
        },
      ],
    };
  }

  const port = sandboxPort(plan.port);
  let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | undefined;
  try {
    sandbox = await Sandbox.create({
      runtime: process.env.DEMOMASTER_SANDBOX_RUNTIME || "node24",
      source: {
        type: "git",
        url: githubCloneUrl(parsed.owner, parsed.repo),
        depth: 1,
        ...(parsed.branch ? { revision: parsed.branch } : {}),
      },
      ports: [port],
      resources: { vcpus: Number(process.env.DEMOMASTER_SANDBOX_VCPUS || DEFAULT_SANDBOX_VCPUS) },
      timeout: Number(process.env.DEMOMASTER_SANDBOX_TIMEOUT_MS || DEFAULT_SANDBOX_TIMEOUT_MS),
      env: sandboxBaseEnv(port),
    });
    previousEntries.push({
      step: "Create sandbox",
      status: "done",
      message: `Started isolated sandbox ${sandbox.sandboxId} for ${parsed.owner}/${parsed.repo}.`,
    });

    const appDir = "/vercel/sandbox";
    const packageJson = await readSandboxPackageJson(sandbox, appDir);
    const manager = await detectSandboxPackageManager(sandbox, appDir);
    await enableSandboxCorepack(sandbox, manager, appDir);
    await runSandboxInstall(sandbox, manager, appDir);
    previousEntries.push({
      step: "Install dependencies in sandbox",
      status: "done",
      message: `${installLabel(manager)} completed inside the isolated sandbox.`,
    });

    const script = chooseRunScript(packageJson.scripts || {});
    if (!script) throw new Error("No dev, start, or preview script found in package.json.");

    await startSandboxApp(sandbox, manager, script, appDir, port);
    const targetUrl = await waitForHttp(sandbox.domain(port), LOCAL_BOOT_TIMEOUT_MS);
    previousEntries.push({
      step: "Run repository in sandbox",
      status: "done",
      message: `${runLabel(manager, script)} responded on ${targetUrl}.`,
    });

    const capture = await captureUrl(targetUrl, "local-runner", "Captured the repository running inside an isolated Vercel Sandbox.", repoUrl);
    return {
      capture,
      entries: [
        {
          step: "Record sandbox app",
          status: "done",
          message: "Captured a real browser session from the sandbox-hosted app.",
        },
        {
          step: "Clean up sandbox",
          status: "done",
          message: "Stopped the isolated sandbox after capture.",
        },
      ],
    };
  } catch (error) {
    return {
      entries: [
        {
          step: "Run sandbox repo",
          status: "error",
          message: errorMessage(error, "Sandbox runner capture failed."),
        },
      ],
    };
  } finally {
    await sandbox?.stop({ blocking: false }).catch(() => undefined);
  }
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

function captureFailureMessage(entries: AgentLog["entries"]) {
  const details = entries
    .filter((entry) => entry.status === "error" || entry.status === "skipped")
    .map((entry) => `${entry.step}: ${entry.message}`)
    .slice(-4);

  if (!details.length) return "Demo capture was not available.";
  return `Demo capture was not available. ${details.join(" ")}`;
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

  const runnerGate = localRunnerGate(parsed.owner, parsed.repo);
  if (!runnerGate.allowed) {
    return {
      entries: [
        {
          step: "Run local repo",
          status: "skipped",
          message: runnerGate.message,
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
  const { chromium, launchOptions } = await loadChromium();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dir = path.join(CAPTURE_ROOT, runId);
  const videoDir = path.join(dir, "videos");
  await mkdir(videoDir, { recursive: true });
  const recordVideo = !process.env.VERCEL;

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: VIEWPORT,
    ...(recordVideo ? { recordVideo: { dir: videoDir, size: VIEWPORT } } : {}),
  });
  const page = await context.newPage();
  let videoPath = "";
  let video: ReturnType<typeof page.video> | null = null;
  let interactionSummary: string[] = [];
  const screenshotPath = path.join(dir, "capture.png");

  try {
    await withTimeout(page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }), PUBLIC_CAPTURE_TIMEOUT_MS, "Page did not load in time.");
    video = recordVideo ? page.video() : null;
    await page.waitForTimeout(1800);
    interactionSummary = await performDemoInteractionFlow(page, repoUrl);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    await page.waitForTimeout(900);
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    videoPath = video ? await video.path().catch(() => "") : "";
    await browser.close().catch(() => undefined);
  }

  if (videoPath) await copyFile(videoPath, path.join(dir, "capture.webm")).catch(() => undefined);
  await writeFile(path.join(dir, "meta.json"), JSON.stringify({ url, provider, capturedAt: new Date().toISOString(), interactionSummary }, null, 2));
  const screenshotUrl = process.env.VERCEL
    ? `data:image/png;base64,${(await readFile(screenshotPath)).toString("base64")}`
    : `/api/captures/${runId}/capture.png`;

  return {
    status: "ready",
    provider,
    runId,
    targetUrl: url,
    screenshotUrl,
    videoUrl: existsSync(path.join(dir, "capture.webm")) ? `/api/captures/${runId}/capture.webm` : undefined,
    interactionSummary,
    message: recordVideo ? message : `${message} Serverless capture uses the screenshot frame because video recording requires ffmpeg.`,
    logs: [],
  };
}

async function loadChromium() {
  if (process.env.VERCEL) {
    const [{ chromium }, serverlessChromium] = await Promise.all([
      import("playwright-core"),
      import("@sparticuz/chromium"),
    ]);
    const chromiumBinary = serverlessChromium.default;
    return {
      chromium,
      launchOptions: {
        args: chromiumBinary.args,
        executablePath: await chromiumBinary.executablePath(),
        headless: true,
      },
    };
  }

  const { chromium } = await import("playwright");
  return {
    chromium,
    launchOptions: { headless: true },
  };
}

async function performDemoInteractionFlow(page: Page, repoUrl: string) {
  const summary = ["Opened the live product page in a browser."];
  await page.mouse.move(170, 120);
  await page.waitForTimeout(450);

  if (await isSauceDemo(page)) {
    summary.push(...(await runSauceDemoFlow(page)));
    return summary;
  }

  if (await isTodoMvc(page)) {
    summary.push(...(await runTodoMvcFlow(page)));
    return summary;
  }

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

async function findRepoLikeInput(page: Page) {
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

  const bodyText = await page.locator("body").innerText({ timeout: 1200 }).catch(() => "");
  if (/\b(github|repository|repo url|repo|generate pitch|demomaster)\b/i.test(bodyText)) {
    const fallback = page.locator("input").first();
    if ((await fallback.count().catch(() => 0)) && (await fallback.isVisible().catch(() => false))) return fallback;
  }

  return null;
}

async function findGenerateButton(page: Page) {
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

async function isButtonSafeForFastValidation(button: import("playwright-core").Locator) {
  const type = await button.getAttribute("type").catch(() => "");
  return type === "button";
}

async function exploreVisiblePage(page: Page) {
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

async function runPublicProductFlow(page: Page) {
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

async function isSauceDemo(page: Page) {
  if (/saucedemo\.com/i.test(page.url())) return true;
  const username = page.locator('[data-test="username"], #user-name').first();
  return (await username.count().catch(() => 0)) > 0;
}

async function runSauceDemoFlow(page: Page) {
  const summary: string[] = [];
  const username = page.locator('[data-test="username"], #user-name').first();
  const password = page.locator('[data-test="password"], #password').first();
  const login = page.locator('[data-test="login-button"], #login-button').first();

  if ((await username.count().catch(() => 0)) && (await password.count().catch(() => 0))) {
    await username.fill("standard_user", { timeout: 3500 });
    await page.waitForTimeout(350);
    await password.fill("secret_sauce", { timeout: 3500 });
    await page.waitForTimeout(350);
    summary.push("Entered the public demo credentials shown by the test storefront.");
  }

  if (await login.isVisible().catch(() => false)) {
    await login.click({ timeout: 3500 });
    await page.waitForLoadState("domcontentloaded", { timeout: 7000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
    summary.push("Signed in to the demo storefront and landed on the product inventory page.");
  }

  const backpack = page.locator('[data-test="add-to-cart-sauce-labs-backpack"], button:has-text("Add to cart")').first();
  if (await backpack.isVisible().catch(() => false)) {
    await backpack.click({ timeout: 3500 });
    await page.waitForTimeout(650);
    summary.push("Added the Sauce Labs Backpack to the cart.");
  }

  const cart = page.locator('[data-test="shopping-cart-link"], .shopping_cart_link').first();
  if (await cart.isVisible().catch(() => false)) {
    await cart.click({ timeout: 3500 });
    await page.waitForTimeout(900);
    summary.push("Opened the cart and confirmed the selected item.");
  }

  const checkout = page.locator('[data-test="checkout"], button:has-text("Checkout")').first();
  if (await checkout.isVisible().catch(() => false)) {
    await checkout.click({ timeout: 3500 });
    await page.waitForTimeout(800);
    summary.push("Started checkout from the cart.");
  }

  const firstName = page.locator('[data-test="firstName"], #first-name').first();
  const lastName = page.locator('[data-test="lastName"], #last-name').first();
  const postalCode = page.locator('[data-test="postalCode"], #postal-code').first();
  if (await firstName.isVisible().catch(() => false)) {
    await firstName.fill("Demo", { timeout: 3500 });
    await lastName.fill("Buyer", { timeout: 3500 });
    await postalCode.fill("12345", { timeout: 3500 });
    await page.waitForTimeout(650);
    summary.push("Filled the checkout form with fake demo buyer information.");
  }

  const continueButton = page.locator('[data-test="continue"], input[type="submit"], button:has-text("Continue")').first();
  if (await continueButton.isVisible().catch(() => false)) {
    await continueButton.click({ timeout: 3500 });
    await page.waitForTimeout(900);
    summary.push("Continued to the order overview screen.");
  }

  const finish = page.locator('[data-test="finish"], button:has-text("Finish")').first();
  if (await finish.isVisible().catch(() => false)) {
    await finish.click({ timeout: 3500 });
    await page.waitForTimeout(1200);
    summary.push("Finished the demo checkout and showed the confirmation screen.");
  }

  return summary.length ? summary : ["Explored the Sauce Demo storefront without submitting real payment or personal data."];
}

async function isTodoMvc(page: Page) {
  const todoInput = page.locator('input[placeholder="What needs to be done?"], .new-todo').first();
  return (await todoInput.count().catch(() => 0)) > 0;
}

async function runTodoMvcFlow(page: Page) {
  const summary: string[] = [];
  const input = page.locator('input[placeholder="What needs to be done?"], .new-todo').first();
  if (!(await input.isVisible().catch(() => false))) return ["Opened the TodoMVC app, but the task input was not visible."];

  await input.fill("Draft the pitch script", { timeout: 3000 });
  await input.press("Enter", { timeout: 3000 });
  await page.waitForTimeout(450);
  await input.fill("Record the product demo", { timeout: 3000 });
  await input.press("Enter", { timeout: 3000 });
  await page.waitForTimeout(450);
  summary.push("Created two tasks in the TodoMVC workflow.");

  const firstToggle = page.locator(".toggle").first();
  if (await firstToggle.isVisible().catch(() => false)) {
    await firstToggle.check({ timeout: 3000 }).catch(() => firstToggle.click({ timeout: 3000 }));
    await page.waitForTimeout(650);
    summary.push("Marked the first task complete to show state change.");
  }

  const completed = page.getByRole("link", { name: /completed/i }).first();
  if (await completed.isVisible().catch(() => false)) {
    await completed.click({ timeout: 3000 });
    await page.waitForTimeout(650);
    summary.push("Filtered to completed tasks to show workflow navigation.");
  }

  return summary;
}

async function findPrimaryProductAction(page: Page) {
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

async function findSubmitLikeButton(page: Page) {
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
  const explicitUrls = [
    plan.targetUrl,
    repo.homepage,
    repo.source !== "github" ? repo.repoUrl : undefined,
  ]
    .filter((url): url is string => Boolean(url))
    .map((url) => normalizePublicUrl(url))
    .filter((url): url is string => Boolean(url))
    .filter(isExplicitCaptureCandidate);

  const discoveredUrls = repo.files
    .flatMap((file) => extractUrls(file.content))
    .map((url) => normalizePublicUrl(url))
    .filter((url): url is string => Boolean(url))
    .filter(isCaptureCandidate);

  return [...new Set([...explicitUrls, ...discoveredUrls])].sort((a, b) => publicUrlScore(b) - publicUrlScore(a));
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

function isExplicitCaptureCandidate(raw: string) {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
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

async function detectSandboxPackageManager(sandbox: Awaited<ReturnType<typeof Sandbox.create>>, cwd: string) {
  const result = await sandbox.runCommand({
    cmd: "sh",
    args: ["-lc", "if [ -f pnpm-lock.yaml ]; then echo pnpm; elif [ -f yarn.lock ]; then echo yarn; else echo npm; fi"],
    cwd,
    signal: AbortSignal.timeout(30000),
  });
  ensureSandboxExit(result, "Detect package manager");
  return (await result.stdout()).trim() || "npm";
}

async function enableCorepack(manager: string, cwd: string) {
  if (manager === "npm") return;
  await runCommand("corepack", ["enable"], cwd, 30000).catch(() => undefined);
}

async function enableSandboxCorepack(sandbox: Awaited<ReturnType<typeof Sandbox.create>>, manager: string, cwd: string) {
  if (manager === "npm") return;
  await sandbox.runCommand({
    cmd: "corepack",
    args: ["enable"],
    cwd,
    signal: AbortSignal.timeout(30000),
  }).catch(() => undefined);
}

async function runInstall(manager: string, cwd: string) {
  if (manager === "pnpm") {
    return runCommand("corepack", ["pnpm", "install", "--no-frozen-lockfile", "--ignore-scripts"], cwd, LOCAL_INSTALL_TIMEOUT_MS);
  }
  if (manager === "yarn") return runCommand("corepack", ["yarn", "install", "--ignore-scripts"], cwd, LOCAL_INSTALL_TIMEOUT_MS);
  return runCommand("npm", ["install", "--ignore-scripts"], cwd, LOCAL_INSTALL_TIMEOUT_MS);
}

async function runSandboxInstall(sandbox: Awaited<ReturnType<typeof Sandbox.create>>, manager: string, cwd: string) {
  const command =
    manager === "pnpm"
      ? { cmd: "corepack", args: ["pnpm", "install", "--no-frozen-lockfile"] }
      : manager === "yarn"
        ? { cmd: "corepack", args: ["yarn", "install"] }
        : { cmd: "npm", args: ["install", "--no-audit", "--no-fund"] };
  const result = await sandbox.runCommand({
    ...command,
    cwd,
    env: sandboxBaseEnv(sandboxPort(0)),
    signal: AbortSignal.timeout(LOCAL_INSTALL_TIMEOUT_MS),
  });
  await ensureSandboxExit(result, `${installLabel(manager)} in sandbox`);
}

function startApp(manager: string, script: string, cwd: string, port: number) {
  const command = manager === "npm" ? "npm" : "corepack";
  const args = manager === "npm" ? ["run", script] : [manager, "run", script];
  return spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...localRunnerEnv(),
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

async function startSandboxApp(
  sandbox: Awaited<ReturnType<typeof Sandbox.create>>,
  manager: string,
  script: string,
  cwd: string,
  port: number,
) {
  const command = manager === "npm" ? "npm" : "corepack";
  const args = manager === "npm" ? ["run", script] : [manager, "run", script];
  await sandbox.runCommand({
    cmd: command,
    args,
    cwd,
    detached: true,
    env: sandboxBaseEnv(port),
    signal: AbortSignal.timeout(30000),
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

async function readSandboxPackageJson(sandbox: Awaited<ReturnType<typeof Sandbox.create>>, cwd: string) {
  const file = await sandbox.readFileToBuffer({ path: "package.json", cwd }, { signal: AbortSignal.timeout(30000) });
  if (!file) throw new Error("No package.json found at the repository root.");
  return JSON.parse(file.toString("utf8")) as { scripts?: Record<string, string> };
}

async function ensureSandboxExit(result: { exitCode: number | null; stderr(): Promise<string>; stdout(): Promise<string> }, label: string) {
  if (result.exitCode === 0) return;
  const output = `${await result.stdout().catch(() => "")}\n${await result.stderr().catch(() => "")}`.trim();
  throw new Error(`${label} failed. ${redact(output.slice(-900))}`);
}

function sandboxBaseEnv(port: number) {
  return {
    BROWSER: "none",
    CI: "1",
    HOST: "0.0.0.0",
    HOSTNAME: "0.0.0.0",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "development",
    PORT: String(port),
    VITE_HOST: "0.0.0.0",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}

function sandboxPort(preferred: number) {
  if (preferred >= 1024 && preferred <= 65535) return preferred;
  return Number(process.env.DEMOMASTER_SANDBOX_PORT || 3000);
}

async function runCommand(command: string, args: string[], cwd: string, timeoutMs: number) {
  const child = spawn(command, args, { cwd, env: localRunnerEnv(), stdio: ["ignore", "pipe", "pipe"] });
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
  return `https://github.com/${owner}/${repo}.git`;
}

function redact(value: string) {
  return value
    .replace(/x-access-token:[^@\s]+@github\.com/gi, "x-access-token:[redacted]@github.com")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
}

function localRunnerGate(owner: string, repo: string) {
  if (process.env.DEMOMASTER_ENABLE_LOCAL_RUNNER !== LOCAL_RUNNER_ENABLE_FLAG) {
    return {
      allowed: false,
      message: "Local runner is disabled by default. Set DEMOMASTER_ENABLE_LOCAL_RUNNER=1 and allowlist trusted repositories before running repository code.",
    };
  }

  const repoKey = `${owner}/${repo}`.toLowerCase();
  const allowedRepos = parseList(process.env.DEMOMASTER_LOCAL_RUNNER_ALLOWED_REPOS);
  if (!allowedRepos.has(repoKey)) {
    return {
      allowed: false,
      message: `Local runner refused ${owner}/${repo}; add it to DEMOMASTER_LOCAL_RUNNER_ALLOWED_REPOS only after trust review.`,
    };
  }

  return { allowed: true, message: "Local runner enabled for an allowlisted repository." };
}

function parseList(value: string | undefined) {
  return new Set(
    (value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function localRunnerEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME || tmpdir(),
    TMPDIR: process.env.TMPDIR || tmpdir(),
    NODE_ENV: process.env.NODE_ENV || "production",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
  };
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
