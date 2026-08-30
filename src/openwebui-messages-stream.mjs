import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

function nextSseBoundary(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return undefined;
  if (crlf === -1) return { at: lf, size: 2 };
  if (lf === -1) return { at: crlf, size: 4 };
  return crlf < lf ? { at: crlf, size: 4 } : { at: lf, size: 2 };
}

function sseData(rawEvent) {
  const lines = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    lines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return lines.length ? lines.join("\n") : undefined;
}

function parseSseEvent(rawEvent) {
  const data = sseData(rawEvent);
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function inlineToolInput(event) {
  if (event?.type !== "content_block_start") return undefined;
  const block = event.content_block;
  if (block?.type !== "tool_use" && block?.type !== "server_tool_use") return undefined;
  if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) return undefined;
  if (Object.keys(block.input).length === 0) return undefined;
  if (!Number.isInteger(event.index) || event.index < 0) return undefined;
  return { index: event.index, input: JSON.stringify(block.input) };
}

function inputJsonDelta(event) {
  return event?.type === "content_block_delta" &&
    event.delta?.type === "input_json_delta" &&
    Number.isInteger(event.index) && event.index >= 0;
}

function contentBlockStop(event) {
  return event?.type === "content_block_stop" && Number.isInteger(event.index) && event.index >= 0;
}

function toolBlockStart(event) {
  return event?.type === "content_block_start" &&
    (event.content_block?.type === "tool_use" || event.content_block?.type === "server_tool_use") &&
    Number.isInteger(event.index) && event.index >= 0;
}

function inputJsonDeltaFrame(index, partialJson, newline) {
  const event = {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  };
  return `event: content_block_delta${newline}data: ${JSON.stringify(event)}${newline}${newline}`;
}

// LiteLLM's pinned Anthropic stream adapter reads tool arguments exclusively
// from input_json_delta and tracks only one current content block. Open WebUI's
// Bedrock bridge can put the final input on content_block_start or interleave
// complete text blocks while a tool block is still open. Normalize either form
// into one contiguous tool block; ordinary sequential streams stay unchanged.
export function createOpenWebUiMessagesInlineToolInputTransform() {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const pending = new Map();
  let activeToolIndex;
  let deferred = [];

  function emitPending(transform, index, newline) {
    const input = pending.get(index);
    if (input === undefined) return;
    pending.delete(index);
    transform.push(inputJsonDeltaFrame(index, input, newline));
  }

  function handleFrame(transform, rawEvent, delimiter) {
    const event = parseSseEvent(rawEvent);
    if (
      activeToolIndex !== undefined &&
      Number.isInteger(event?.index) &&
      event.index !== activeToolIndex
    ) {
      deferred.push({ rawEvent, delimiter });
      return;
    }
    const inline = inlineToolInput(event);
    if (inline) {
      activeToolIndex = inline.index;
      pending.set(inline.index, inline.input);
      transform.push(rawEvent + delimiter);
      return;
    }
    if (toolBlockStart(event)) activeToolIndex = event.index;
    if (inputJsonDelta(event)) pending.delete(event.index);
    const stoppedActiveTool = contentBlockStop(event) && event.index === activeToolIndex;
    if (contentBlockStop(event)) {
      emitPending(transform, event.index, delimiter.includes("\r\n") ? "\r\n" : "\n");
    }
    transform.push(rawEvent + delimiter);
    if (stoppedActiveTool) {
      activeToolIndex = undefined;
      const queued = deferred;
      deferred = [];
      for (const frame of queued) handleFrame(transform, frame.rawEvent, frame.delimiter);
    }
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        buffer += decoder.write(chunk);
        let boundary;
        while ((boundary = nextSseBoundary(buffer))) {
          const rawEvent = buffer.slice(0, boundary.at);
          const delimiter = buffer.slice(boundary.at, boundary.at + boundary.size);
          buffer = buffer.slice(boundary.at + boundary.size);
          handleFrame(this, rawEvent, delimiter);
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        buffer += decoder.end();
        if (buffer) handleFrame(this, buffer, "");
        for (const frame of deferred) this.push(frame.rawEvent + frame.delimiter);
        deferred = [];
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}
