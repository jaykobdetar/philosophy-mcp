import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function resultText(result) {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

function readLine(stream, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("Timed out waiting for a protocol line.")), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) finish(undefined, buffer.slice(0, newline));
    };
    const finish = (error, line) => {
      clearTimeout(timer);
      stream.off("data", onData);
      error ? reject(error) : resolve(line);
    };
    stream.on("data", onData);
  });
}

function waitForExit(child, message, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(message)), timeoutMs);
    timer.unref();
    const onExit = (code, signal) => finish(undefined, { code, signal });
    const finish = (error, result) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      error ? reject(error) : resolve(result);
    };
    child.once("exit", onExit);
  });
}

test("stdio transport fails closed on an unconsumed request flood", async (t) => {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  child.stdin.on("error", () => {});
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "flood-test", version: "1.0.0" },
      },
    })}\n`,
  );
  JSON.parse(await readLine(child.stdout));
  child.stdout.pause();
  const frames = [
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    ...Array.from({ length: 100 }, (_, index) =>
      JSON.stringify({ jsonrpc: "2.0", id: 100 + index, method: "tools/list", params: {} }),
    ),
  ].join("\n") + "\n";
  child.stdin.write(frames);
  const exit = await waitForExit(child, "Flooded server did not close.");
  assert.notEqual(exit.code, 0);
});

test("stdio transport fails closed on duplicate outstanding request ids", async (t) => {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  child.stdin.on("error", () => {});
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "duplicate-id-test", version: "1.0.0" },
      },
    })}\n`,
  );
  JSON.parse(await readLine(child.stdout));
  child.stdout.pause();
  child.stdin.write(
    [
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list", params: {} }),
    ].join("\n") + "\n",
  );
  const exit = await waitForExit(child, "Duplicate-id server did not close.");
  assert.notEqual(exit.code, 0);
});

test("cancellation notifications cannot bypass stdio admission", async (t) => {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  child.stdin.on("error", () => {});
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cancel-flood-test", version: "1.0.0" },
      },
    })}\n`,
  );
  JSON.parse(await readLine(child.stdout));
  child.stdout.pause();
  const frames = [
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  ];
  for (let index = 0; index < 100; index += 1) {
    const id = 1_000 + index;
    frames.push(JSON.stringify({ jsonrpc: "2.0", id, method: "unknown/method", params: {} }));
    frames.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, reason: "adversarial admission test" },
      }),
    );
  }
  child.stdin.write(frames.join("\n") + "\n");
  const exit = await waitForExit(child, "Cancellation flood did not close the server.");
  assert.notEqual(exit.code, 0);
});

test("completed ordinary cancellations leave subsequent MCP requests usable", { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  child.stdin.on("error", () => {});
  const initialized = readLine(child.stdout);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "ordinary-cancellation", version: "1.0.0" },
    },
  })}\n`);
  assert.equal(JSON.parse(await initialized).id, 1);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  for (let index = 0; index < 18; index++) {
    const canceledId = 100 + index * 2;
    const nextId = canceledId + 1;
    const reply = readLine(child.stdout);
    child.stdin.write([
      JSON.stringify({ jsonrpc: "2.0", id: canceledId, method: "ping" }),
      JSON.stringify({
        jsonrpc: "2.0", method: "notifications/cancelled",
        params: { requestId: canceledId, reason: "user changed the selected view" },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: nextId, method: "ping" }),
    ].join("\n") + "\n");
    assert.equal(JSON.parse(await reply).id, nextId);
  }
  const toolsReply = readLine(child.stdout);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 200, method: "tools/list" })}\n`);
  assert.equal(JSON.parse(await toolsReply).result.tools.length, 20);
});

test("stdio shutdown discards a backpressured response backlog", async (t) => {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  child.stdin.on("error", () => {});
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "backpressure-test", version: "1.0.0" },
      },
    })}\n`,
  );
  JSON.parse(await readLine(child.stdout));
  child.stdout.pause();
  const frames = [
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    ...Array.from({ length: 15 }, (_, index) =>
      JSON.stringify({ jsonrpc: "2.0", id: 200 + index, method: "tools/list", params: {} }),
    ),
  ].join("\n") + "\n";
  child.stdin.end(frames);
  const exit = await waitForExit(child, "Backpressured server did not exit.");
  assert.equal(exit.code, 0);
});

test("SIGTERM performs bounded server cleanup before exit", { skip: process.platform === "win32" }, async (t) => {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  child.stdin.on("error", () => {});
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "signal-test", version: "1.0.0" },
      },
    })}\n`,
  );
  JSON.parse(await readLine(child.stdout));
  child.kill("SIGTERM");
  const exit = await waitForExit(child, "SIGTERM server did not exit after cleanup.");
  assert.equal(exit.code, 143);
});

test("hardened MCP stays connected and rejects boundary-bypass tool calls", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "philosophy-mcp-integration-"));
  const allowed = join(base, "allowed");
  const home = join(base, "home");
  await mkdir(allowed, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const note = join(allowed, "notes.txt");
  const extensionless = join(allowed, "id_rsa");
  const homeSecret = join(home, "secret.txt");
  await writeFile(note, "Justice and knowledge are philosophy topics.\nAİjusticeZ", { mode: 0o600 });
  await writeFile(extensionless, "PRIVATE KEY", { mode: 0o600 });
  await writeFile(homeSecret, "HOME SECRET", { mode: 0o600 });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: projectRoot,
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: home,
      PHILOSOPHY_DOC_ROOTS: allowed,
      PHILOSOPHY_FETCH_HOSTS: "",
    },
  });
  const client = new Client({ name: "security-test", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  await client.connect(transport);

  assert.equal((await client.listTools()).tools.length, 20);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await client.listTools()).tools.length, 20);

  const readable = await client.callTool({
    name: "local_doc_read",
    arguments: { path: note, page_from: 1, max_chars: 1000 },
  });
  assert.equal(Boolean(readable.isError), false);
  assert.match(resultText(readable), /Justice and knowledge/);

  const outside = await client.callTool({
    name: "local_doc_read",
    arguments: { path: homeSecret, page_from: 1, max_chars: 1000 },
  });
  assert.equal(Boolean(outside.isError), true);
  assert.doesNotMatch(resultText(outside), /HOME SECRET/);

  const noExtension = await client.callTool({
    name: "local_doc_read",
    arguments: { path: extensionless, page_from: 1, max_chars: 1000 },
  });
  assert.equal(Boolean(noExtension.isError), true);
  assert.doesNotMatch(resultText(noExtension), /PRIVATE KEY/);

  const regex = await client.callTool({
    name: "local_doc_search",
    arguments: {
      path: note,
      query: "(a+)+$",
      is_regex: true,
      max_matches: 10,
      max_chars: 1000,
    },
  });
  assert.equal(Boolean(regex.isError), true);
  assert.match(resultText(regex), /Regular-expression search is disabled/);

  const unicodeLiteral = await client.callTool({
    name: "local_doc_search",
    arguments: {
      path: note,
      query: "justice",
      ignore_case: true,
      context_chars: 0,
      max_matches: 10,
      max_chars: 1000,
    },
  });
  assert.equal(Boolean(unicodeLiteral.isError), false);
  assert.match(resultText(unicodeLiteral), /\[p\.1\] …justice…/);
  assert.doesNotMatch(resultText(unicodeLiteral), /usticeZ/);

  const sepEscape = await client.callTool({
    name: "get_sep_entry",
    arguments: { entry: "//evil.test/x", max_chars: 1000 },
  });
  assert.equal(Boolean(sepEscape.isError), true);

  const wikiEscape = await client.callTool({
    name: "search_wikisource",
    arguments: { query: "Kant", lang: "evil.test/path?x=", limit: 1 },
  });
  assert.equal(Boolean(wikiEscape.isError), true);

  const disabledFetch = await client.callTool({
    name: "fetch_text",
    arguments: { url: "https://example.com/", max_chars: 1000 },
  });
  assert.equal(Boolean(disabledFetch.isError), true);
  assert.match(resultText(disabledFetch), /fetch_text is disabled/);
});

test("local tools fail closed when PHILOSOPHY_DOC_ROOTS is unset", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "philosophy-mcp-disabled-root-"));
  const note = join(base, "notes.txt");
  await writeFile(note, "must not be returned", { mode: 0o600 });
  const env = { ...process.env };
  delete env.PHILOSOPHY_DOC_ROOTS;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: projectRoot,
    stderr: "pipe",
    env,
  });
  const client = new Client({ name: "disabled-root-test", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  await client.connect(transport);
  const result = await client.callTool({
    name: "local_doc_read",
    arguments: { path: note, page_from: 1, max_chars: 1000 },
  });
  assert.equal(Boolean(result.isError), true);
  assert.match(resultText(result), /Local document access is disabled/);
  assert.doesNotMatch(resultText(result), /must not be returned/);
});
