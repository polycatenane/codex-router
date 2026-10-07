import { spawnSync } from "node:child_process";

import { findCodexBinary } from "./codex-binary.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

const DAEMON_COMMAND_TIMEOUT_MS = 15_000;

function runDaemonCommand(binary, args, { spawn, platform, env }) {
  const target = spawnableCommand(binary, ["app-server", "daemon", ...args], platform);
  return spawn(target.command, target.args, {
    ...target.options,
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: DAEMON_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
}

function daemonVersionPayload(output) {
  const lines = String(output || "").trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.status === "string") return parsed;
    } catch {
      // Codex may print a version/update notice before the JSON record.
    }
  }
  return undefined;
}

export function codexAppServerDaemonStatus({
  spawn = spawnSync,
  binary = findCodexBinary(),
  platform = process.platform,
  env = process.env,
} = {}) {
  if (!binary) return { available: false, running: false };
  const result = runDaemonCommand(binary, ["version"], { spawn, platform, env });
  if (result.error || result.status !== 0) return { available: false, running: false };
  const payload = daemonVersionPayload(result.stdout);
  if (!payload) return { available: false, running: false };
  return {
    available: true,
    running: payload.status === "running",
    status: payload.status,
  };
}

// Codex app-server caches model/list for its lifetime. A committed catalog is
// invisible to daemon-backed pickers until that process reloads, so refresh a
// daemon that is already running. Do not start one on behalf of a CLI-only
// user, and tolerate older Codex builds that have no daemon subcommand.
export function restartCodexAppServerDaemonIfRunning({
  spawn = spawnSync,
  binary = findCodexBinary(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const status = codexAppServerDaemonStatus({ spawn, binary, platform, env });
  if (!status.running) return false;
  const result = runDaemonCommand(binary, ["restart"], { spawn, platform, env });
  if (result.error || result.status !== 0) {
    const error = new Error(
      "The Codex model catalog was published, but the running app-server daemon could not be restarted. " +
        "Run `codex app-server daemon restart` to refresh its model list.",
    );
    error.code = "codex_app_server_daemon_restart_failed";
    throw error;
  }
  return true;
}
