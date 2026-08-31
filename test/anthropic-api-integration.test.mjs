import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { chatProviderToolSurface } from "../src/chat-tool-surface.mjs";
import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";
import { freePort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const litellm = path.join(
  root,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "litellm.exe" : "litellm",
);
const enabled = process.env.MODEL_ROUTER_LITELLM_INTEGRATION === "1";
const INTERNAL_KEY = "anthropic-e2e-internal-service-key-with-sufficient-length";
const CALLER_KEY = "anthropic-e2e-caller-capability-with-sufficient-length";
const PROVIDER_KEY = "anthropic-e2e-provider-key";
const OPENWEBUI_TOKEN = "header.eyJleHAiOjQxMDI0NDQ4MDB9.signature";
const EXEC_COMMAND_SCHEMA = {
  type: "object",
  properties: { cmd: { type: "string" } },
  required: ["cmd"],
  additionalProperties: false,
};
const TOOL_ARGUMENT_FRAGMENTS = Object.freeze(['{"cm', 'd":"git ', 'status"}']);
const OPENWEBUI_TOOL_CALL_ID = "call_openwebui_tool";

async function freePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function waitForRouter(port, child, output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Integration stack exited early: ${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // LiteLLM is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for the integration stack: ${output()}`);
}

function sseFrame(event, data) {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function openWebUiToolStream(protocol, { interleaved = false } = {}) {
  if (protocol === "messages") {
    const interleavedText = interleaved
      ? [
          sseFrame("content_block_start", {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          }),
          sseFrame("content_block_delta", {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "working" },
          }),
          sseFrame("content_block_stop", { type: "content_block_stop", index: 1 }),
        ]
      : [];
    return [
      sseFrame("message_start", {
        type: "message_start",
        message: {
          id: "msg_openwebui_tool",
          type: "message",
          role: "assistant",
          model: "bedrock-claude-test",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      }),
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: OPENWEBUI_TOOL_CALL_ID,
          name: "exec_command",
          input: {},
        },
      }),
      ...interleavedText,
      ...TOOL_ARGUMENT_FRAGMENTS.map((partial_json) => sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json },
      })),
      sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
      sseFrame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 3 },
      }),
      sseFrame("message_stop", { type: "message_stop" }),
    ];
  }
  return [
    ...TOOL_ARGUMENT_FRAGMENTS.map((argumentsText, index) => sseFrame("", {
      id: "chatcmpl_openwebui_tool",
      object: "chat.completion.chunk",
      model: "bedrock-claude-test",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            ...(index === 0
              ? { id: OPENWEBUI_TOOL_CALL_ID, type: "function", function: { name: "exec_command", arguments: argumentsText } }
              : { function: { arguments: argumentsText } }),
          }],
        },
        finish_reason: null,
      }],
    })),
    sseFrame("", {
      id: "chatcmpl_openwebui_tool",
      object: "chat.completion.chunk",
      model: "bedrock-claude-test",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }),
    "data: [DONE]\n\n",
  ];
}

function responsesEvents(body) {
  return body.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return [];
    try {
      return [JSON.parse(data)];
    } catch {
      return [];
    }
  });
}

function openWebUiResponsesStream() {
  // Unlike the chat and messages branches above, an Open WebUI responses
  // route never crosses LiteLLM's Chat -> Responses bridge, so the mock here
  // plays the exact shape LiteLLM's OpenAI Responses adapter passes through
  // untouched: no translation happens on either side of that hop.
  return [
    sseFrame("response.created", {
      type: "response.created",
      response: { id: "resp_openwebui_responses", model: "bedrock-claude-test", status: "in_progress" },
    }),
    sseFrame("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: OPENWEBUI_TOOL_CALL_ID,
        call_id: OPENWEBUI_TOOL_CALL_ID,
        name: "exec_command",
        arguments: "",
      },
    }),
    ...TOOL_ARGUMENT_FRAGMENTS.map((delta) => sseFrame("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: OPENWEBUI_TOOL_CALL_ID,
      output_index: 0,
      delta,
    })),
    sseFrame("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: OPENWEBUI_TOOL_CALL_ID,
      output_index: 0,
      arguments: TOOL_ARGUMENT_FRAGMENTS.join(""),
    }),
    sseFrame("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: OPENWEBUI_TOOL_CALL_ID,
        call_id: OPENWEBUI_TOOL_CALL_ID,
        name: "exec_command",
        arguments: TOOL_ARGUMENT_FRAGMENTS.join(""),
        status: "completed",
      },
    }),
    sseFrame("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_openwebui_responses",
        model: "bedrock-claude-test",
        status: "completed",
        output: [{
          type: "function_call",
          id: OPENWEBUI_TOOL_CALL_ID,
          call_id: OPENWEBUI_TOOL_CALL_ID,
          name: "exec_command",
          arguments: TOOL_ARGUMENT_FRAGMENTS.join(""),
          status: "completed",
        }],
      },
    }),
    "data: [DONE]\n\n",
  ];
}

function fullCodexToolCatalog() {
  // This is the client-visible local command together with the complete app
  // snapshot the router normally expands into every routed chat surface.
  // Keep the actual snapshot objects intact: a reduced hand-written catalog
  // would not exercise the failure reported against the full surface.
  return [
    {
      type: "function",
      name: "exec_command",
      description: "Run a shell command.",
      parameters: EXEC_COMMAND_SCHEMA,
    },
    ...CODEX_APP_TOOLS,
  ];
}

function providerToolName(tool) {
  return tool?.name || tool?.function?.name;
}

function parsedArgumentKeys(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed).sort()
      : [];
  } catch {
    return [];
  }
}

function validExecCommandArguments(value) {
  try {
    const parsed = JSON.parse(value);
    return Boolean(
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.cmd === "string" &&
      Object.keys(parsed).every((key) => key === "cmd"),
    );
  } catch {
    return false;
  }
}

function redactedToolTrace({
  callId,
  toolIndex,
  originalName = "exec_command",
  wireName = "exec_command",
  argumentFragmentLength = 0,
  assembledArguments = "",
}) {
  return {
    callId,
    toolIndex,
    originalName,
    wireName,
    argumentFragmentLength,
    assembledArgumentKeys: parsedArgumentKeys(assembledArguments),
    validAgainstSchema: validExecCommandArguments(assembledArguments),
  };
}

function assertRedactedToolTraces(traces) {
  const fields = [
    "argumentFragmentLength",
    "assembledArgumentKeys",
    "callId",
    "originalName",
    "toolIndex",
    "validAgainstSchema",
    "wireName",
  ].sort();
  for (const trace of traces) assert.deepEqual(Object.keys(trace).sort(), fields);
}

test(
  "Codex Responses reaches Anthropic Messages through the real LiteLLM adapter",
  {
    skip: !enabled
      ? "set MODEL_ROUTER_LITELLM_INTEGRATION=1 for the pinned-adapter integration test"
      : !existsSync(litellm)
        ? "run ./install.sh --target codex --prepare-only first"
        : false,
    timeout: 90_000,
  },
  async () => {
    const [mockPort, routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort] =
      await freePorts(6);
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-anthropic-e2e-"));
    const stateDir = path.join(testRoot, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(stateDir, "internal-secret"), `${INTERNAL_KEY}\n`, { mode: 0o600 });
    writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
    writeFileSync(path.join(stateDir, "anthropic-api-key.secret"), `${PROVIDER_KEY}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      path.join(stateDir, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["anthropic-api"] })}\n`,
      { mode: 0o600 },
    );

    let received;
    const mock = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      const payload = JSON.stringify({
        id: "msg_anthropic_codex_e2e",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "ANTHROPIC_CODEX_REPO_OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 5 },
      });
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload)),
      });
      response.end(payload);
    });
    await new Promise((resolve, reject) => {
      mock.once("error", reject);
      mock.listen(mockPort, "127.0.0.1", resolve);
    });

    const stack = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_PORT: String(routerPort),
        MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
        MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
        MODEL_ROUTER_API_PORT: String(apiPort),
        MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
        ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stackOutput = "";
    stack.stdout.setEncoding("utf8");
    stack.stderr.setEncoding("utf8");
    stack.stdout.on("data", (chunk) => { stackOutput += chunk; });
    stack.stderr.on("data", (chunk) => { stackOutput += chunk; });

    try {
      await waitForRouter(routerPort, stack, () => stackOutput);
      const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "anthropic-api/claude-opus-4.8",
          input: "Reply with the repository marker.",
          reasoning: { effort: "high", summary: "auto" },
          stream: false,
        }),
      });
      const body = await response.text();
      assert.equal(response.status, 200, `${body}\n${stackOutput}`);
      assert.match(body, /ANTHROPIC_CODEX_REPO_OK/);
      assert.equal(received.method, "POST");
      assert.equal(received.url, "/v1/messages");
      assert.equal(received.headers["x-api-key"], PROVIDER_KEY);
      assert.equal(received.headers.authorization, undefined);
      assert.equal(received.headers["anthropic-version"], "2023-06-01");
      assert.equal(received.body.model, "claude-opus-4-8");
      assert.deepEqual(received.body.thinking, { type: "adaptive" });
      assert.deepEqual(received.body.output_config, { effort: "high" });
    } finally {
      await stopProcess(stack);
      await new Promise((resolve) => mock.close(resolve));
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "Open WebUI Chat and interleaved Messages streams preserve tool arguments through LiteLLM",
  {
    skip: !enabled
      ? "set MODEL_ROUTER_LITELLM_INTEGRATION=1 for the pinned-adapter integration test"
      : !existsSync(litellm)
        ? "run ./install.sh --target codex --prepare-only first"
        : false,
    timeout: 180_000,
  },
  async () => {
    for (const protocol of ["chat", "messages"]) {
      const interleaved = protocol === "messages";
      const [mockPort, routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort] =
        await freePorts(6);
      const testRoot = mkdtempSync(path.join(os.tmpdir(), `codex-openwebui-${protocol}-e2e-`));
      const stateDir = path.join(testRoot, "state");
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(stateDir, "internal-secret"), `${INTERNAL_KEY}\n`, { mode: 0o600 });
      writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
      writeFileSync(path.join(stateDir, "openwebui-session.secret"), `${OPENWEBUI_TOKEN}\n`, {
        mode: 0o600,
      });
      writeFileSync(
        path.join(stateDir, "openwebui-origin.json"),
        `${JSON.stringify({ version: 1, baseUrl: `http://127.0.0.1:${mockPort}` })}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        path.join(stateDir, "enabled-providers.json"),
        `${JSON.stringify({ version: 1, providers: ["openwebui"] })}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        path.join(stateDir, "user-models.json"),
        `${JSON.stringify({
          version: 1,
          models: [{
            slug: "openwebui/bedrock-claude-test",
            gatewayModel: "openwebui--YmVkcm9jay1jbGF1ZGUtdGVzdA",
            compHash: "openwebui-tool-stream-fixture-v1",
            upstreamModel: "bedrock-claude-test",
            provider: "openwebui",
            listed: true,
            displayName: "Open WebUI tool-stream fixture",
            description: "Test fixture.",
            priority: 100,
            defaultEffort: "high",
            reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
            contextWindow: 131072,
            autoCompact: 110000,
            inputModalities: ["text"],
            openWebUiProtocol: protocol,
            openWebUiToolNameLimit: 64,
          }],
        })}\n`,
        { mode: 0o600 },
      );

      const received = [];
      const trace = {
        codexToRouter: [],
        routerToOpenWebUi: [],
        rawOpenWebUiStream: [],
        routerAssembled: [],
        responsesToCodex: [],
      };
      const mock = http.createServer(async (request, response) => {
        if (request.method === "GET" && request.url === "/api/models") {
          received.push({ method: request.method, url: request.url, headers: request.headers });
          const body = JSON.stringify({ object: "list", data: [] });
          response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) });
          response.end(body);
          return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        received.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        const expectedPath = protocol === "messages" ? "/api/v1/messages" : "/api/chat/completions";
        assert.equal(request.url, expectedPath);
        const frames = openWebUiToolStream(protocol, { interleaved });
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const fragment of TOOL_ARGUMENT_FRAGMENTS) {
          trace.rawOpenWebUiStream.push(redactedToolTrace({
            callId: OPENWEBUI_TOOL_CALL_ID,
            toolIndex: 0,
            argumentFragmentLength: fragment.length,
          }));
        }
        for (const frame of frames) {
          const split = Math.max(1, Math.floor(frame.length / 2));
          response.write(frame.slice(0, split));
          response.write(frame.slice(split));
        }
        response.end();
      });
      await new Promise((resolve, reject) => {
        mock.once("error", reject);
        mock.listen(mockPort, "127.0.0.1", resolve);
      });

      const stack = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
        cwd: root,
        env: {
          ...process.env,
          MODEL_ROUTER_TARGET: "codex",
          MODEL_ROUTER_STATE_DIR: stateDir,
          MODEL_ROUTER_PORT: String(routerPort),
          MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
          MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
          MODEL_ROUTER_API_PORT: String(apiPort),
          MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stackOutput = "";
      stack.stdout.setEncoding("utf8");
      stack.stderr.setEncoding("utf8");
      stack.stdout.on("data", (chunk) => { stackOutput += chunk; });
      stack.stderr.on("data", (chunk) => { stackOutput += chunk; });

      try {
        await waitForRouter(routerPort, stack, () => stackOutput);
        // Replay the router's exact built-in app snapshot, plus the local tool
        // whose call the fixture forces. The traces below deliberately retain
        // only field names, indexes, ids, and lengths -- never schemas,
        // prompts, arguments, credentials, or raw SSE payloads.
        const originalCatalog = fullCodexToolCatalog();
        const originalToolIndex = originalCatalog.findIndex((tool) => tool.name === "exec_command");
        assert.equal(originalToolIndex, 0);
        assert.equal(originalCatalog.length, CODEX_APP_TOOLS.length + 1);
        const expectedWireCatalog = chatProviderToolSurface(originalCatalog, "openwebui", {
          input: "Run git status with the exec_command tool.",
          toolChoice: "required",
          maxNameLength: 64,
        });
        trace.codexToRouter.push(redactedToolTrace({
          callId: OPENWEBUI_TOOL_CALL_ID,
          toolIndex: originalToolIndex,
        }));
        const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "openwebui/bedrock-claude-test",
            input: "Run git status with the exec_command tool.",
            tools: originalCatalog,
            // LiteLLM's pinned Responses schema supports the portable required
            // mode. The mock then deterministically emits exec_command exactly
            // once, so this remains a forced single-call replay.
            tool_choice: "required",
            stream: true,
          }),
        });
        const body = await response.text();
        assert.equal(response.status, 200, `${body}\n${stackOutput}`);
        const events = responsesEvents(body);
        const call = events.find(
          (event) => event?.type === "response.output_item.added" && event.item?.type === "function_call",
        );
        assert.equal(call?.item?.name, "exec_command");
        assert.equal(call?.item?.call_id, OPENWEBUI_TOOL_CALL_ID);
        const argumentDeltas = events
          .filter((event) => event?.type === "response.function_call_arguments.delta")
          .map((event) => event.delta)
          .join("");
        assert.equal(argumentDeltas, '{"cmd":"git status"}');
        const completed = events.find((event) => event?.type === "response.function_call_arguments.done");
        assert.equal(completed?.arguments, '{"cmd":"git status"}');
        const generation = received.find((entry) => entry.method === "POST");
        assert.equal(generation?.headers?.authorization, `Bearer ${OPENWEBUI_TOKEN}`);
        assert.deepEqual(
          generation?.body?.tools?.map(providerToolName),
          expectedWireCatalog.tools.map(providerToolName),
        );
        const wireToolIndex = generation?.body?.tools?.findIndex(
          (tool) => providerToolName(tool) === "exec_command",
        );
        assert.equal(wireToolIndex, 0);
        const wireFunction = generation.body.tools[wireToolIndex]?.function ||
          generation.body.tools[wireToolIndex];
        const wireSchema = wireFunction.parameters || wireFunction.input_schema;
        assert.ok(wireSchema?.properties?.cmd);
        assert.ok(wireSchema?.required?.includes("cmd"));
        trace.routerToOpenWebUi.push(redactedToolTrace({
          callId: OPENWEBUI_TOOL_CALL_ID,
          toolIndex: wireToolIndex,
          wireName: providerToolName(generation.body.tools[wireToolIndex]),
        }));
        trace.routerAssembled.push(redactedToolTrace({
          callId: call.item.call_id,
          toolIndex: 0,
          wireName: call.item.name,
          argumentFragmentLength: argumentDeltas.length,
          assembledArguments: argumentDeltas,
        }));
        trace.responsesToCodex.push(redactedToolTrace({
          // LiteLLM's done event identifies the item but does not repeat the
          // call id. Correlate it with the emitted function-call item.
          callId: call.item.call_id,
          toolIndex: 0,
          wireName: call.item.name,
          argumentFragmentLength: completed.arguments.length,
          assembledArguments: completed.arguments,
        }));
        assert.deepEqual(trace.codexToRouter, [redactedToolTrace({
          callId: OPENWEBUI_TOOL_CALL_ID,
          toolIndex: 0,
        })]);
        assert.deepEqual(trace.routerToOpenWebUi, [redactedToolTrace({
          callId: OPENWEBUI_TOOL_CALL_ID,
          toolIndex: 0,
        })]);
        assert.deepEqual(
          trace.rawOpenWebUiStream.map((entry) => entry.argumentFragmentLength),
          TOOL_ARGUMENT_FRAGMENTS.map((fragment) => fragment.length),
        );
        assert.deepEqual(trace.routerAssembled, [redactedToolTrace({
          callId: OPENWEBUI_TOOL_CALL_ID,
          toolIndex: 0,
          argumentFragmentLength: argumentDeltas.length,
          assembledArguments: argumentDeltas,
        })]);
        assert.deepEqual(trace.responsesToCodex, [redactedToolTrace({
          callId: OPENWEBUI_TOOL_CALL_ID,
          toolIndex: 0,
          argumentFragmentLength: completed.arguments.length,
          assembledArguments: completed.arguments,
        })]);
        assertRedactedToolTraces(Object.values(trace).flat());
      } finally {
        await stopProcess(stack);
        await new Promise((resolve) => mock.close(resolve));
        rmSync(testRoot, { recursive: true, force: true });
      }
    }
  },
);

test(
  "Open WebUI responses model relays a verbatim upstream Responses stream with no repair stage",
  {
    skip: !enabled
      ? "set MODEL_ROUTER_LITELLM_INTEGRATION=1 for the pinned-adapter integration test"
      : !existsSync(litellm)
        ? "run ./install.sh --target codex --prepare-only first"
        : false,
    timeout: 90_000,
  },
  async () => {
    const [mockPort, routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort] =
      await freePorts(6);
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-openwebui-responses-e2e-"));
    const stateDir = path.join(testRoot, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(stateDir, "internal-secret"), `${INTERNAL_KEY}\n`, { mode: 0o600 });
    writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
    writeFileSync(path.join(stateDir, "openwebui-session.secret"), `${OPENWEBUI_TOKEN}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      path.join(stateDir, "openwebui-origin.json"),
      `${JSON.stringify({ version: 1, baseUrl: `http://127.0.0.1:${mockPort}` })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(stateDir, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["openwebui"] })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(stateDir, "user-models.json"),
      `${JSON.stringify({
        version: 1,
        models: [{
          slug: "openwebui/bedrock-claude-test",
          gatewayModel: "openwebui--YmVkcm9jay1jbGF1ZGUtdGVzdA",
          compHash: "openwebui-responses-stream-fixture-v1",
          upstreamModel: "bedrock-claude-test",
          provider: "openwebui",
          listed: true,
          displayName: "Open WebUI responses fixture",
          description: "Test fixture.",
          priority: 100,
          defaultEffort: "high",
          reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
          contextWindow: 131072,
          autoCompact: 110000,
          inputModalities: ["text"],
          openWebUiProtocol: "responses",
        }],
      })}\n`,
      { mode: 0o600 },
    );

    const received = [];
    const mock = http.createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/api/models") {
        received.push({ method: request.method, url: request.url, headers: request.headers });
        const body = JSON.stringify({ object: "list", data: [] });
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) });
        response.end(body);
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      // Unlike /api/chat/completions or /api/v1/messages, this is the raw
      // Open WebUI passthrough route: no chat pipeline, no RAG, no filters.
      assert.equal(request.url, "/openai/responses");
      const body = Buffer.from(openWebUiResponsesStream().join(""), "utf8");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(body);
    });
    await new Promise((resolve, reject) => {
      mock.once("error", reject);
      mock.listen(mockPort, "127.0.0.1", resolve);
    });

    const stack = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_PORT: String(routerPort),
        MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
        MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
        MODEL_ROUTER_API_PORT: String(apiPort),
        MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stackOutput = "";
    stack.stdout.setEncoding("utf8");
    stack.stderr.setEncoding("utf8");
    stack.stdout.on("data", (chunk) => { stackOutput += chunk; });
    stack.stderr.on("data", (chunk) => { stackOutput += chunk; });

    try {
      await waitForRouter(routerPort, stack, () => stackOutput);
      const originalCatalog = fullCodexToolCatalog();
      const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openwebui/bedrock-claude-test",
          input: "Run git status with the exec_command tool.",
          tools: originalCatalog,
          tool_choice: "required",
          stream: true,
        }),
      });
      const body = await response.text();
      assert.equal(response.status, 200, `${body}\n${stackOutput}`);
      const events = responsesEvents(body);
      const upstreamEvents = responsesEvents(openWebUiResponsesStream().join(""));
      // "No repair stage inserted" is proven by exact event equality, once
      // LiteLLM's own routing metadata is stripped: LiteLLM's Responses
      // passthrough stamps every event with `model` and rewrites
      // `response.id` into its own deployment-routing token, which is
      // LiteLLM's bookkeeping and not a router repair stage. Everything else
      // -- event count, order, and every other field -- must survive
      // byte-for-byte, which is what distinguishes this from the chat and
      // messages routes above, where the router assembles and re-emits its
      // own events from a translated wire shape.
      const stripLiteLlmRouting = (list) => list.map(({ model, ...event }) => {
        if (event.response && typeof event.response === "object") {
          const { id: _responseId, ...rest } = event.response;
          return { ...event, response: rest };
        }
        return event;
      });
      assert.equal(events.length, upstreamEvents.length);
      assert.deepEqual(events.map((event) => event.type), upstreamEvents.map((event) => event.type));
      assert.deepEqual(stripLiteLlmRouting(events), stripLiteLlmRouting(upstreamEvents));
      const generation = received.find((entry) => entry.method === "POST");
      assert.equal(generation?.url, "/openai/responses");
      assert.equal(generation?.headers?.authorization, `Bearer ${OPENWEBUI_TOKEN}`);
      // The client-facing slug is rewritten to the upstream's own model id on
      // the wire, exactly like the chat and messages routes.
      assert.equal(generation?.body?.model, "bedrock-claude-test");
      // Namespace tools reach the upstream in Codex's native shape: nothing
      // flattens them, because this model carries no openWebUiToolNameLimit
      // opt-in and its route never crosses a chat-completions bridge.
      assert.ok(
        generation?.body?.tools?.some((tool) => tool?.type === "namespace"),
        "namespace tools are forwarded to Open WebUI exactly as Codex built them",
      );
    } finally {
      await stopProcess(stack);
      await new Promise((resolve) => mock.close(resolve));
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
