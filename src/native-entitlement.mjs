import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { codexVersion, runCodex } from "./codex-binary.mjs";
import { nativeAccountFingerprint } from "./codex-native-session.mjs";
import { writePrivateJson } from "./file-security.mjs";
import { NATIVE_CATALOG_PATH, NATIVE_ENTITLEMENT_PATH } from "./paths.mjs";

// Which native models the signed-in ChatGPT account will actually serve.
//
// Neither native catalog source answers this. The bundled catalog is the
// binary's whole roster, and the account cache (`models_cache.json`) is only as
// fresh as the last Codex build that wrote it -- on one machine it was months
// old, listed a model the plan now refuses, and omitted three it serves. The
// only trustworthy answer is to ask: one minimal turn per model, through Codex
// itself with the user's config ignored, so the request reaches ChatGPT
// directly and never passes through this router.
//
// Only an explicit plan refusal marks a model unsupported. A timeout, a 5xx,
// or a network failure says nothing about entitlement, so those models are
// recorded as "unknown" and keep whatever visibility Codex gave them.
//
// The record is bound to the account and the Codex build that produced it. A
// different account, a sign-out, or a Codex update makes it inapplicable, so a
// plan upgrade can never leave a working model hidden indefinitely.

const PLAN_REFUSAL =
  /not supported when using Codex with a ChatGPT account|isn.t supported with the current ChatGPT account/i;

export function classifyProbe({ status, output }) {
  const text = String(output || "");
  if (PLAN_REFUSAL.test(text)) return "unsupported";
  if (status === 0) return "supported";
  return "unknown";
}

function readJson(target) {
  if (!existsSync(target)) return undefined;
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return undefined;
  }
}

export function readNativeEntitlement() {
  const parsed = readJson(NATIVE_ENTITLEMENT_PATH);
  return parsed?.version === 1 && parsed.results && typeof parsed.results === "object"
    ? parsed
    : undefined;
}

// Why a record does or does not apply to the current session. Pure, so the
// binding rules are testable without a Codex install.
export function entitlementApplicability(record, { account, codex } = {}) {
  if (!record) return { applies: false, reason: "not-probed" };
  if (!account) return { applies: false, reason: "no-account" };
  if (record.account !== account) return { applies: false, reason: "account-changed" };
  if (codex && record.codex && record.codex !== codex) {
    return { applies: false, reason: "codex-changed" };
  }
  return { applies: true, reason: "current" };
}

export function unsupportedSlugs(record) {
  return Object.entries(record?.results || {})
    .filter(([, value]) => value?.outcome === "unsupported")
    .map(([slug]) => slug);
}

// The set the catalog hides. Empty whenever the record cannot be trusted for
// this session, which leaves Codex's own visibility in force.
export function nativeEntitlementHidden({
  record = readNativeEntitlement(),
  account = nativeAccountFingerprint(),
  codex = codexVersion(),
} = {}) {
  if (!entitlementApplicability(record, { account, codex }).applies) return new Set();
  return new Set(unsupportedSlugs(record));
}

// Listed native base models, i.e. what the picker would offer. Hidden entries
// and the router's own context variants are not separate entitlements.
export function probeCandidates(models) {
  return (Array.isArray(models) ? models : [])
    .filter((model) => model?.visibility === "list" && typeof model.slug === "string")
    .map((model) => model.slug);
}

function probeModel(slug, { cwd, timeoutMs }) {
  try {
    const output = runCodex(
      [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--model",
        slug,
        "--cd",
        cwd,
        "Reply with exactly: OK",
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return { status: 0, output };
  } catch (error) {
    return {
      status: typeof error?.status === "number" ? error.status : null,
      output: `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`,
    };
  }
}

export function probeNativeEntitlement({ slugs, timeoutMs = 120_000, log = () => {} } = {}) {
  const account = nativeAccountFingerprint();
  if (!account) {
    throw new Error("Codex is not signed in with a ChatGPT account; there is no plan to probe.");
  }
  const candidates = slugs?.length ? slugs : probeCandidates(readJson(NATIVE_CATALOG_PATH)?.models);
  if (!candidates.length) {
    throw new Error("No native models to probe. Run bin/refresh-catalog first.");
  }
  const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-router-entitlement-"));
  const results = {};
  try {
    for (const slug of candidates) {
      const outcome = classifyProbe(probeModel(slug, { cwd, timeoutMs }));
      results[slug] = { outcome };
      log(slug, outcome);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  // A slug probed earlier and absent from this run keeps its old result, so a
  // targeted re-probe of one model does not forget the others.
  const previous = readNativeEntitlement();
  const carried = entitlementApplicability(previous, { account, codex: codexVersion() }).applies
    ? previous.results
    : {};
  const record = {
    version: 1,
    account,
    codex: codexVersion() || null,
    probed_at: new Date().toISOString(),
    results: { ...carried, ...results },
  };
  writePrivateJson(NATIVE_ENTITLEMENT_PATH, record);
  return record;
}

export function clearNativeEntitlement() {
  rmSync(NATIVE_ENTITLEMENT_PATH, { force: true });
}

export function nativeEntitlementStatus() {
  const record = readNativeEntitlement();
  const applicability = entitlementApplicability(record, {
    account: nativeAccountFingerprint(),
    codex: codexVersion(),
  });
  return {
    ...applicability,
    probedAt: record?.probed_at,
    results: record?.results || {},
  };
}

function usage() {
  return "Usage: native-models [status|probe [SLUG...]|clear]";
}

async function main() {
  const [command = "status", ...rest] = process.argv.slice(2);
  const { refreshTargetPickerIfInstalled, targetRestartHint } = await import("./target-integration.mjs");
  if (command === "status") {
    const status = nativeEntitlementStatus();
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }
    if (!Object.keys(status.results).length) {
      process.stdout.write("Native models have not been probed. Run `native-models probe`.\n");
      return;
    }
    process.stdout.write(
      `Probed ${status.probedAt} (${status.applies ? "applied" : `not applied: ${status.reason}`}).\n`,
    );
    for (const [slug, value] of Object.entries(status.results)) {
      process.stdout.write(`${String(value.outcome).padEnd(12)} ${slug}\n`);
    }
    return;
  }
  if (command === "probe") {
    process.stdout.write(
      "Sending one minimal turn per native model through your ChatGPT sign-in (uses a little quota).\n",
    );
    const record = probeNativeEntitlement({
      slugs: rest.filter((arg) => !arg.startsWith("-")),
      log: (slug, outcome) => process.stdout.write(`${outcome.padEnd(12)} ${slug}\n`),
    });
    const hidden = unsupportedSlugs(record);
    const refreshed = refreshTargetPickerIfInstalled();
    process.stdout.write(
      `${hidden.length} native model(s) your plan refuses are now hidden${hidden.length ? `: ${hidden.join(", ")}` : ""}.` +
        `${refreshed ? ` ${targetRestartHint()}` : ""}\n`,
    );
    return;
  }
  if (command === "clear") {
    clearNativeEntitlement();
    const refreshed = refreshTargetPickerIfInstalled();
    process.stdout.write(
      `Native entitlement record removed; Codex's own visibility applies again.${refreshed ? ` ${targetRestartHint()}` : ""}\n`,
    );
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
