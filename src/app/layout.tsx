import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const hydrationFallbackScript = String.raw`
(() => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const line = (text) => {
    const output = document.querySelector("[data-demomaster-output]");
    if (!output) return;
    let panel = document.querySelector("[data-demomaster-fallback-panel]");
    if (!panel) {
      panel = document.createElement("section");
      panel.className = "panel";
      panel.setAttribute("data-demomaster-fallback-panel", "true");
      panel.innerHTML = "<div class='panel-heading'><h2>Demo director</h2></div><div data-demomaster-fallback-log class='transcript'></div>";
      output.prepend(panel);
    }
    const log = panel.querySelector("[data-demomaster-fallback-log]");
    const item = document.createElement("p");
    item.textContent = text;
    log.appendChild(item);
  };

  function renderResult(result) {
    const output = document.querySelector("[data-demomaster-output]");
    if (!output) return;
    const capture = result.capture;
    const pitch = result.pitch;
    output.innerHTML = "";
    const section = document.createElement("section");
    section.className = "stage";
    section.innerHTML = [
      capture?.videoUrl ? "<video src='" + capture.videoUrl + "' controls muted playsinline style='width:100%;aspect-ratio:16/9;background:#111827;border-radius:8px'></video>" : "",
      "<div class='button-row'>",
      capture?.videoUrl ? "<a class='btn' target='_blank' rel='noreferrer' href='" + capture.videoUrl + "'>Raw capture video</a>" : "",
      "</div>",
      "<section class='panel'><div class='panel-heading'><h2>Demo flow</h2></div><p class='transcript'>" + escapeHtml((pitch?.scenes || []).map((scene) => scene.title).join(" -> ")) + "</p></section>",
    ].join("");
    output.appendChild(section);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  async function runFallback() {
    if (document.documentElement.dataset.demomasterNativeRunning === "true") return;
    document.documentElement.dataset.demomasterNativeRunning = "true";
    const input = document.querySelector("[data-demomaster-repo-input]");
    const button = document.querySelector("[data-demomaster-generate]");
    const appUrl = input?.value?.trim();
    if (!appUrl) {
      line("Live app URL is required.");
      document.documentElement.dataset.demomasterNativeRunning = "false";
      return;
    }
    if (button) button.setAttribute("disabled", "true");
    try {
      line("React hydration did not attach in time, so native fallback is running the same API flow.");
      line("Scouting the app, recording a browser flow, and generating narration.");
      const directorResponse = await fetch("/api/demo-director/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appUrl }),
      });
      if (!directorResponse.ok || !directorResponse.body) throw new Error("Demo generation failed.");
      const reader = directorResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult = null;
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const raw of lines) {
          if (!raw.trim()) continue;
          const event = JSON.parse(raw);
          if (event.type === "status") line(event.message);
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "complete") finalResult = event.response;
        }
        if (done) break;
      }
      if (!finalResult) throw new Error("Generation ended before a demo plan was returned.");
      line("Done. Showing captured demo.");
      renderResult(finalResult);
    } catch (error) {
      line(error?.message || "Generation failed.");
    } finally {
      if (button) button.removeAttribute("disabled");
      document.documentElement.dataset.demomasterNativeRunning = "false";
    }
  }

  async function installFallback() {
    await wait(2000);
    if (document.documentElement.dataset.demomasterHydrated === "true") return;
    const button = document.querySelector("[data-demomaster-generate]");
    if (!button) return;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runFallback();
    }, true);
    const form = button.closest("form");
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      runFallback();
    }, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installFallback, { once: true });
  } else {
    installFallback();
  }
})();
`;

export const metadata: Metadata = {
  title: "DemoMaster",
  description: "Generate narrated demo videos from live app URLs.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: hydrationFallbackScript }} />
      </body>
    </html>
  );
}
