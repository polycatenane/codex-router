import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { OPENWEBUI_ORIGIN_PATH } from "./paths.mjs";
import {
  removeProviderCredential,
  resolveProviderCredential,
  writeProviderCredential,
} from "./provider-credentials.mjs";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TOKEN_COOKIE = "token";
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function loopbackHost(value) {
  const host = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") ||
    host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function endpointBase(baseUrl) {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  return base;
}

export function canonicalOpenWebUiBase(value, { allowInsecureHttp = false } = {}) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Open WebUI URL must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Open WebUI URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Open WebUI URL cannot contain credentials, a query string, or a fragment.");
  }
  if (url.protocol === "http:" && !loopbackHost(url.hostname) && !allowInsecureHttp) {
    throw new Error("Open WebUI requires HTTPS outside loopback; pass --allow-insecure-http only for unsafe development use.");
  }
  let pathname = url.pathname.replace(/\/+$/, "") || "/";
  for (const suffix of ["/api/v1/messages", "/api/chat/completions", "/api/models", "/api"]) {
    if (pathname === suffix || pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length) || "/";
      break;
    }
  }
  url.pathname = pathname === "/" ? "/" : pathname;
  return url.toString().replace(/\/$/, "");
}

export function openWebUiApiUrl(baseUrl, path) {
  const suffix = String(path || "").replace(/^\/+/, "");
  if (!suffix || suffix.includes("://") || suffix.startsWith("/")) {
    throw new Error("Open WebUI API path must be relative.");
  }
  return new URL(suffix, endpointBase(baseUrl));
}

function readOrigin() {
  if (!existsSync(OPENWEBUI_ORIGIN_PATH)) return undefined;
  try {
    const value = JSON.parse(readFileSync(OPENWEBUI_ORIGIN_PATH, "utf8"));
    if (value?.version !== 1 || typeof value.baseUrl !== "string") return undefined;
    return canonicalOpenWebUiBase(value.baseUrl, { allowInsecureHttp: true });
  } catch {
    return undefined;
  }
}

export function openWebUiSessionStatus() {
  const credential = resolveProviderCredential("openwebui");
  const baseUrl = readOrigin();
  return credential && baseUrl
    ? { configured: true, credential, baseUrl, source: "router-managed Open WebUI SSO session" }
    : { configured: false };
}

export function jwtExpiration(token) {
  if (!JWT.test(String(token || ""))) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return Number.isFinite(payload?.exp) ? payload.exp * 1_000 : undefined;
  } catch {
    return undefined;
  }
}

export function tokenCookie(cookies, baseUrl) {
  const origin = new URL(baseUrl);
  const matches = (Array.isArray(cookies) ? cookies : []).filter((cookie) => (
    cookie?.name === TOKEN_COOKIE &&
    typeof cookie.value === "string" &&
    JWT.test(cookie.value) &&
    (() => {
      const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
      const host = origin.hostname.toLowerCase();
      return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));
    })()
  ));
  return matches.at(-1)?.value;
}

export async function fetchOpenWebUi(baseUrl, token, apiPath, {
  fetchImpl = fetch,
  headers = {},
  maxRedirects = 3,
  ...init
} = {}) {
  const configuredOrigin = new URL(baseUrl).origin;
  let target = openWebUiApiUrl(baseUrl, apiPath);
  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    const response = await fetchImpl(target, {
      ...init,
      headers: { ...headers, Authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
    const location = response.headers?.get?.("location");
    if (!location) throw new Error("Open WebUI returned a redirect without a location.");
    const next = new URL(location, target);
    if (next.origin !== configuredOrigin) {
      throw new Error("Open WebUI redirected to another origin; configure the canonical Open WebUI URL.");
    }
    target = next;
  }
  throw new Error("Open WebUI redirected too many times.");
}

export async function validateOpenWebUiSession(options = {}) {
  const session = openWebUiSessionStatus();
  if (!session.configured) {
    const error = new Error("Open WebUI is not signed in; run `./bin/model-router codex providers login openwebui`.");
    error.code = "openwebui_session_missing";
    error.status = 503;
    throw error;
  }
  const expiry = jwtExpiration(session.credential.value);
  if (expiry !== undefined && expiry <= Date.now()) {
    const error = new Error("Open WebUI session appears expired; run `./bin/model-router codex providers login openwebui`.");
    error.code = "openwebui_session_expired";
    error.status = 401;
    throw error;
  }
  const response = await fetchOpenWebUi(session.baseUrl, session.credential.value, "api/models", options);
  if (response.status === 401) {
    const error = new Error("Open WebUI session was rejected; run `./bin/model-router codex providers login openwebui`.");
    error.code = "openwebui_session_rejected";
    error.status = 401;
    throw error;
  }
  if (response.status === 403) {
    const error = new Error("Open WebUI authenticated the session but this user cannot access models.");
    error.code = "openwebui_models_forbidden";
    error.status = 403;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`Open WebUI model validation failed with HTTP ${response.status}.`);
    error.code = "openwebui_models_failed";
    error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw error;
  }
  return { ...session, response };
}

export function saveOpenWebUiSession({ baseUrl, token, allowInsecureHttp = false }) {
  const canonical = canonicalOpenWebUiBase(baseUrl, { allowInsecureHttp });
  if (!JWT.test(String(token || ""))) throw new Error("Open WebUI did not provide a usable token cookie.");
  writePrivateJson(OPENWEBUI_ORIGIN_PATH, { version: 1, baseUrl: canonical });
  writeProviderCredential("openwebui", token);
  return canonical;
}

export function removeOpenWebUiSession() {
  const removedCredential = removeProviderCredential("openwebui");
  let removedOrigin = false;
  if (existsSync(OPENWEBUI_ORIGIN_PATH)) {
    unlinkSync(OPENWEBUI_ORIGIN_PATH);
    removedOrigin = true;
  }
  return removedCredential + (removedOrigin ? 1 : 0);
}
