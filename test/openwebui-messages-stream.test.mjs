import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { createOpenWebUiMessagesInlineToolInputTransform } from "../src/openwebui-messages-stream.mjs";

function frame(event, data, newline = "\n") {
  return `${event ? `event: ${event}${newline}` : ""}data: ${JSON.stringify(data)}${newline}${newline}`;
}

async function transform(parts) {
  let output = "";
  await pipeline(
    Readable.from(parts),
    createOpenWebUiMessagesInlineToolInputTransform(),
    async function* (source) {
      for await (const chunk of source) output += chunk.toString("utf8");
    },
  );
  return output;
}

test("Open WebUI Messages inline tool input becomes an Anthropic argument delta", async () => {
  const start = frame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "call_1", name: "exec_command", input: { cmd: "git status" } },
  });
  const stop = frame("content_block_stop", { type: "content_block_stop", index: 0 });
  const source = `${start}${stop}`;
  const output = await transform([source.slice(0, 19), source.slice(19, 111), source.slice(111)]);

  assert.equal(output, `${start}${frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"cmd":"git status"}' },
  })}${stop}`);
});

test("Open WebUI Messages fine-grained tool arguments remain byte-identical", async () => {
  const start = frame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "call_1", name: "exec_command", input: {} },
  }, "\r\n");
  const delta = frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"cmd":"git status"}' },
  }, "\r\n");
  const stop = frame("content_block_stop", { type: "content_block_stop", index: 0 }, "\r\n");
  const source = `${start}${delta}${stop}`;

  assert.equal(await transform([source.slice(0, 97), source.slice(97)]), source);
});

test("Open WebUI Messages interleaved text cannot displace an active tool block", async () => {
  const toolStart = frame("content_block_start", {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "call_1", name: "exec_command", input: {} },
  });
  const textStart = frame("content_block_start", {
    type: "content_block_start",
    index: 2,
    content_block: { type: "text", text: "" },
  });
  const textDelta = frame("content_block_delta", {
    type: "content_block_delta",
    index: 2,
    delta: { type: "text_delta", text: "working" },
  });
  const textStop = frame("content_block_stop", { type: "content_block_stop", index: 2 });
  const argumentDelta = frame("content_block_delta", {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"cmd":"git status"}' },
  });
  const toolStop = frame("content_block_stop", { type: "content_block_stop", index: 1 });
  const source = `${toolStart}${textStart}${textDelta}${textStop}${argumentDelta}${toolStop}`;

  assert.equal(
    await transform([source.slice(0, 83), source.slice(83, 241), source.slice(241)]),
    `${toolStart}${argumentDelta}${toolStop}${textStart}${textDelta}${textStop}`,
  );
});
