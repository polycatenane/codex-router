import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  codexAppServerDaemonStatus,
  restartCodexAppServerDaemonIfRunning,
} from "../src/codex-app-server-daemon.mjs";

function result(status, stdout = "", stderr = "") {
  return { status, stdout, stderr, error: undefined };
}

test("a running Codex app-server daemon is restarted after publication", () => {
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args);
    return args.at(-1) === "version"
      ? result(0, '{"status":"running","appServerVersion":"0.160.1"}\n')
      : result(0);
  };
  assert.equal(restartCodexAppServerDaemonIfRunning({ spawn, binary: "/codex" }), true);
  assert.deepEqual(calls.map((args) => args.slice(-4)), [
    ["app-server", "daemon", "version"],
    ["app-server", "daemon", "restart"],
  ]);
});

test("a stopped daemon is observed but not started", () => {
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args);
    return result(0, '{"status":"stopped"}\n');
  };
  assert.equal(restartCodexAppServerDaemonIfRunning({ spawn, binary: "/codex" }), false);
  assert.equal(calls.length, 1);
  assert.equal(codexAppServerDaemonStatus({ spawn, binary: "/codex" }).status, "stopped");
});

test("older Codex builds without daemon management are skipped", () => {
  const spawn = () => result(2, "", "unknown command daemon");
  assert.deepEqual(codexAppServerDaemonStatus({ spawn, binary: "/codex" }), {
    available: false,
    running: false,
  });
  assert.equal(restartCodexAppServerDaemonIfRunning({ spawn, binary: "/codex" }), false);
});

test("a failed restart reports the manual recovery without undoing publication", () => {
  const spawn = (_command, args) => args.at(-1) === "version"
    ? result(0, "update notice\n{\"status\":\"running\"}\n")
    : result(1, "", "restart failed");
  assert.throws(
    () => restartCodexAppServerDaemonIfRunning({ spawn, binary: "/codex" }),
    (error) => {
      assert.equal(error.code, "codex_app_server_daemon_restart_failed");
      assert.match(error.message, /catalog was published/);
      assert.match(error.message, /codex app-server daemon restart/);
      return true;
    },
  );
});

test("catalog publication restarts the daemon only after releasing its lock", () => {
  const source = readFileSync(path.resolve("src/catalog.mjs"), "utf8");
  const entrypoint = source.slice(source.indexOf("if (process.argv[1]"));
  const publication = entrypoint.indexOf("await withCatalogPublicationLock(main)");
  const restart = entrypoint.indexOf("restartCodexAppServerDaemonIfRunning()");
  const errorBoundary = entrypoint.indexOf("} catch (error) {");
  assert.ok(publication >= 0, "catalog entrypoint does not publish through its lock");
  assert.ok(restart > publication, "daemon restart must follow committed publication");
  assert.ok(restart < errorBoundary, "daemon restart must remain in the successful publication path");
});
