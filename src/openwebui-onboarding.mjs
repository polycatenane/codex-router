import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { confirm, promptLine } from "./setup-shared.mjs";
import {
  canonicalOpenWebUiBase,
  fetchOpenWebUi,
  openWebUiApiUrl,
  openWebUiSessionStatus,
  saveOpenWebUiSession,
  tokenCookie,
  validateOpenWebUiSession,
} from "./openwebui-session.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGIN_TIMEOUT_MS = 10 * 60_000;

async function chromiumRuntime() {
  const { chromium } = await import("playwright");
  return chromium;
}

function installChromium() {
  const cli = path.join(SOURCE_ROOT, "node_modules", "playwright", "cli.js");
  if (!existsSync(cli)) {
    throw new Error("Playwright is not installed. Reinstall Codex Router, then run the Open WebUI login again.");
  }
  const result = spawnSync(process.execPath, [cli, "install", "chromium"], {
    cwd: SOURCE_ROOT,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error("Playwright Chromium could not be installed. Install its browser dependencies, then retry Open WebUI login.");
  }
}

async function readyChromium({ chromium, confirmDownload = confirm } = {}) {
  const runtime = chromium || await chromiumRuntime();
  if (existsSync(runtime.executablePath())) return runtime;
  if (!confirmDownload("Download Playwright Chromium now for the Open WebUI sign-in?")) {
    throw new Error("Open WebUI sign-in needs Playwright Chromium; no browser was downloaded.");
  }
  installChromium();
  if (!existsSync(runtime.executablePath())) {
    throw new Error("Playwright Chromium installation completed without a usable browser executable.");
  }
  return runtime;
}

async function waitForBrowserModels(page, baseUrl, { timeoutMs = LOGIN_TIMEOUT_MS, pollMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  while (Date.now() < deadline) {
    try {
      const status = await page.evaluate(async (modelsUrl) => {
        const response = await fetch(modelsUrl, { credentials: "include" });
        return response.status;
      }, openWebUiApiUrl(baseUrl, "api/models").toString());
      lastStatus = status;
      if (status >= 200 && status < 300) return;
      if (status === 403) throw new Error("Open WebUI signed in, but this user cannot access models.");
    } catch (error) {
      if (error instanceof Error && /cannot access models/i.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    lastStatus === undefined
      ? "Open WebUI sign-in timed out before model access was available."
      : `Open WebUI sign-in timed out waiting for model access (last HTTP ${lastStatus}).`,
  );
}

async function validateLoginToken(baseUrl, token, fetchImpl) {
  const response = await fetchOpenWebUi(baseUrl, token, "api/models", {
    fetchImpl,
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401) throw new Error("Open WebUI rejected the new session token. Complete sign-in again.");
  if (response.status === 403) throw new Error("Open WebUI signed in, but this user cannot access models.");
  if (!response.ok) throw new Error(`Open WebUI model validation failed with HTTP ${response.status}.`);
  await response.body?.cancel?.().catch(() => undefined);
}

export async function signInOpenWebUi({
  origin,
  allowInsecureHttp = false,
  chromium,
  fetchImpl = fetch,
  confirmDownload,
  waitForModels = waitForBrowserModels,
} = {}) {
  const saved = openWebUiSessionStatus();
  const baseUrl = origin === undefined || origin === null || origin === ""
    ? saved.baseUrl
    : canonicalOpenWebUiBase(origin, { allowInsecureHttp });
  if (!baseUrl) {
    throw new Error("Open WebUI URL is required. Pass it to `providers login openwebui` or run this command in a terminal.");
  }

  if (saved.configured && saved.baseUrl === baseUrl) {
    try {
      await validateOpenWebUiSession({ fetchImpl, headers: { Accept: "application/json" } });
      return { baseUrl, reused: true };
    } catch (error) {
      if (!new Set(["openwebui_session_missing", "openwebui_session_expired", "openwebui_session_rejected"]).has(error?.code)) {
        throw error;
      }
    }
  }

  const runtime = await readyChromium({ chromium, confirmDownload });
  let browser;
  let context;
  try {
    browser = await runtime.launch({ headless: false });
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    process.stdout.write("Complete Open WebUI sign-in in the browser window. Waiting for model access...\n");
    await waitForModels(page, baseUrl);
    const token = tokenCookie(await context.cookies(baseUrl), baseUrl);
    if (!token) throw new Error("Open WebUI sign-in completed without its token cookie. Do not use oauth_id_token; try signing in again.");
    await validateLoginToken(baseUrl, token, fetchImpl);
    saveOpenWebUiSession({ baseUrl, token, allowInsecureHttp });
    return { baseUrl, reused: false };
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

export function requestedOpenWebUiOrigin(value) {
  const supplied = typeof value === "string" ? value.trim() : "";
  if (supplied) return supplied;
  const saved = openWebUiSessionStatus();
  if (saved.baseUrl) return saved.baseUrl;
  if (!process.stdin.isTTY) {
    throw new Error("Open WebUI URL is required when this command is not attached to an interactive terminal.");
  }
  return promptLine("Open WebUI URL").trim();
}
