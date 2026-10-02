import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  hostAllowlistPolicy,
  isPublicIp,
  NetworkSecurityError,
  parsePublicHttpUrl,
  pinnedLookup,
  readStreamLimited,
  resolvePublicAddresses,
  resolveRedirectTarget,
  ResponseTooLargeError,
  secureRequest,
} from "../dist/net.js";
import {
  htmlToText,
  normalizeArchiveIdentifier,
  normalizeSepEntry,
  normalizeWikisourceLang,
  parseSepIndex,
} from "../dist/books.js";
import { LruCache } from "../dist/textwindow.js";
import { parseJsonSafely, parseXmlSafely } from "../dist/xml.js";

test("HTML stripping remains linear on repeated unclosed tags", () => {
  const hostile = "<script>".repeat(65_536);
  const started = performance.now();
  assert.equal(htmlToText(hostile), "");
  assert.ok(performance.now() - started < 2_000, "hostile HTML took too long to strip");
});

test("HTML scanners preserve Unicode text and original offsets", () => {
  assert.equal(htmlToText("<nav>İ</nav>Ethics"), "Ethics");
  assert.equal(htmlToText("<NAV>İ</NAV><P>İ Ethics</P><p>Justice</p>"), "İ Ethics\n\nJustice");
  assert.equal(htmlToText("<nav>I</nav>Ethics"), "Ethics");
  assert.deepEqual(
    parseSepIndex('İ <A HREF="entries/ethics/">İ Ethics</A><a href="entries/justice/">Justice</a>'),
    [
      ["İ Ethics", "https://plato.stanford.edu/entries/ethics/"],
      ["Justice", "https://plato.stanford.edu/entries/justice/"],
    ],
  );
});

test("metadata XML parsing is worker-isolated and input-bounded", async () => {
  assert.deepEqual(await parseXmlSafely("<root><value>ethics</value></root>"), {
    root: { value: "ethics" },
  });
  await assert.rejects(parseXmlSafely("x".repeat(2 * 1024 * 1024 + 1)), /XML input.*limit/);
  await assert.rejects(
    parseJsonSafely(JSON.stringify(Array.from({ length: 50_001 }, () => 0))),
    /too many values/,
  );
});

test("metadata deadlines include queue wait and leave the worker usable", async () => {
  const source = `<root>${"<v>x</v>".repeat(40_000)}</root>`;
  const started = performance.now();
  const timed = await Promise.allSettled(
    Array.from({ length: 5 }, () => parseXmlSafely(source, { timeoutMs: 5 })),
  );
  assert.equal(timed.every((result) => result.status === "rejected"), true);
  assert.ok(performance.now() - started < 500, "metadata queue ignored parser deadlines");
  assert.deepEqual(await parseJsonSafely('{"ok":true}', { timeoutMs: 5_000 }), { ok: true });
});

test("public-address policy rejects private, mapped, transition, and reserved ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:7f00:1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("unusual IPv4 spellings normalize and are rejected before DNS", async () => {
  for (const raw of ["http://2130706433/", "http://0x7f000001/", "http://127.1/"]) {
    const url = parsePublicHttpUrl(raw);
    assert.equal(url.hostname, "127.0.0.1");
    await assert.rejects(resolvePublicAddresses(url), NetworkSecurityError);
  }
});

test("mixed public and private DNS results fail closed", async () => {
  const url = parsePublicHttpUrl("https://example.test/");
  await assert.rejects(
    resolvePublicAddresses(url, async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    /non-public address/,
  );
});

test("pinned lookup returns only prevalidated addresses", async () => {
  const lookup = pinnedLookup([
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  const all = await new Promise((resolve, reject) => {
    lookup("ignored.invalid", { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    );
  });
  assert.deepEqual(all, [
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
});

test("host policy uses exact domain boundaries and HTTPS", async () => {
  const policy = hostAllowlistPolicy(["archive.org"], { allowSubdomains: true });
  await policy(new URL("https://archive.org/x"));
  await policy(new URL("https://ia801.archive.org/x"));
  await assert.rejects(async () => policy(new URL("https://archive.org.evil.test/x")));
  await assert.rejects(async () => policy(new URL("http://archive.org/x")));
  await assert.rejects(async () => policy(new URL("https://archive.org:8443/x")));
});

test("redirect targets reject private hosts, unsafe schemes, and downgrade", () => {
  const current = new URL("https://example.com/path");
  for (const target of [
    "http://127.0.0.1/",
    "http://[::ffff:7f00:1]/",
    "file:///etc/passwd",
    "http://example.com/",
  ]) {
    assert.throws(() => resolveRedirectTarget(current, target), NetworkSecurityError);
  }
  assert.equal(
    resolveRedirectTarget(current, "/next").toString(),
    "https://example.com/next",
  );
});

test("Wikisource language normalization closes host injection", () => {
  assert.equal(normalizeWikisourceLang("EN"), "en");
  assert.equal(normalizeWikisourceLang("zh-min-nan"), "zh-min-nan");
  for (const value of [
    "evil.example/path?x=",
    "en.evil",
    "en/path",
    "en@evil",
    "127.0.0.1",
    "-en",
    "en-",
    "en--x",
  ]) {
    assert.throws(() => normalizeWikisourceLang(value), NetworkSecurityError, value);
  }
});

test("SEP inputs canonicalize to one exact entry URL", () => {
  assert.equal(normalizeSepEntry("hegel"), "https://plato.stanford.edu/entries/hegel/");
  assert.equal(
    normalizeSepEntry("/entries/hegel/"),
    "https://plato.stanford.edu/entries/hegel/",
  );
  assert.equal(
    normalizeSepEntry("https://plato.stanford.edu/entries/hegel/"),
    "https://plato.stanford.edu/entries/hegel/",
  );
  for (const value of [
    "//evil.test/x",
    "/\\evil.test/x",
    "///evil.test/x",
    "/entries/../contents.html",
    "/entries/hegel%2fextra/",
    "http://plato.stanford.edu/entries/hegel/",
    "https://plato.stanford.edu.evil.test/entries/hegel/",
    "https://user@plato.stanford.edu/entries/hegel/",
    "https://plato.stanford.edu:444/entries/hegel/",
    "/contents.html",
  ]) {
    assert.throws(() => normalizeSepEntry(value), NetworkSecurityError, value);
  }
});

test("Internet Archive identifiers cannot alter the request path", () => {
  assert.equal(normalizeArchiveIdentifier("kant_critique-01"), "kant_critique-01");
  assert.equal(normalizeArchiveIdentifier("a".repeat(100)), "a".repeat(100));
  for (const value of ["../secret", "x/y", "x?next=", "x#fragment", "@evil", "a".repeat(101)]) {
    assert.throws(() => normalizeArchiveIdentifier(value), NetworkSecurityError, value);
  }
});

test("stream reader enforces actual bytes without trusting Content-Length", async () => {
  assert.equal(
    (await readStreamLimited(Readable.from([Buffer.from("abc"), Buffer.from("de")]), 5)).toString(),
    "abcde",
  );
  await assert.rejects(
    readStreamLimited(Readable.from([Buffer.from("abc"), Buffer.from("def")]), 5),
    ResponseTooLargeError,
  );
});

test("outbound request deadlines include queue admission", async () => {
  const slowResolver = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve([{ address: "8.8.8.8", family: 4 }]), 100),
    );
  const blockers = Array.from({ length: 8 }, () =>
    secureRequest("https://queue-timeout.invalid/", {
      maxBytes: 1,
      timeoutMs: 50,
      resolver: slowResolver,
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const started = performance.now();
  await assert.rejects(
    secureRequest("https://queue-timeout.invalid/", {
      maxBytes: 1,
      timeoutMs: 10,
      resolver: slowResolver,
    }),
    /admission timed out/,
  );
  assert.ok(performance.now() - started < 200, "queued request ignored its deadline");
  await Promise.allSettled(blockers);
});

test("LRU cache enforces both entry and byte budgets", () => {
  const cache = new LruCache(3, 5, (value) => value.length);
  cache.set("a", "aa");
  cache.set("b", "bb");
  cache.set("c", "cc");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.weight, 4);
  cache.set("huge", "123456");
  assert.equal(cache.get("huge"), undefined);
});
