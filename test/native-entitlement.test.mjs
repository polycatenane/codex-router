import assert from "node:assert/strict";
import test from "node:test";

import { withNativeEntitlement } from "../src/catalog.mjs";
import {
  classifyProbe,
  entitlementApplicability,
  nativeEntitlementHidden,
  probeCandidates,
  unsupportedSlugs,
} from "../src/native-entitlement.mjs";

const record = {
  version: 1,
  account: "acct-a",
  codex: "codex-cli 0.169.0",
  results: {
    "gpt-6.1-sol": { outcome: "unsupported" },
    "gpt-6-luna": { outcome: "supported" },
    "gpt-5.6-sol": { outcome: "unknown" },
  },
};

test("only an explicit plan refusal marks a model unsupported", () => {
  assert.equal(
    classifyProbe({
      status: 1,
      output: "ERROR: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
    }),
    "unsupported",
  );
  assert.equal(classifyProbe({ status: 0, output: "OK" }), "supported");
  // A timeout or a server error is not evidence about the plan.
  assert.equal(classifyProbe({ status: null, output: "ETIMEDOUT" }), "unknown");
  assert.equal(classifyProbe({ status: 1, output: "502 Bad Gateway" }), "unknown");
});

test("a record applies only to the account and Codex build that produced it", () => {
  const current = { account: "acct-a", codex: "codex-cli 0.169.0" };
  assert.deepEqual(entitlementApplicability(record, current), { applies: true, reason: "current" });
  assert.equal(entitlementApplicability(undefined, current).reason, "not-probed");
  assert.equal(entitlementApplicability(record, { ...current, account: undefined }).reason, "no-account");
  assert.equal(entitlementApplicability(record, { ...current, account: "acct-b" }).reason, "account-changed");
  assert.equal(
    entitlementApplicability(record, { ...current, codex: "codex-cli 0.170.0" }).reason,
    "codex-changed",
  );
  // An unknown current version cannot prove a mismatch.
  assert.equal(entitlementApplicability(record, { ...current, codex: undefined }).applies, true);
});

test("the hidden set is the refusals, and empty when the record does not apply", () => {
  assert.deepEqual(unsupportedSlugs(record), ["gpt-6.1-sol"]);
  assert.deepEqual(
    [...nativeEntitlementHidden({ record, account: "acct-a", codex: "codex-cli 0.169.0" })],
    ["gpt-6.1-sol"],
  );
  assert.equal(nativeEntitlementHidden({ record, account: "acct-b", codex: undefined }).size, 0);
  assert.equal(nativeEntitlementHidden({ record: undefined, account: "acct-a" }).size, 0);
});

test("only listed native models are probed", () => {
  assert.deepEqual(
    probeCandidates([
      { slug: "gpt-6-luna", visibility: "list" },
      { slug: "codex-auto-review", visibility: "hide" },
      { visibility: "list" },
    ]),
    ["gpt-6-luna"],
  );
});

test("refused models stay resolvable but leave the picker", () => {
  const catalog = {
    models: [
      { slug: "gpt-6.1-sol", visibility: "list" },
      { slug: "gpt-6-luna", visibility: "list" },
    ],
  };
  assert.equal(withNativeEntitlement(catalog, new Set()), catalog);
  assert.deepEqual(withNativeEntitlement(catalog, new Set(["gpt-6.1-sol"])).models, [
    { slug: "gpt-6.1-sol", visibility: "hide" },
    { slug: "gpt-6-luna", visibility: "list" },
  ]);
});
