import { parseGitHubUrl } from "@/lib/repo-context";
import type { AgentLog, DemoCapturePlan, DemoCaptureResult } from "@/lib/types";

const VULTR_API_BASE = "https://api.vultr.com/v2";
const STATUS_PORT = 8090;

interface VultrInstance {
  id: string;
  label?: string;
  status?: string;
  power_status?: string;
  server_status?: string;
  main_ip?: string;
}

interface RunnerStatus {
  status?: DemoCaptureResult["status"] | "booting" | "installing" | "starting" | "capturing";
  message?: string;
  appUrl?: string;
  screenshot?: string;
  video?: string;
  updatedAt?: string;
}

export async function startVultrRunner(repoUrl: string, capturePlan: DemoCapturePlan): Promise<{
  capture: DemoCaptureResult;
  agentLog: AgentLog;
}> {
  const apiKey = process.env.VULTR_API_KEY;
  if (!apiKey) return skipped("VULTR_API_KEY is not configured.");
  if (process.env.VULTR_ENABLE_PROVISIONING !== "true") {
    return skipped("Set VULTR_ENABLE_PROVISIONING=true to allow DemoMaster to create a paid Vultr instance.");
  }

  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) return skipped("Vultr runner currently accepts GitHub repository URLs only.");

  const region = process.env.VULTR_REGION || "ams";
  const plan = process.env.VULTR_PLAN || "vc2-1c-2gb";
  const osId = Number(process.env.VULTR_OS_ID || 1743);
  const label = `demomaster-${parsed.owner}-${parsed.repo}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);

  const cloneUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
  const userData = Buffer.from(buildCloudInit(cloneUrl, capturePlan, parsed.branch), "utf8").toString("base64");
  const payload = await vultrFetch<{ instance: VultrInstance }>(apiKey, "/instances", {
    method: "POST",
    body: JSON.stringify({
      region,
      plan,
      os_id: osId,
      label,
      hostname: label,
      tags: ["demomaster", "capture-runner"],
      user_data: userData,
      backups: "disabled",
      activation_email: false,
    }),
  });

  const capture = captureFromInstance(payload.instance, capturePlan, {
    status: "running",
    message: "Vultr instance created. Cloud-init is cloning, installing, running, and capturing the repository.",
  });

  return {
    capture,
    agentLog: {
      agent: "Demo Capture Agent",
      provider: "browser",
      entries: capture.logs,
    },
  };
}

export async function getVultrRunnerStatus(instanceId: string, port = 3000): Promise<{
  capture: DemoCaptureResult;
  agentLog: AgentLog;
}> {
  const apiKey = process.env.VULTR_API_KEY;
  if (!apiKey) return skipped("VULTR_API_KEY is not configured.");
  if (!instanceId) return skipped("A Vultr instance id is required.");

  const payload = await vultrFetch<{ instance: VultrInstance }>(apiKey, `/instances/${encodeURIComponent(instanceId)}`);
  const instance = payload.instance;
  const ip = instance.main_ip;
  let runnerStatus: RunnerStatus | undefined;

  if (ip) {
    runnerStatus = await fetchRunnerStatus(ip);
  }

  const status = normalizeRunnerStatus(runnerStatus?.status, instance);
  const message =
    runnerStatus?.message ||
    (ip ? "Vultr instance is reachable; waiting for runner status." : "Vultr instance is still assigning a public IP.");
  const baseUrl = ip ? `http://${ip}:${STATUS_PORT}` : undefined;
  const capture: DemoCaptureResult = {
    status,
    provider: "vultr",
    instanceId: instance.id,
    targetUrl: ip ? runnerStatus?.appUrl || `http://${ip}:${port}` : undefined,
    statusUrl: baseUrl ? `${baseUrl}/status.json` : undefined,
    screenshotUrl: baseUrl && status === "ready" ? `${baseUrl}/${runnerStatus?.screenshot || "capture.png"}` : undefined,
    videoUrl: baseUrl && status === "ready" ? `${baseUrl}/${runnerStatus?.video || "capture.webm"}` : undefined,
    message,
    logs: [
      {
        step: "Check Vultr instance",
        status: ip ? "done" : "running",
        message: `Instance ${instance.id} is ${instance.status || "unknown"} / ${instance.server_status || "unknown"}.`,
      },
      {
        step: "Read runner status",
        status: status === "ready" ? "done" : status === "error" ? "error" : "running",
        message,
      },
    ],
  };

  return {
    capture,
    agentLog: {
      agent: "Demo Capture Agent",
      provider: "browser",
      entries: capture.logs,
    },
  };
}

export async function destroyVultrRunner(instanceId: string): Promise<{
  capture: DemoCaptureResult;
  agentLog: AgentLog;
}> {
  const apiKey = process.env.VULTR_API_KEY;
  if (!apiKey) return skipped("VULTR_API_KEY is not configured.");
  if (!instanceId) return skipped("A Vultr instance id is required.");

  await vultrFetch(apiKey, `/instances/${encodeURIComponent(instanceId)}`, { method: "DELETE" });
  const capture: DemoCaptureResult = {
    status: "destroyed",
    provider: "vultr",
    instanceId,
    message: "Vultr capture runner destroyed.",
    logs: [{ step: "Destroy Vultr runner", status: "done", message: `Destroyed instance ${instanceId}.` }],
  };
  return {
    capture,
    agentLog: {
      agent: "Demo Capture Agent",
      provider: "browser",
      entries: capture.logs,
    },
  };
}

function skipped(message: string): { capture: DemoCaptureResult; agentLog: AgentLog } {
  const capture: DemoCaptureResult = {
    status: "skipped",
    provider: "vultr",
    message,
    logs: [{ step: "Check Vultr runner", status: "skipped", message }],
  };
  return {
    capture,
    agentLog: {
      agent: "Demo Capture Agent",
      provider: "browser",
      entries: capture.logs,
    },
  };
}

function captureFromInstance(
  instance: VultrInstance,
  plan: DemoCapturePlan,
  initial: Pick<DemoCaptureResult, "status" | "message">,
): DemoCaptureResult {
  const ip = instance.main_ip;
  return {
    status: initial.status,
    provider: "vultr",
    instanceId: instance.id,
    targetUrl: ip ? `http://${ip}:${plan.port}` : undefined,
    statusUrl: ip ? `http://${ip}:${STATUS_PORT}/status.json` : undefined,
    message: initial.message,
    logs: [
      {
        step: "Create Vultr instance",
        status: "done",
        message: `Created instance ${instance.id}.`,
      },
      {
        step: "Run cloud-init capture agent",
        status: "running",
        message: "Installing dependencies, launching the repo, and preparing Playwright capture on the VM.",
      },
    ],
  };
}

async function vultrFetch<T = unknown>(
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${VULTR_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });

  if (response.status === 204) return {} as T;
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload as T;
}

async function fetchRunnerStatus(ip: string): Promise<RunnerStatus | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(`http://${ip}:${STATUS_PORT}/status.json`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return (await response.json()) as RunnerStatus;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRunnerStatus(status: RunnerStatus["status"], instance: VultrInstance): DemoCaptureResult["status"] {
  if (status === "ready" || status === "error") return status;
  if (instance.status === "active" || instance.power_status === "running") return "running";
  return "running";
}

function buildCloudInit(repoUrl: string, plan: DemoCapturePlan, branch?: string) {
  const homepage = plan.targetUrl || "";
  const port = String(plan.port || 3000);
  const branchArg = branch ? `--branch ${shellQuote(branch)} ` : "";

  return `#cloud-config
package_update: true
write_files:
  - path: /opt/demomaster/repo-url
    permissions: "0644"
    content: ${JSON.stringify(repoUrl)}
  - path: /opt/demomaster/homepage-url
    permissions: "0644"
    content: ${JSON.stringify(homepage)}
  - path: /opt/demomaster/app-port
    permissions: "0644"
    content: ${JSON.stringify(port)}
  - path: /opt/demomaster/bootstrap.sh
    permissions: "0755"
    content: |
      #!/usr/bin/env bash
      set -u
      ROOT=/opt/demomaster
      PUBLIC=$ROOT/public
      mkdir -p "$PUBLIC/videos"
      cat > "$ROOT/status-server.py" <<'PY'
      from functools import partial
      from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
      import sys

      class Handler(SimpleHTTPRequestHandler):
        def end_headers(self):
          self.send_header("Access-Control-Allow-Origin", "*")
          self.send_header("Cache-Control", "no-store")
          super().end_headers()

      directory = sys.argv[1]
      ThreadingHTTPServer(("0.0.0.0", ${STATUS_PORT}), partial(Handler, directory=directory)).serve_forever()
      PY
      status() {
        local state="$1"
        local message="$2"
        cat > "$PUBLIC/status.json" <<JSON
      {"status":"$state","message":"$message","appUrl":"http://$(hostname -I | awk '{print $1}'):${port}","screenshot":"capture.png","video":"capture.webm","updatedAt":"$(date -Iseconds)"}
      JSON
      }
      status booting "Booting Vultr capture runner."
      cd "$PUBLIC"
      python3 "$ROOT/status-server.py" "$PUBLIC" > "$ROOT/status-server.log" 2>&1 &
      status installing "Installing system, Node.js, Git, and Playwright dependencies."
      export DEBIAN_FRONTEND=noninteractive
      apt-get update >> "$ROOT/bootstrap.log" 2>&1
      apt-get install -y ca-certificates curl git python3 >> "$ROOT/bootstrap.log" 2>&1
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >> "$ROOT/bootstrap.log" 2>&1
      apt-get install -y nodejs >> "$ROOT/bootstrap.log" 2>&1
      corepack enable >> "$ROOT/bootstrap.log" 2>&1 || true
      cd "$ROOT"
      git clone --depth=1 ${branchArg}"$(cat "$ROOT/repo-url")" app >> "$ROOT/bootstrap.log" 2>&1 || {
        status error "Git clone failed. Check repository visibility."
        exit 0
      }
      cd "$ROOT/app"
      status installing "Installing repository dependencies."
      if [ -f pnpm-lock.yaml ]; then
        corepack prepare pnpm@latest --activate >> "$ROOT/bootstrap.log" 2>&1 || true
        pnpm install --no-frozen-lockfile >> "$ROOT/install.log" 2>&1 || { status error "pnpm install failed."; exit 0; }
      elif [ -f yarn.lock ]; then
        corepack prepare yarn@stable --activate >> "$ROOT/bootstrap.log" 2>&1 || true
        yarn install >> "$ROOT/install.log" 2>&1 || { status error "yarn install failed."; exit 0; }
      else
        npm install >> "$ROOT/install.log" 2>&1 || { status error "npm install failed."; exit 0; }
      fi
      cat > "$ROOT/run-app.mjs" <<'NODE'
      import fs from "node:fs";
      import { spawn } from "node:child_process";
      const root = "/opt/demomaster";
      const app = root + "/app";
      const pkg = JSON.parse(fs.readFileSync(app + "/package.json", "utf8"));
      const has = (name) => Boolean(pkg.scripts?.[name]);
      const manager = fs.existsSync(app + "/pnpm-lock.yaml") ? "pnpm" : fs.existsSync(app + "/yarn.lock") ? "yarn" : "npm";
      const script = has("dev") ? "dev" : has("start") ? "start" : null;
      if (!script) throw new Error("No dev or start script found.");
      const candidates = [
        ["run", script, "--", "--hostname", "0.0.0.0"],
        ["run", script, "--", "--host", "0.0.0.0"],
        ["run", script],
      ];
      for (const args of candidates) {
        const out = fs.openSync(root + "/app.log", "a");
        const child = spawn(manager, args, {
          cwd: app,
          detached: true,
          stdio: ["ignore", out, out],
          env: { ...process.env, PORT: "${port}", HOST: "0.0.0.0", NEXT_TELEMETRY_DISABLED: "1" },
        });
        await new Promise((resolve) => setTimeout(resolve, 9000));
        if (child.exitCode === null) {
          fs.writeFileSync(root + "/app.pid", String(child.pid));
          child.unref();
          process.exit(0);
        }
      }
      throw new Error("App exited for every launch strategy.");
      NODE
      status starting "Starting repository application."
      node "$ROOT/run-app.mjs" >> "$ROOT/bootstrap.log" 2>&1 || {
        if [ -n "$(cat "$ROOT/homepage-url")" ]; then
          status starting "Repo launch failed; falling back to homepage capture target."
        else
          status error "Repository launch failed. See app.log on the VM."
          exit 0
        fi
      }
      status capturing "Installing Playwright and capturing browser footage."
      cd "$ROOT"
      npm init -y >> "$ROOT/bootstrap.log" 2>&1
      npm install playwright >> "$ROOT/bootstrap.log" 2>&1
      npx playwright install --with-deps chromium >> "$ROOT/bootstrap.log" 2>&1
      cat > "$ROOT/capture.mjs" <<'NODE'
      import fs from "node:fs";
      import { chromium } from "playwright";
      const root = "/opt/demomaster";
      const publicDir = root + "/public";
      const port = fs.readFileSync(root + "/app-port", "utf8").trim() || "${port}";
      const ip = (await import("node:os")).networkInterfaces();
      const target = "http://127.0.0.1:" + port;
      const homepage = fs.readFileSync(root + "/homepage-url", "utf8").trim();
      const status = (state, message, url = target) => {
        fs.writeFileSync(publicDir + "/status.json", JSON.stringify({
          status: state,
          message,
          appUrl: url.replace("127.0.0.1", Object.values(ip).flat().find((item) => item?.family === "IPv4" && !item.internal)?.address || "127.0.0.1"),
          screenshot: "capture.png",
          video: "capture.webm",
          updatedAt: new Date().toISOString(),
        }));
      };
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        recordVideo: { dir: publicDir + "/videos", size: { width: 1280, height: 720 } },
      });
      const page = await context.newPage();
      let usedUrl = target;
      try {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
      } catch (error) {
        if (!homepage) throw error;
        usedUrl = homepage;
        await page.goto(homepage, { waitUntil: "domcontentloaded", timeout: 60000 });
      }
      await page.waitForTimeout(2500);
      await page.screenshot({ path: publicDir + "/capture.png", fullPage: false });
      await page.mouse.move(240, 260);
      await page.waitForTimeout(1200);
      await page.mouse.wheel(0, 420).catch(() => {});
      await page.waitForTimeout(1500);
      await page.close();
      await context.close();
      await browser.close();
      const videos = fs.readdirSync(publicDir + "/videos").filter((name) => name.endsWith(".webm"));
      if (videos[0]) fs.copyFileSync(publicDir + "/videos/" + videos[0], publicDir + "/capture.webm");
      status("ready", usedUrl === target ? "Captured the repository running on Vultr." : "Captured the public homepage fallback because the repo did not launch locally.", usedUrl);
      NODE
      node "$ROOT/capture.mjs" >> "$ROOT/capture.log" 2>&1 || {
        status error "Playwright capture failed. Check capture.log on the VM."
        exit 0
      }
runcmd:
  - [ bash, /opt/demomaster/bootstrap.sh ]
`;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
