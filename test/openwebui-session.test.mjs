import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-openwebui-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");

const {
  canonicalOpenWebUiBase,
  fetchOpenWebUi,
  openWebUiApiUrl,
  removeOpenWebUiSession,
  saveOpenWebUiSession,
  tokenCookie,
} = await import("../src/openwebui-session.mjs");
const { OPENWEBUI_ORIGIN_PATH } = await import("../src/paths.mjs");
const { primaryCredentialPath } = await import("../src/provider-credentials.mjs");
const { PROVIDERS } = await import("../src/model-registry.mjs");
const { userModelIdentity } = await import("../src/user-models.mjs");

const token = "header.eyJleHAiOjQxMDI0NDQ4MDB9.signature";

test("Open WebUI origins are canonical, prefix-safe, and reject unsafe forms", () => {
  assert.equal(canonicalOpenWebUiBase("https://chat.example.com/api/chat/completions"), "https://chat.example.com");
  assert.equal(canonicalOpenWebUiBase("https://chat.example.com/openai/responses"), "https://chat.example.com");
  assert.equal(canonicalOpenWebUiBase("https://chat.example.com/webui/api"), "https://chat.example.com/webui");
  assert.equal(openWebUiApiUrl("https://chat.example.com/webui", "api/models").toString(), "https://chat.example.com/webui/api/models");
  assert.equal(canonicalOpenWebUiBase("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => canonicalOpenWebUiBase("http://chat.example.com"), /requires HTTPS/);
  assert.throws(() => canonicalOpenWebUiBase("https://user:pass@chat.example.com"), /cannot contain credentials/);
  assert.throws(() => canonicalOpenWebUiBase("https://chat.example.com/?x=1"), /cannot contain credentials/);
});

test("Open WebUI session saves only origin plus protected token and matches token cookie", () => {
  try {
    assert.equal(tokenCookie([{ name: "oauth_id_token", value: token, domain: "chat.example.com" }], "https://chat.example.com"), undefined);
    assert.equal(tokenCookie([{ name: "token", value: token, domain: ".chat.example.com" }], "https://chat.example.com"), token);
    assert.equal(tokenCookie([{ name: "token", value: token, domain: "evilchat.example.com" }], "https://chat.example.com"), undefined);
    saveOpenWebUiSession({ baseUrl: "https://chat.example.com", token });
    const secretPath = primaryCredentialPath(PROVIDERS.get("openwebui"));
    if (process.platform !== "win32") {
      assert.equal(statSync(secretPath).mode & 0o777, 0o600);
      assert.equal(statSync(OPENWEBUI_ORIGIN_PATH).mode & 0o777, 0o600);
    }
    assert.equal(removeOpenWebUiSession(), 2);
  } finally {
    removeOpenWebUiSession();
  }
});

test("Open WebUI credentials never follow a cross-origin redirect", async () => {
  let calls = 0;
  await assert.rejects(
    fetchOpenWebUi("https://chat.example.com", token, "api/models", {
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/models" } });
      },
    }),
    /another origin/,
  );
  assert.equal(calls, 1);
});

test("Open WebUI opaque model ids remain exact and have collision-safe gateway ids", () => {
  const ids = ["team/model", "vendor:model.v2", "model with spaces", "模型/ß?x=y&z#q"];
  const identities = ids.map((upstreamId) => userModelIdentity({ providerId: "openwebui", upstreamId }));
  assert.deepEqual(identities.map(({ slug }) => slug), ids.map((id) => `openwebui/${id}`));
  assert.equal(new Set(identities.map(({ gatewayModel }) => gatewayModel)).size, ids.length);
  for (const identity of identities) assert.match(identity.gatewayModel, /^openwebui--[A-Za-z0-9_-]+$/);
});

test.after(() => rmSync(testRoot, { recursive: true, force: true }));
