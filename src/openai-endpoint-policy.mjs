// Additional OpenAI-compatible endpoint policy.
//
// Chat, Responses, and Messages remain provider protocol contracts. A model
// may receive an additional endpoint only when its own reviewed/user-owned
// metadata names it. A shared base URL or provider name grants nothing.

export const OPENAI_MODEL_ENDPOINTS = Object.freeze([
  "/chat/completions",
  "/responses",
  "/embeddings",
]);

const ENDPOINTS = new Set(OPENAI_MODEL_ENDPOINTS);

export function normalizeSupportedEndpoints(value, { field = "supportedEndpoints" } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array.`);
  }
  const result = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !ENDPOINTS.has(entry)) {
      throw new Error(`${field} contains an unsupported endpoint.`);
    }
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

export function providerModelEndpoint(provider, model) {
  // Open WebUI's conversational endpoint is per-model, not per-provider: the
  // provider record never carries a protocol (the account can host chat,
  // messages, and responses models side by side), so a model's own explicit
  // openWebUiProtocol claim decides which OpenAI-shaped endpoint it answers.
  if (provider?.authProfile === "openwebui-session" && model) {
    if (model.openWebUiProtocol === "responses") return "/responses";
    if (model.openWebUiProtocol === "messages") return undefined;
    return "/chat/completions";
  }
  if (provider?.protocol === undefined || provider?.protocol === "openai") {
    return "/chat/completions";
  }
  if (provider?.protocol === "openai-responses") return "/responses";
  return undefined;
}

export function supportsOpenAIModelEndpoint(route, { model, provider } = {}) {
  if (!ENDPOINTS.has(route)) return false;
  // Messages-native providers do not expose OpenAI endpoint contracts. A
  // hand-edited model declaration must not turn Anthropic's /v1 base into an
  // embeddings base merely because both happen to carry JSON.
  if (providerModelEndpoint(provider, model) === undefined) return false;
  const declared = normalizeSupportedEndpoints(model?.supportedEndpoints);
  if (declared !== undefined) return declared.includes(route);
  return route === providerModelEndpoint(provider, model);
}

export function endpointCapabilityError(route, model) {
  const label = model?.displayName || model?.gatewayModel || model?.slug || "model";
  const error = new Error(`${label} does not support ${route}.`);
  error.status = 400;
  error.code = "unsupported_model_endpoint";
  return error;
}
