import assert from "node:assert/strict";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PingRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { trackCanceledRequestCompletion } from "../dist/request-lifecycle.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const outcome of ["success", "error"]) {
  test(`canceled handled ${outcome} reclaims admission after completion`, { timeout: 5_000 }, async (t) => {
    const server = new Server({ name: "ordinary-cancellation", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(() => server.close());
    const entered = deferred();
    const finish = deferred();
    const terminal = deferred();
    const completed = [];
    const replies = [];
    clientTransport.onmessage = (message) => replies.push(message);
    trackCanceledRequestCompletion(server, (id) => {
      completed.push(id);
      terminal.resolve();
    });
    server.setRequestHandler(PingRequestSchema, async (_request, extra) => {
      entered.resolve(extra.signal);
      await finish.promise;
      if (outcome === "error") throw new Error("ordinary handler failure");
      return {};
    });
    await server.connect(serverTransport);
    await clientTransport.start();
    await clientTransport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    const signal = await entered.promise;
    await clientTransport.send({
      jsonrpc: "2.0", method: "notifications/cancelled",
      params: { requestId: 1, reason: "user moved to another document" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.deepEqual(completed, [], "unfinished canceled work must retain admission");
    finish.resolve();
    await terminal.promise;
    assert.deepEqual(completed, [1]);
    assert.deepEqual(replies, [], "the SDK suppresses the canceled response");

    const nextReply = deferred();
    clientTransport.onmessage = (message) => nextReply.resolve(message);
    server.setRequestHandler(PingRequestSchema, () => ({}));
    await clientTransport.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    assert.equal((await nextReply.promise).id, 2);
    assert.deepEqual(completed, [1], "uncanceled requests use response-write admission cleanup");
  });
}

test("late cancellation retains admission until the pending write finishes", { timeout: 5_000 }, async (t) => {
  const server = new Server({ name: "ordinary-pending-write", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(() => server.close());
  const writeEntered = deferred();
  const finishWrite = deferred();
  const terminal = deferred();
  const completed = [];
  let signal;
  trackCanceledRequestCompletion(server, (id) => {
    completed.push(id);
    terminal.resolve();
  });
  server.setRequestHandler(PingRequestSchema, (_request, extra) => {
    signal = extra.signal;
    return {};
  });
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message) => {
    writeEntered.resolve();
    await finishWrite.promise;
    await send(message);
  };
  await server.connect(serverTransport);
  await clientTransport.start();
  await clientTransport.send({ jsonrpc: "2.0", id: 3, method: "ping" });
  await writeEntered.promise;
  await clientTransport.send({
    jsonrpc: "2.0", method: "notifications/cancelled",
    params: { requestId: 3, reason: "user closed the view" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.deepEqual(completed, []);
  finishWrite.resolve();
  await terminal.promise;
  assert.deepEqual(completed, [3]);
});
