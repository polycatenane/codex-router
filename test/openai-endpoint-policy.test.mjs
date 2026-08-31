import assert from "node:assert/strict";
import test from "node:test";

import {
  endpointCapabilityError,
  normalizeSupportedEndpoints,
  providerModelEndpoint,
  supportsOpenAIModelEndpoint,
} from "../src/openai-endpoint-policy.mjs";

test("endpoint declarations are closed, deduplicated, and model-scoped", () => {
  assert.deepEqual(
    normalizeSupportedEndpoints(["/chat/completions", "/embeddings", "/embeddings"]),
    ["/chat/completions", "/embeddings"],
  );
  assert.throws(() => normalizeSupportedEndpoints([]), /non-empty array/);
  assert.throws(() => normalizeSupportedEndpoints(["/audio/speech"]), /unsupported endpoint/);
  assert.equal(providerModelEndpoint({}), "/chat/completions");
  assert.equal(providerModelEndpoint({ protocol: "openai" }), "/chat/completions");
  assert.equal(providerModelEndpoint({ protocol: "openai-responses" }), "/responses");
  assert.equal(providerModelEndpoint({ protocol: "anthropic" }), undefined);
  assert.equal(providerModelEndpoint({ protocol: "unknown" }), undefined);
  // Open WebUI's provider record carries no protocol of its own -- the
  // account can host chat, messages, and responses models side by side -- so
  // the conversational endpoint is resolved from the model's own explicit
  // openWebUiProtocol claim, not from a per-provider default.
  const openWebUiProvider = { authProfile: "openwebui-session" };
  assert.equal(
    providerModelEndpoint(openWebUiProvider, { openWebUiProtocol: "chat" }),
    "/chat/completions",
  );
  assert.equal(
    providerModelEndpoint(openWebUiProvider, { openWebUiProtocol: "messages" }),
    undefined,
  );
  assert.equal(
    providerModelEndpoint(openWebUiProvider, { openWebUiProtocol: "responses" }),
    "/responses",
  );
  // With no model, or an Open WebUI provider outside its per-model branch,
  // the function must not silently default to chat completions.
  assert.equal(providerModelEndpoint(openWebUiProvider), "/chat/completions");
});

test("embeddings require an explicit model declaration", () => {
  const provider = { protocol: "openai" };
  assert.equal(
    supportsOpenAIModelEndpoint("/chat/completions", { model: {}, provider }),
    true,
  );
  assert.equal(
    supportsOpenAIModelEndpoint("/embeddings", { model: {}, provider }),
    false,
  );
  assert.equal(
    supportsOpenAIModelEndpoint("/embeddings", {
      model: { supportedEndpoints: ["/embeddings"] },
      provider,
    }),
    true,
  );
  assert.equal(
    supportsOpenAIModelEndpoint("/chat/completions", {
      model: { supportedEndpoints: ["/embeddings"] },
      provider,
    }),
    false,
  );
  assert.equal(
    supportsOpenAIModelEndpoint("/embeddings", {
      model: { supportedEndpoints: ["/embeddings"] },
      provider: { protocol: "anthropic" },
    }),
    false,
  );
  const error = endpointCapabilityError("/embeddings", { displayName: "Text model" });
  assert.equal(error.status, 400);
  assert.equal(error.code, "unsupported_model_endpoint");
  assert.match(error.message, /Text model/);
});

test("Open WebUI's conversational endpoint is per-model, not per-provider", () => {
  const provider = { authProfile: "openwebui-session" };
  const responsesModel = { openWebUiProtocol: "responses" };
  const chatModel = { openWebUiProtocol: "chat" };
  const messagesModel = { openWebUiProtocol: "messages" };
  assert.equal(supportsOpenAIModelEndpoint("/responses", { model: responsesModel, provider }), true);
  assert.equal(supportsOpenAIModelEndpoint("/chat/completions", { model: responsesModel, provider }), false);
  assert.equal(supportsOpenAIModelEndpoint("/chat/completions", { model: chatModel, provider }), true);
  assert.equal(supportsOpenAIModelEndpoint("/responses", { model: chatModel, provider }), false);
  // A Messages model exposes no OpenAI-shaped endpoint at all, same as any
  // other Anthropic-protocol provider.
  assert.equal(supportsOpenAIModelEndpoint("/chat/completions", { model: messagesModel, provider }), false);
  assert.equal(supportsOpenAIModelEndpoint("/responses", { model: messagesModel, provider }), false);
  // A declared supportedEndpoints list is still validated against the
  // model's own surface rather than a provider-wide default.
  assert.equal(
    supportsOpenAIModelEndpoint("/responses", {
      model: { openWebUiProtocol: "responses", supportedEndpoints: ["/responses"] },
      provider,
    }),
    true,
  );
  assert.equal(
    supportsOpenAIModelEndpoint("/chat/completions", {
      model: { openWebUiProtocol: "responses", supportedEndpoints: ["/responses"] },
      provider,
    }),
    false,
  );
});
