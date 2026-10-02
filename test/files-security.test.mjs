import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chown,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  getDownloadDirectory,
  MAX_DOWNLOAD_FILES,
  MAX_DOWNLOAD_TOTAL_BYTES,
  MAX_PENDING_DOWNLOADS,
  savePdfSafely,
} from "../dist/download.js";
import { allowedRoots, loadDoc, resolveAllowed } from "../dist/local.js";
import { extractPdfSafely, shutdownPdfParsers } from "../dist/pdf.js";

const execFileAsync = promisify(execFile);

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "philosophy-security-test-"));
  const allowed = join(base, "allowed");
  const outside = join(base, "outside");
  await mkdir(allowed, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  return { base, allowed, outside };
}

function minimalPdf(pageCount) {
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`);
  objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`;
  for (let index = 0; index < pageCount; index++) {
    const pageObject = 3 + index * 2;
    const contentObject = pageObject + 1;
    objects[pageObject] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentObject} 0 R >>`;
    objects[contentObject] = "<< /Length 0 >>\nstream\n\nendstream";
  }

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let object = 1; object < objects.length; object++) {
    offsets[object] = Buffer.byteLength(pdf);
    pdf += `${object} 0 obj\n${objects[object]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let object = 1; object < objects.length; object++) {
    pdf += `${String(offsets[object]).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("local document roots are explicit, absolute, real directories", async (t) => {
  const { base, allowed } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  await assert.rejects(allowedRoots(""), /disabled/);
  await assert.rejects(allowedRoots("relative/path"), /absolute/);
  assert.deepEqual(await allowedRoots(allowed), [allowed]);
});

test("local document roots reject replaceable ancestors and configured symlinks", { skip: process.platform === "win32" }, async (t) => {
  const { base, outside } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));

  const mutableParent = join(base, "mutable-parent");
  const mutableRoot = join(mutableParent, "documents");
  await mkdir(mutableRoot, { recursive: true, mode: 0o700 });
  await chmod(mutableParent, 0o777);
  await assert.rejects(allowedRoots(mutableRoot), /unsafe/);

  const link = join(base, "linked-root");
  await symlink(outside, link, "dir");
  await assert.rejects(allowedRoots(link), /unsafe/);

  // Root can construct the cross-UID layout used by the original exchange
  // attack: a protected document root beneath an attacker-owned 0755 parent.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const foreignParent = join(base, "foreign-parent");
    const foreignRoot = join(foreignParent, "documents");
    await mkdir(foreignRoot, { recursive: true, mode: 0o700 });
    try {
      await chown(foreignParent, 65534, 65534);
      await assert.rejects(allowedRoots(foreignRoot), /unsafe/);
    } catch (error) {
      if (error?.code !== "EINVAL" && error?.code !== "EPERM") throw error;
      t.diagnostic("filesystem does not permit constructing a foreign-owned ancestor");
    }
  }
});

test("a pinned local document root is rejected after path replacement", async (t) => {
  const { base, allowed, outside } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const parked = join(base, "allowed-parked");

  assert.deepEqual(await allowedRoots(allowed), [allowed]);
  await rename(allowed, parked);
  await symlink(outside, allowed, "dir");
  await assert.rejects(allowedRoots(allowed), /replaced/);
});

test("local document paths reject writable or foreign-owned descendant directories", { skip: process.platform === "win32" }, async (t) => {
  const { base, allowed } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));

  const shared = join(allowed, "shared");
  await mkdir(shared, { mode: 0o700 });
  const note = join(shared, "notes.txt");
  await writeFile(note, "not safely confined", { mode: 0o600 });
  await chmod(shared, 0o777);
  await assert.rejects(resolveAllowed(note, [allowed]), /group\/world writable/);

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await chmod(shared, 0o755);
    try {
      await chown(shared, 65534, 65534);
      await assert.rejects(resolveAllowed(note, [allowed]), /untrusted owner/);
    } catch (error) {
      if (error?.code !== "EINVAL" && error?.code !== "EPERM") throw error;
      t.diagnostic("filesystem does not permit constructing a foreign-owned descendant");
    }
  }
});

test("allowed-path resolution rejects sibling prefixes, hidden paths, and symlink escapes", async (t) => {
  const { base, allowed, outside } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));

  const note = join(allowed, "notes.txt");
  await writeFile(note, "justice and knowledge", { mode: 0o600 });
  assert.equal(await resolveAllowed(note, [allowed]), note);

  const sibling = join(base, "allowed-evil");
  await mkdir(sibling, { mode: 0o700 });
  const siblingFile = join(sibling, "notes.txt");
  await writeFile(siblingFile, "outside");
  await assert.rejects(resolveAllowed(siblingFile, [allowed]), /outside/);

  const secret = join(outside, "secret.txt");
  await writeFile(secret, "sentinel");
  const link = join(allowed, "linked.txt");
  await symlink(secret, link);
  await assert.rejects(resolveAllowed(link, [allowed]), /outside/);

  const hiddenDirectory = join(allowed, ".aws");
  await mkdir(hiddenDirectory, { mode: 0o700 });
  const credentials = join(hiddenDirectory, "credentials.txt");
  await writeFile(credentials, "secret");
  await assert.rejects(resolveAllowed(credentials, [allowed]), /Hidden/);
});

test("extensionless and hidden files are never parsed as documents", async (t) => {
  const { base, allowed } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const extensionless = join(allowed, "id_rsa");
  await writeFile(extensionless, "PRIVATE KEY");
  await assert.rejects(loadDoc(extensionless), /explicit \.pdf/);

  const hidden = join(allowed, ".env");
  await writeFile(hidden, "TOKEN=secret");
  await assert.rejects(resolveAllowed(hidden, [allowed]), /Hidden/);
});

test("approved paths are revalidated when an intermediate directory is swapped", async (t) => {
  const { base, allowed, outside } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const sub = join(allowed, "sub");
  const parked = join(allowed, "sub-parked");
  await mkdir(sub, { mode: 0o700 });
  const approved = join(sub, "notes.txt");
  await writeFile(approved, "SAFE", { mode: 0o600 });
  assert.equal(await resolveAllowed(approved, [allowed]), approved);

  await writeFile(join(outside, "notes.txt"), "OUTSIDE_SECRET", { mode: 0o600 });
  await rename(sub, parked);
  await symlink(outside, sub, "dir");

  await assert.rejects(loadDoc(approved, [allowed]), /outside/);
});

test("ordinary text inside an allowed root remains readable", async (t) => {
  const { base, allowed } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const note = join(allowed, "notes.md");
  await writeFile(note, "# Ethics\n\nJustice matters.", { mode: 0o600 });
  const doc = await loadDoc(await resolveAllowed(note, [allowed]), [allowed]);
  assert.equal(doc.kind, "text");
  assert.match(doc.pages.join("\n"), /Justice matters/);
});

test("delimiter-heavy text is rejected before page-array amplification", async (t) => {
  const { base, allowed } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(allowed, "many-pages.txt");
  await writeFile(path, "\f".repeat(20_001), { mode: 0o600 });
  await assert.rejects(loadDoc(path, [allowed]), /page limit/);
});

test("FIFO paths fail without blocking a file-worker thread", { skip: process.platform === "win32" }, async (t) => {
  const { base, allowed } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const fifo = join(allowed, "blocked.txt");
  await execFileAsync("mkfifo", [fifo]);
  const started = performance.now();
  await assert.rejects(loadDoc(fifo, [allowed]), /regular file/);
  assert.ok(performance.now() - started < 2_000, "FIFO rejection blocked unexpectedly");
});

test("PDF downloads use private directories and exclusive random filenames", async (t) => {
  const { base } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const downloads = join(base, "downloads");
  await mkdir(downloads, { mode: 0o700 });
  await chmod(downloads, 0o700);
  assert.equal(await getDownloadDirectory(downloads), downloads);

  const pdf = Buffer.from("%PDF-1.4\nminimal test payload\n%%EOF\n");
  const first = await savePdfSafely("TEST-1", pdf, downloads);
  const second = await savePdfSafely("TEST-1", pdf, downloads);
  assert.notEqual(first, second);
  assert.deepEqual(await readFile(first), pdf);
  assert.equal((await lstat(first)).isSymbolicLink(), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(first)).mode & 0o777, 0o600);
  }
  await assert.rejects(savePdfSafely("../escape", pdf, downloads), /Unsafe record id/);
  await assert.rejects(savePdfSafely("TEST-2", Buffer.from("not a pdf"), downloads), /PDF header/);
});

test("configured download directories reject symlinks and unsafe permissions", async (t) => {
  const { base } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const real = join(base, "real-downloads");
  await mkdir(real, { mode: 0o700 });
  const link = join(base, "download-link");
  await symlink(real, link);
  await assert.rejects(getDownloadDirectory(link), /not a symlink/);

  if (process.platform !== "win32") {
    const unsafe = join(base, "unsafe-downloads");
    await mkdir(unsafe, { mode: 0o700 });
    await chmod(unsafe, 0o777);
    await assert.rejects(getDownloadDirectory(unsafe), /group\/world writable/);

    const mutableParent = join(base, "mutable-download-parent");
    const nested = join(mutableParent, "downloads");
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await chmod(mutableParent, 0o777);
    await assert.rejects(getDownloadDirectory(nested), /ancestor is group\/world writable/);
  }
});

test("download quotas include generated files left by earlier processes", async (t) => {
  const { base } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const downloads = join(base, "downloads");
  await mkdir(downloads, { mode: 0o700 });
  const pdf = Buffer.from("%PDF-1.4\nminimal test payload\n%%EOF\n");

  for (let i = 0; i < MAX_DOWNLOAD_FILES - 1; i += 1) {
    await writeFile(join(downloads, `OLD-${randomUUID()}.pdf`), pdf, { mode: 0o600 });
  }
  await writeFile(join(downloads, `.OLD.${randomUUID()}.part`), pdf, { mode: 0o600 });

  await assert.rejects(savePdfSafely("OVER-COUNT", pdf, downloads), /file.?limit/i);
});

test("download byte quota includes existing generated files", async (t) => {
  const { base } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const downloads = join(base, "downloads");
  await mkdir(downloads, { mode: 0o700 });
  const existing = join(downloads, `OLD-${randomUUID()}.pdf`);
  await writeFile(existing, "%PDF-1.4\n", { mode: 0o600 });
  await truncate(existing, MAX_DOWNLOAD_TOTAL_BYTES);

  const pdf = Buffer.from("%PDF-1.4\nminimal test payload\n%%EOF\n");
  await assert.rejects(savePdfSafely("OVER-BYTES", pdf, downloads), /aggregate limit/i);
});

test("concurrent PDF publications cannot race past the generated-file quota", async (t) => {
  const { base } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const downloads = join(base, "downloads");
  await mkdir(downloads, { mode: 0o700 });
  const pdf = Buffer.from("%PDF-1.4\nminimal test payload\n%%EOF\n");

  for (let i = 0; i < MAX_DOWNLOAD_FILES - 2; i += 1) {
    await writeFile(join(downloads, `OLD-${randomUUID()}.pdf`), pdf, { mode: 0o600 });
  }
  const results = await Promise.allSettled([
    savePdfSafely("PARALLEL-1", pdf, downloads),
    savePdfSafely("PARALLEL-2", pdf, downloads),
    savePdfSafely("PARALLEL-3", pdf, downloads),
    savePdfSafely("PARALLEL-4", pdf, downloads),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(results.filter((result) => result.status === "rejected").length, 2);
  const names = await readdir(downloads);
  assert.equal(names.filter((name) => name.endsWith(".pdf")).length, MAX_DOWNLOAD_FILES);
  assert.equal(names.some((name) => name.endsWith(".part")), false);
});

test("download publication queue rejects excess in-memory buffers", async (t) => {
  const { base } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const downloads = join(base, "downloads");
  await mkdir(downloads, { mode: 0o700 });
  const pdf = Buffer.from("%PDF-1.4\nminimal test payload\n%%EOF\n");

  const results = await Promise.allSettled(
    Array.from({ length: MAX_PENDING_DOWNLOADS + 2 }, (_, index) =>
      savePdfSafely(`QUEUED-${index}`, pdf, downloads),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    MAX_PENDING_DOWNLOADS,
  );
  const queueRejections = results.filter(
    (result) =>
      result.status === "rejected" &&
      /publication queue is full/i.test(String(result.reason?.message ?? result.reason)),
  );
  assert.equal(queueRejections.length, 2);
});

test("download publication rejects a directory replacement after opening its temp file", async (t) => {
  const { base, outside } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const downloads = join(base, "downloads");
  const parked = join(base, "downloads-parked");
  await mkdir(downloads, { mode: 0o700 });

  const probe = await open(join(base, "probe"), "w", 0o600);
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = fileHandlePrototype.sync;
  let releaseSync;
  let reachedSync;
  const syncReached = new Promise((resolve) => {
    reachedSync = resolve;
  });
  const syncReleased = new Promise((resolve) => {
    releaseSync = resolve;
  });
  fileHandlePrototype.sync = async function (...args) {
    const result = await originalSync.apply(this, args);
    reachedSync();
    await syncReleased;
    return result;
  };

  try {
    const pdf = Buffer.from("%PDF-1.4\nminimal test payload\n%%EOF\n");
    const saving = savePdfSafely("DIRECTORY-RACE", pdf, downloads);
    await syncReached;
    const part = (await readdir(downloads)).find((name) => name.endsWith(".part"));
    assert.ok(part);

    await rename(downloads, parked);
    await mkdir(downloads, { mode: 0o700 });
    await symlink(join(outside, "attacker-target"), join(downloads, part));
    releaseSync();
    await assert.rejects(saving, /directory was replaced/i);
    assert.equal((await lstat(join(downloads, part))).isSymbolicLink(), true);
    assert.equal((await readdir(downloads)).some((name) => name.endsWith(".pdf")), false);
  } finally {
    releaseSync();
    fileHandlePrototype.sync = originalSync;
  }
});

test("PDF extraction rejects documents over the configured page limit", async () => {
  const pdf = minimalPdf(2);
  await assert.rejects(
    extractPdfSafely(pdf, {
      mergePages: false,
      maxChars: 10_000,
      maxPages: 1,
      timeoutMs: 5_000,
    }),
    /PDF has 2 pages; the configured limit is 1 page/,
  );
});

test("PDF extraction admits one worker and bounds its wait queue", async () => {
  const pdf = minimalPdf(1);
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      extractPdfSafely(pdf, {
        mergePages: false,
        maxChars: 10_000,
        maxPages: 1,
        timeoutMs: 5_000,
      }),
    ),
  );
  const queueRejections = results.filter(
    (result) =>
      result.status === "rejected" &&
      /PDF extraction queue is full/.test(String(result.reason?.message ?? result.reason)),
  );
  assert.equal(queueRejections.length, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
});

test("malformed PDF parsing is isolated in a terminating process", async () => {
  await assert.rejects(
    extractPdfSafely(Buffer.from("%PDF-not-a-real-document"), {
      mergePages: true,
      maxChars: 10_000,
      timeoutMs: 5_000,
    }),
  );
});

test("PDF deadlines include queue wait and leave the parser usable", async () => {
  const slow = minimalPdf(1_000);
  const started = performance.now();
  const timed = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      extractPdfSafely(slow, {
        mergePages: false,
        maxChars: 100_000,
        maxPages: 1_000,
        timeoutMs: 10,
      }),
    ),
  );
  assert.equal(timed.every((result) => result.status === "rejected"), true);
  assert.ok(performance.now() - started < 500, "PDF queue ignored extraction deadlines");

  const recovered = await extractPdfSafely(minimalPdf(1), {
    mergePages: false,
    maxChars: 10_000,
    maxPages: 1,
    timeoutMs: 5_000,
  });
  assert.equal(recovered.totalPages, 1);
});

test("PDF parser subprocesses are killed during server shutdown", async () => {
  const pending = extractPdfSafely(minimalPdf(1_000), {
    mergePages: false,
    maxChars: 100_000,
    maxPages: 1_000,
    timeoutMs: 30_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await shutdownPdfParsers();
  await assert.rejects(pending);
});
