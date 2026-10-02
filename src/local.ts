/**
 * Local document tools — read large local files (a 700-page PDF, a long .txt)
 * without pulling the whole thing into the model's context.
 *
 * The motivation is token economy: feeding an entire long document into an
 * agent and then re-sending it every turn is what burns through usage. These
 * tools let the model work the way a person skims a thick book — get an outline,
 * jump to the relevant pages by searching, and read a bounded chunk at a time —
 * so only the parts that matter ever reach the context.
 *
 * Self-contained (own helpers) so it composes onto the server without touching
 * its code. Registered via registerLocalTools(server).
 *
 * Tools:
 *   - local_doc_info    overview: pages, chars, ~tokens, heuristic outline
 *   - local_doc_search  find literal passages → snippets + page numbers
 *   - local_doc_read    read a page range / chunk, capped so it can't flood context
 *
 * Security: local access is disabled until PHILOSOPHY_DOC_ROOTS contains one or
 * more delimiter-separated absolute directories. Paths are real-path resolved,
 * opened without following a final symlink, checked as regular files, and read
 * under a byte limit.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { LruCache } from "./textwindow.js";
import { extractPdfSafely } from "./pdf.js";

// ---------------------------------------------------------------------------
// Small helpers (kept local so this module stays self-contained)
// ---------------------------------------------------------------------------

function ok(text: string) {
  const bounded =
    text.length <= 150_000
      ? text
      : `${text.slice(0, 150_000)}\n\n[output truncated at 150,000 characters]`;
  return { content: [{ type: "text" as const, text: bounded }] };
}
function fail(text: string) {
  const bounded = text.length <= 16_000 ? text : `${text.slice(0, 16_000)}…`;
  return { content: [{ type: "text" as const, text: bounded }], isError: true };
}

/** Same whitespace tidy-up the PDF path in index.ts uses. */
function cleanText(s: string): string {
  return String(s ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function envByteLimit(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum} bytes.`);
  }
  return parsed;
}

function envIntegerLimit(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

/** Rough token estimate — ~4 chars per token is close enough for a heads-up. */
function estTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Build a case-insensitive matcher without giving user input regex semantics. */
function caseInsensitiveLiteral(input: string): RegExp {
  const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "giu");
}

// ---------------------------------------------------------------------------
// Path allowlist
// ---------------------------------------------------------------------------

/** Real-path-resolved roots explicitly configured by PHILOSOPHY_DOC_ROOTS. */
interface PinnedRoot {
  configured: string;
  canonical: string;
  dev: number;
  ino: number;
}

const pinnedRootConfigurations = new Map<string, Promise<PinnedRoot[]>>();

async function validateRootAncestors(canonical: string): Promise<void> {
  if (typeof process.getuid !== "function") return;
  const currentUid = process.getuid();
  let current = canonical;
  while (true) {
    const parent = dirname(current);
    if (parent === current) break;
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Document-root ancestor is not a stable real directory: ${parent}`);
    }
    // A differently owned ancestor can be renamed by its owner even when its
    // mode is 0755.  That would let another account exchange the pinned root
    // with a sibling between our checks.  Root-owned ancestors are trusted;
    // all others must belong to this process' effective account.
    if (info.uid !== currentUid && info.uid !== 0) {
      throw new Error(`Document-root ancestor has an untrusted owner: ${parent}`);
    }
    const writableByOthers = (info.mode & 0o022) !== 0;
    const sticky = (info.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) {
      throw new Error(`Document-root ancestor is group/world writable: ${parent}`);
    }
    current = parent;
  }
}

async function initializeRoots(raw: string[]): Promise<PinnedRoot[]> {
  const out: PinnedRoot[] = [];
  for (const r of raw) {
    if (!isAbsolute(r)) {
      throw new Error(`PHILOSOPHY_DOC_ROOTS entries must be absolute paths (got "${r}").`);
    }
    try {
      const configured = resolve(r);
      const entry = await lstat(configured);
      if (entry.isSymbolicLink()) throw new Error("root entry is a symlink");
      const canonical = await realpath(configured);
      const st = await stat(canonical);
      if (!st.isDirectory()) throw new Error("not a directory");
      if (canonical === parse(canonical).root) throw new Error("filesystem root is not allowed");
      if (typeof process.getuid === "function") {
        if (st.uid !== process.getuid()) throw new Error("root is not owned by the current user");
        if ((st.mode & 0o022) !== 0) throw new Error("root is group/world writable");
      }
      await validateRootAncestors(canonical);
      out.push({ configured, canonical, dev: st.dev, ino: st.ino });
    } catch {
      throw new Error(`Configured document root is unsafe, missing, or not a real directory: ${r}`);
    }
  }
  return out.filter(
    (root, index, roots) => roots.findIndex((candidate) => candidate.canonical === root.canonical) === index,
  );
}

export async function allowedRoots(
  configured = process.env.PHILOSOPHY_DOC_ROOTS,
): Promise<string[]> {
  const raw = (configured?.split(delimiter) ?? []).map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) {
    throw new Error(
      "Local document access is disabled. Set PHILOSOPHY_DOC_ROOTS to one or more " +
        "absolute, dedicated document directories to enable it.",
    );
  }
  if (process.platform === "win32") {
    throw new Error(
      "Local document access is unavailable on Windows because Node cannot enforce the " +
        "required owner, permission, and descriptor-path checks; refusing to weaken confinement.",
    );
  }
  if (raw.length > 64 || raw.some((entry) => entry.length > 4096)) {
    throw new Error("PHILOSOPHY_DOC_ROOTS contains too many or overlong entries.");
  }
  const key = raw.map((entry) => resolve(entry)).join("\0");
  let pending = pinnedRootConfigurations.get(key);
  if (!pending) {
    pending = initializeRoots(raw);
    pinnedRootConfigurations.set(key, pending);
    void pending.catch(() => pinnedRootConfigurations.delete(key));
  }
  const roots = await pending;
  for (const root of roots) {
    const entry = await lstat(root.configured);
    if (entry.isSymbolicLink()) throw new Error(`Configured document root was replaced: ${root.configured}`);
    const canonical = await realpath(root.configured);
    const current = await stat(canonical);
    if (
      canonical !== root.canonical ||
      current.dev !== root.dev ||
      current.ino !== root.ino ||
      !current.isDirectory()
    ) {
      throw new Error(`Configured document root was replaced: ${root.configured}`);
    }
  }
  return roots.map((root) => root.canonical);
}

/**
 * Resolve a client-supplied path to a real absolute path and verify it sits
 * under an allowed root. realpath() follows symlinks before the check, so a link
 * inside an allowed root that points outside it is rejected.
 */
export async function resolveAllowed(input: string, roots?: string[]): Promise<string> {
  if (!input || !input.trim()) throw new Error("No file path given.");
  if (!isAbsolute(input.trim())) throw new Error("Local document paths must be absolute.");
  const resolved = resolve(input.trim());
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    throw new Error(`File not found or unreadable: ${resolved}`);
  }
  const permittedRoots = roots ?? (await allowedRoots());
  await assertTrustedAllowedPath(real, permittedRoots);
  return real;
}

/** Verify a canonical path is contained by one of the configured roots. */
function assertCanonicalAllowed(real: string, permittedRoots: string[]): string {
  const matchedRoot = permittedRoots.find((root) => {
    const rel = relative(root, real);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
  if (!matchedRoot) {
    throw new Error(
      `Path "${real}" is outside the configured document roots (${permittedRoots.join(", ")}).`,
    );
  }
  const pathWithinRoot = relative(matchedRoot, real);
  if (pathWithinRoot.split(sep).some((part) => part.startsWith("."))) {
    throw new Error("Hidden files and hidden directories are not readable.");
  }
  return matchedRoot;
}

/**
 * Reject path components another account could rename. Checking only the
 * configured root is insufficient: a foreign-owned or group/world-writable
 * descendant directory could exchange an outside inode into an allowed name
 * while the file is opened. Root and current-user ownership are trusted.
 */
async function assertTrustedAllowedPath(real: string, permittedRoots: string[]): Promise<void> {
  const matchedRoot = assertCanonicalAllowed(real, permittedRoots);
  if (typeof process.getuid !== "function") return;
  const currentUid = process.getuid();
  let current = dirname(real);
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Document path component is not a stable real directory: ${current}`);
    }
    if (info.uid !== currentUid && info.uid !== 0) {
      throw new Error(`Document path component has an untrusted owner: ${current}`);
    }
    if ((info.mode & 0o022) !== 0) {
      throw new Error(`Document path component is group/world writable: ${current}`);
    }
    if (current === matchedRoot) return;
    const parent = dirname(current);
    if (parent === current || relative(matchedRoot, parent).startsWith(`..${sep}`)) {
      throw new Error("Document path changed outside its configured root.");
    }
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// Loading + paginating documents (with an mtime-keyed cache)
// ---------------------------------------------------------------------------

interface Doc {
  /** Per-page text. For PDFs these are real pages; for text, virtual pages. */
  pages: string[];
  kind: "pdf" | "text";
  /** true when text was split into fixed-size virtual pages (no real page breaks). */
  synthetic: boolean;
  mtimeMs: number;
  ctimeMs: number;
  bytes: number;
  dev: number;
  ino: number;
  mode: number;
}

const MAX_LOCAL_FILE_BYTES = envByteLimit(
  "PHILOSOPHY_MAX_LOCAL_FILE_BYTES",
  32 * 1024 * 1024,
  64 * 1024,
  256 * 1024 * 1024,
);
const MAX_LOCAL_CACHE_BYTES = envByteLimit(
  "PHILOSOPHY_MAX_LOCAL_CACHE_BYTES",
  64 * 1024 * 1024,
  64 * 1024,
  512 * 1024 * 1024,
);
const MAX_EXTRACTED_CHARS = envByteLimit(
  "PHILOSOPHY_MAX_EXTRACTED_CHARS",
  20_000_000,
  10_000,
  100_000_000,
);
const MAX_DOCUMENT_PAGES = envIntegerLimit(
  "PHILOSOPHY_MAX_DOCUMENT_PAGES",
  20_000,
  1,
  100_000,
);
const CACHE = new LruCache<Doc>(4, MAX_LOCAL_CACHE_BYTES, (doc) => {
  // Include an allowance for each JS string/array entry so delimiter-heavy
  // documents cannot have a near-zero cache weight.
  return doc.pages.reduce((total, page) => total + Buffer.byteLength(page) + 256, 0);
});
const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".text", ".org", ".rst", ".tex"]);
const MAX_ACTIVE_LOADS = 2;
const MAX_QUEUED_LOADS = 8;
let activeLoads = 0;
const loadWaiters: Array<() => void> = [];
const inFlightLoads = new Map<string, Promise<Doc>>();

async function acquireLoadSlot(): Promise<() => void> {
  if (activeLoads < MAX_ACTIVE_LOADS) {
    activeLoads++;
  } else {
    if (loadWaiters.length >= MAX_QUEUED_LOADS) {
      throw new Error("Too many local documents are being loaded; try again later.");
    }
    await new Promise<void>((resolve) => loadWaiters.push(resolve));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = loadWaiters.shift();
    if (next) next();
    else activeLoads--;
  };
}

async function readRegularFileLimited(real: string, permittedRoots: string[]): Promise<{
  buffer: Buffer;
  mtimeMs: number;
  ctimeMs: number;
  bytes: number;
  dev: number;
  ino: number;
  mode: number;
}> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  // O_NONBLOCK ensures an allowed-root FIFO cannot pin a libuv worker before
  // fstat has a chance to reject it as non-regular.
  const handle = await open(real, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Local document path is not a regular file.");

    // Bind the path allowlist decision to the descriptor we actually opened.
    // An attacker may replace an intermediate directory with a symlink between
    // resolveAllowed() and open(); re-resolve after open, re-check containment,
    // and require the path to still identify this descriptor's inode.
    const verifyOpenedPath = async () => {
      if (process.platform === "linux") {
        let descriptorTarget: string;
        try {
          descriptorTarget = await realpath(`/proc/self/fd/${handle.fd}`);
        } catch {
          throw new Error("Unable to verify the opened document descriptor; refusing the read.");
        }
        await assertTrustedAllowedPath(descriptorTarget, permittedRoots);
        return;
      }

      // Node does not expose openat2/fcntl(F_GETPATH) portably. On non-Linux
      // systems, re-resolve and compare the path to the already-open inode.
      let canonical: string;
      try {
        canonical = await realpath(real);
      } catch {
        throw new Error("Local document path changed while it was being opened; retry the request.");
      }
      await assertTrustedAllowedPath(canonical, permittedRoots);
      const current = await stat(canonical);
      if (current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new Error("Local document changed while it was being opened; retry the request.");
      }
    };
    await verifyOpenedPath();
    if (opened.size > MAX_LOCAL_FILE_BYTES) {
      throw new Error(
        `Local document is ${opened.size.toLocaleString()} bytes; the configured limit is ` +
          `${MAX_LOCAL_FILE_BYTES.toLocaleString()} bytes.`,
      );
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    while (true) {
      const remaining = MAX_LOCAL_FILE_BYTES + 1 - total;
      if (remaining <= 0) throw new Error("Local document grew beyond the configured byte limit.");
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    if (total > MAX_LOCAL_FILE_BYTES) {
      throw new Error("Local document exceeds the configured byte limit.");
    }

    await verifyOpenedPath();
    return {
      buffer: Buffer.concat(chunks, total),
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      bytes: total,
      dev: opened.dev,
      ino: opened.ino,
      mode: opened.mode,
    };
  } finally {
    await handle.close();
  }
}

/** Split plain text into virtual pages: on form-feeds if present, else ~4 KB blocks. */
function paginateText(s: string): { pages: string[]; synthetic: boolean } {
  if (s.includes("\f")) {
    const pages: string[] = [];
    let start = 0;
    while (true) {
      if (pages.length >= MAX_DOCUMENT_PAGES) {
        throw new Error(
          `Document exceeds the ${MAX_DOCUMENT_PAGES.toLocaleString()}-page limit.`,
        );
      }
      const end = s.indexOf("\f", start);
      pages.push(cleanText(s.slice(start, end === -1 ? s.length : end)));
      if (end === -1) break;
      start = end + 1;
    }
    return { pages, synthetic: false };
  }
  const TARGET = 4000;
  const pages: string[] = [];
  let start = 0;
  while (start < s.length) {
    if (pages.length >= MAX_DOCUMENT_PAGES) {
      throw new Error(
        `Document exceeds the ${MAX_DOCUMENT_PAGES.toLocaleString()}-page limit.`,
      );
    }
    let end = Math.min(s.length, start + TARGET);
    if (end < s.length) {
      const newline = s.lastIndexOf("\n", end);
      if (newline >= start) end = newline + 1;
    }
    if (end <= start) end = Math.min(s.length, start + TARGET);
    pages.push(cleanText(s.slice(start, end)));
    start = end;
  }
  return { pages: pages.length ? pages : [""], synthetic: true };
}

/** Load + paginate a document, reusing the cache when the file is unchanged. */
async function loadDocOnce(real: string, permittedRoots: string[]): Promise<Doc> {
  const release = await acquireLoadSlot();
  try {
    const st = await stat(real);
    const cached = CACHE.get(real);
    if (
      cached &&
      cached.mtimeMs === st.mtimeMs &&
      cached.ctimeMs === st.ctimeMs &&
      cached.bytes === st.size &&
      cached.dev === st.dev &&
      cached.ino === st.ino &&
      cached.mode === st.mode
    ) {
      return cached;
    }
    if (cached) CACHE.delete(real);

    const ext = extname(real).toLowerCase();
    const opened = await readRegularFileLimited(real, permittedRoots);
    const metadata = {
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      bytes: opened.bytes,
      dev: opened.dev,
      ino: opened.ino,
      mode: opened.mode,
    };
    let doc: Doc;
    if (ext === ".pdf") {
      if (!opened.buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
        throw new Error("File has a .pdf extension but does not contain a PDF header.");
      }
      const extracted = await extractPdfSafely(opened.buffer, {
        mergePages: false,
        maxChars: MAX_EXTRACTED_CHARS,
        maxPages: MAX_DOCUMENT_PAGES,
      });
      // mergePages:false keeps page boundaries so search/read can cite page numbers.
      const pages = (extracted.pages ?? []).map(cleanText);
      doc = { pages, kind: "pdf", synthetic: false, ...metadata };
    } else if (TEXT_EXTS.has(ext)) {
      const s = opened.buffer.toString("utf8");
      if (s.length > MAX_EXTRACTED_CHARS) {
        throw new Error(
          `Document text exceeds the ${MAX_EXTRACTED_CHARS.toLocaleString()}-character limit.`,
        );
      }
      const { pages, synthetic } = paginateText(s);
      doc = { pages, kind: "text", synthetic, ...metadata };
    } else {
      throw new Error(
        `Unsupported file type "${ext || "(none)"}" — this tool reads .pdf and plain-text files.`,
      );
    }
    CACHE.set(real, doc);
    return doc;
  } finally {
    release();
  }
}

export async function loadDoc(real: string, roots?: string[]): Promise<Doc> {
  const ext = extname(real).toLowerCase();
  if (!ext || basename(real).startsWith(".")) {
    throw new Error("Only explicit .pdf or supported plain-text file extensions are readable.");
  }
  const permittedRoots = roots ?? (await allowedRoots());
  const canonical = await realpath(real);
  await assertTrustedAllowedPath(canonical, permittedRoots);
  const existing = inFlightLoads.get(canonical);
  if (existing) return await existing;
  const pending = loadDocOnce(canonical, permittedRoots);
  inFlightLoads.set(canonical, pending);
  try {
    return await pending;
  } finally {
    if (inFlightLoads.get(canonical) === pending) inFlightLoads.delete(canonical);
  }
}

function docChars(doc: Doc): number {
  return doc.pages.reduce((n, p) => n + p.length, 0);
}

// ---------------------------------------------------------------------------
// Outline detection
// ---------------------------------------------------------------------------

const HEADING_RES = [
  /^#{1,6}\s+\S/, // markdown heading
  /^(chapter|section|part|appendix|book|preface|introduction|conclusion|bibliography|references|abstract)\b/i,
  /^\s*\d+(\.\d+)*\.?\s+\p{L}/u, // numbered: "1. Title", "2.3 Title"
];

function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 2 || t.length > 90) return false;
  if (/[.,;:]$/.test(t)) return false; // sentence-like → not a heading
  if (HEADING_RES.some((re) => re.test(t))) return true;
  // Short ALL-CAPS line (e.g. "PHENOMENAL CONSCIOUSNESS").
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (
    letters.length >= 3 &&
    letters === letters.toUpperCase() &&
    t.split(/\s+/).length <= 12
  ) {
    return true;
  }
  return false;
}

function buildOutline(doc: Doc, max: number): Array<{ page: number; text: string }> {
  const out: Array<{ page: number; text: string }> = [];
  let last = "";
  let linesInspected = 0;
  for (let p = 0; p < doc.pages.length && out.length < max; p++) {
    const page = doc.pages[p];
    let start = 0;
    let pageLines = 0;
    while (start <= page.length && pageLines < 20_000 && linesInspected < 200_000) {
      const newline = page.indexOf("\n", start);
      const line = page.slice(start, newline === -1 ? page.length : newline);
      pageLines++;
      linesInspected++;
      const t = line.trim();
      if (t && t !== last && looksLikeHeading(t)) {
        out.push({ page: p + 1, text: t.replace(/^#{1,6}\s+/, "") });
        last = t;
        if (out.length >= max) break;
      }
      if (newline === -1) break;
      start = newline + 1;
    }
    if (linesInspected >= 200_000) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerLocalTools(server: McpServer): void {
  server.registerTool(
    "local_doc_info",
    {
      title: "Local document overview",
      description:
        "Open a local PDF or plain-text file and return a cheap overview — page count, " +
        "character count, an estimated token count, and a heuristic outline (detected " +
        "headings with their page numbers) — WITHOUT dumping the whole document into context. " +
        "Use this first on a long file, then local_doc_search to jump to relevant pages and " +
        "local_doc_read to read a chunk. Local access is disabled until the server is started " +
        "with explicit PHILOSOPHY_DOC_ROOTS.",
      inputSchema: {
        path: z.string().trim().min(1).max(4096).describe("Absolute path to a local .pdf or supported text file."),
        max_headings: z
          .number()
          .int()
          .min(1)
          .max(300)
          .default(60)
          .describe("Max outline headings to return (default 60)."),
      },
    },
    async ({ path, max_headings }) => {
      try {
        const roots = await allowedRoots();
        const real = await resolveAllowed(path, roots);
        const doc = await loadDoc(real, roots);
        const chars = docChars(doc);
        const outline = buildOutline(doc, max_headings);

        const kindLabel =
          doc.kind === "pdf"
            ? `PDF, ${doc.pages.length} page(s)`
            : `Text, ${doc.pages.length} ${doc.synthetic ? "virtual " : ""}page(s)` +
              (doc.synthetic ? " (~4 KB each — no real page breaks)" : "");

        const head = [
          `File: ${real}`,
          `Type: ${kindLabel}`,
          `Size: ${(doc.bytes / 1024).toFixed(1)} KiB on disk · ${chars.toLocaleString()} text chars · ~${estTokens(chars).toLocaleString()} tokens`,
        ];
        const body =
          outline.length > 0
            ? [
                "",
                `Outline (${outline.length} heading(s)):`,
                ...outline.map((h) => `  [p.${h.page}] ${h.text}`),
              ]
            : ["", "Outline: (no headings detected)"];
        const hint = [
          "",
          `Next: local_doc_search("${real}", "<keyword>") to find relevant pages, ` +
            `then local_doc_read("${real}", page_from=N) to read a chunk.`,
        ];
        if (chars === 0) {
          body.push("", "(no extractable text — the PDF may be image-only / scanned)");
        }
        return ok([...head, ...body, ...hint].join("\n"));
      } catch (e: any) {
        return fail(`local_doc_info failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "local_doc_search",
    {
      title: "Search inside a local document",
      description:
        "Search a local PDF or text file for a literal keyword or phrase and return only the " +
        "matching passages — each as a short snippet with surrounding context and its page number — " +
        "instead of the whole document. This is the token-efficient way to answer a question about " +
        "a long file: find the handful of relevant pages, then local_doc_read just those. Only files " +
        "under the allowed roots can be opened.",
      inputSchema: {
        path: z.string().trim().min(1).max(4096).describe("Path to a local .pdf or text file."),
        query: z.string().min(1).max(1000).describe("Literal keyword or phrase to find."),
        is_regex: z
          .boolean()
          .default(false)
          .describe("Deprecated. Regular-expression search is disabled to prevent denial of service."),
        ignore_case: z.boolean().default(true).describe("Case-insensitive matching (default true)."),
        context_chars: z
          .number()
          .int()
          .min(0)
          .max(2000)
          .default(160)
          .describe("Characters of context to show on each side of a match (default 160)."),
        max_matches: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe("Max matching snippets to return (default 20)."),
        max_chars: z
          .number()
          .int()
          .min(500)
          .max(50_000)
          .default(8000)
          .describe("Overall cap on returned text so results can't flood context (default 8000)."),
      },
    },
    async ({ path, query, is_regex, ignore_case, context_chars, max_matches, max_chars }) => {
      try {
        if (is_regex) {
          return fail(
            "Regular-expression search is disabled because JavaScript regexes can block the MCP " +
              "process. Search for a literal keyword or phrase instead.",
          );
        }
        const roots = await allowedRoots();
        const real = await resolveAllowed(path, roots);
        const doc = await loadDoc(real, roots);

        // Collect a bit beyond the display cap so we can tell the user there's more.
        const hardCap = max_matches * 3;
        const hits: Array<{ page: number; snippet: string }> = [];
        let truncatedCollection = false;

        outer: for (let p = 0; p < doc.pages.length; p++) {
          const text = doc.pages[p];
          const matcher = ignore_case ? caseInsensitiveLiteral(query) : undefined;
          let position = 0;
          let perPage = 0;
          while (position <= text.length) {
            let matchAt: number;
            let matchLength: number;
            if (matcher) {
              matcher.lastIndex = position;
              const match = matcher.exec(text);
              matchAt = match?.index ?? -1;
              matchLength = match?.[0].length ?? 0;
            } else {
              matchAt = text.indexOf(query, position);
              matchLength = query.length;
            }
            if (matchAt === -1) break;
            const start = Math.max(0, matchAt - context_chars);
            const end = Math.min(text.length, matchAt + matchLength + context_chars);
            const snippet =
              (start > 0 ? "…" : "") +
              text.slice(start, end).replace(/\s+/g, " ").trim() +
              (end < text.length ? "…" : "");
            hits.push({ page: p + 1, snippet });

            position = matchAt + Math.max(1, matchLength);
            if (++perPage >= 50) break; // don't let one page dominate
            if (hits.length >= hardCap) {
              truncatedCollection = true;
              break outer;
            }
          }
        }

        if (hits.length === 0) {
          return ok(`No matches for "${query}" in ${basename(real)}.`);
        }

        const shown: string[] = [];
        let budget = max_chars;
        let cutByChars = false;
        for (const h of hits.slice(0, max_matches)) {
          const line = `[p.${h.page}] ${h.snippet}`;
          if (line.length > budget && shown.length > 0) {
            cutByChars = true;
            break;
          }
          shown.push(line);
          budget -= line.length + 1;
        }

        const more =
          truncatedCollection || hits.length > shown.length || cutByChars
            ? " (more matches exist — refine the query or read the cited pages)"
            : "";
        const header =
          `${hits.length}${truncatedCollection ? "+" : ""} match(es) for "${query}" ` +
          `in ${basename(real)}; showing ${shown.length}${more}.`;
        return ok([header, "", ...shown].join("\n"));
      } catch (e: any) {
        return fail(`local_doc_search failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "local_doc_read",
    {
      title: "Read a page range of a local document",
      description:
        "Read a bounded slice of a local PDF or text file — a page range starting at page_from — and " +
        "return it with page markers, capped at max_chars so it can't flood context. Omitting page_to " +
        "reads forward from page_from until the cap is hit and reports the next page to continue from, " +
        "which makes it easy to walk a long document chunk-by-chunk (e.g. to summarize it section by " +
        "section). Only files under the allowed roots can be opened.",
      inputSchema: {
        path: z.string().trim().min(1).max(4096).describe("Path to a local .pdf or text file."),
        page_from: z
          .number()
          .int()
          .min(1)
          .max(MAX_DOCUMENT_PAGES)
          .default(1)
          .describe("First page to read (1-based, default 1)."),
        page_to: z
          .number()
          .int()
          .min(1)
          .max(MAX_DOCUMENT_PAGES)
          .optional()
          .describe("Last page to read (1-based, inclusive). Omit to read forward until max_chars."),
        max_chars: z
          .number()
          .int()
          .min(500)
          .max(100_000)
          .default(12_000)
          .describe("Cap on returned text (default 12000). Reading stops at this many chars."),
      },
    },
    async ({ path, page_from, page_to, max_chars }) => {
      try {
        const roots = await allowedRoots();
        const real = await resolveAllowed(path, roots);
        const doc = await loadDoc(real, roots);
        const total = doc.pages.length;
        if (page_from > total) {
          return fail(`page_from ${page_from} is past the end (document has ${total} page(s)).`);
        }
        const start = Math.min(Math.max(1, page_from), total);
        const end = page_to ? Math.min(Math.max(start, page_to), total) : total;

        const parts: string[] = [];
        let used = 0;
        let lastRead = start - 1;
        let cutByChars = false;
        for (let p = start; p <= end; p++) {
          const marker = `\n=== p.${p} ===\n`;
          const pageText = doc.pages[p - 1] || "(blank page)";
          if (used > 0 && used + marker.length + pageText.length > max_chars) {
            cutByChars = true;
            break;
          }
          let chunk = pageText;
          if (used + marker.length + chunk.length > max_chars) {
            chunk = chunk.slice(0, Math.max(0, max_chars - used - marker.length)).trimEnd() + "…";
            cutByChars = true;
          }
          parts.push(marker + chunk);
          used += marker.length + chunk.length;
          lastRead = p;
          if (cutByChars) break;
        }

        const next =
          lastRead < total
            ? ` Continue with page_from=${lastRead + 1}.`
            : " (end of document).";
        const header =
          `${basename(real)} — pages ${start}–${lastRead} of ${total}` +
          `${cutByChars ? ` (stopped at max_chars=${max_chars.toLocaleString()})` : ""}.${next}`;
        return ok([header, ...parts].join("\n"));
      } catch (e: any) {
        return fail(`local_doc_read failed: ${e?.message ?? e}`);
      }
    },
  );
}
