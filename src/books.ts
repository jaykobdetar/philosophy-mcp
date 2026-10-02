/**
 * Book & reference tools — public-domain classics plus modern research/translations.
 *
 * Self-contained (own HTTP / HTML helpers) so it composes onto the PhilPapers
 * server without touching its code. Registered via registerBookTools(server).
 *
 * Sources (all keyless):
 *   - Project Gutenberg  (Gutendex JSON, gutenberg.org OPDS fallback + direct text)
 *   - Internet Archive   (advancedsearch + OCR _djvu.txt)
 *   - Wikisource         (MediaWiki API, any language)
 *   - Open Library       (modern editions/translations metadata + read/borrow links)
 *   - DOAB               (open-access academic books)
 *   - Stanford Encyclopedia of Philosophy (static contents index + entry text)
 *   - fetch_text         (readable text from explicitly allowlisted public hosts)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LruCache, renderWindow } from "./textwindow.js";
import {
  headerValue,
  hostAllowlistPolicy,
  NetworkSecurityError,
  ResponseTooLargeError,
  secureRequest,
  type UrlPolicy,
} from "./net.js";
import { parseJsonSafely, parseXmlSafely } from "./xml.js";

// ---------------------------------------------------------------------------
// HTTP + text helpers
// ---------------------------------------------------------------------------

// Identify the client honestly and provide operator contact when configured,
// as requested by Wikimedia, Internet Archive, and Open Library API policies.
const configuredBookContact = (
  process.env.PHILOSOPHY_CONTACT ?? process.env.OPENALEX_MAILTO ?? ""
).trim();
const BOOK_CONTACT = /^[A-Za-z0-9][A-Za-z0-9@.:/_+?&=%#~-]{2,253}$/.test(
  configuredBookContact,
)
  ? configuredBookContact
  : "https://github.com/sea9401/philosophy-mcp";
const BOOK_UA = `philosophy-mcp/0.5 (MCP research client; contact: ${BOOK_CONTACT})`;
const TIMEOUT_MS = 30_000;
const MAX_REMOTE_METADATA_BYTES = 2 * 1024 * 1024;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function envByteLimit(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum} bytes.`);
  }
  return parsed;
}

const MAX_REMOTE_TEXT_BYTES = envByteLimit(
  "PHILOSOPHY_MAX_REMOTE_TEXT_BYTES",
  32 * 1024 * 1024,
  64 * 1024,
  256 * 1024 * 1024,
);
const MAX_GENERIC_FETCH_BYTES = envByteLimit(
  "PHILOSOPHY_MAX_GENERIC_FETCH_BYTES",
  8 * 1024 * 1024,
  64 * 1024,
  64 * 1024 * 1024,
);
const MAX_BODY_CACHE_BYTES = envByteLimit(
  "PHILOSOPHY_MAX_REMOTE_CACHE_BYTES",
  64 * 1024 * 1024,
  64 * 1024,
  512 * 1024 * 1024,
);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function asArr<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function ok(text: string) {
  const bounded =
    text.length <= 250_000
      ? text
      : `${text.slice(0, 250_000)}\n\n[output truncated at 250,000 characters]`;
  return { content: [{ type: "text" as const, text: bounded }] };
}
function fail(text: string) {
  const bounded = text.length <= 16_000 ? text : `${text.slice(0, 16_000)}…`;
  return { content: [{ type: "text" as const, text: bounded }], isError: true };
}

function errorSummary(error: unknown): string {
  return String((error as any)?.message ?? error).replace(/\s+/g, " ").slice(0, 1000);
}

class HttpResponseError extends Error {}

function retryAfterMs(headers: Record<string, string | string[] | undefined>): number | undefined {
  const raw = headerValue(headers, "retry-after").trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const milliseconds = Number(raw) * 1000;
    return Number.isFinite(milliseconds)
      ? Math.min(milliseconds, Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
  }
  const date = Date.parse(raw);
  return Number.isFinite(date)
    ? Math.min(Math.max(0, date - Date.now()), Number.MAX_SAFE_INTEGER)
    : undefined;
}

interface FetchOpts {
  retries?: number;
  timeoutMs?: number;
  maxBytes?: number;
  urlPolicy?: UrlPolicy;
  headers?: Record<string, string>;
}

interface FetchResult {
  contentType: string;
  body: string;
}

/**
 * GET with retry-and-backoff on transient errors (timeouts, 5xx, 429). The body
 * is read under the same abort timer as the request, so a server that sends
 * headers and then stalls the body cannot hang past timeoutMs.
 */
async function bookRequest(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Request timed out after ${timeoutMs} ms.`);
      const res = await secureRequest(url, {
        maxBytes: opts.maxBytes ?? MAX_REMOTE_TEXT_BYTES,
        timeoutMs: remaining,
        headers: {
          "User-Agent": BOOK_UA,
          "Accept-Language": "en,de,ko",
          ...opts.headers,
        },
        urlPolicy: opts.urlPolicy,
      });
      if (RETRY_STATUS.has(res.status) && i < retries) {
        lastErr = new Error(`HTTP ${res.status}`);
        const remaining = Math.max(0, deadline - Date.now());
        const requestedDelay = retryAfterMs(res.headers) ?? 600 * (i + 1);
        if (requestedDelay >= remaining) {
          throw new HttpResponseError(
            `HTTP ${res.status} ${res.statusText} — retry delay exceeds this request's deadline.`,
          );
        }
        const delay = Math.min(requestedDelay, remaining);
        if (delay > 0) await sleep(delay);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new HttpResponseError(`HTTP ${res.status} ${res.statusText} — ${url}`);
      }
      return {
        contentType: headerValue(res.headers, "content-type").toLowerCase(),
        body: res.body.toString("utf8"),
      };
    } catch (e) {
      lastErr = e;
      if (
        e instanceof NetworkSecurityError ||
        e instanceof ResponseTooLargeError ||
        e instanceof HttpResponseError
      ) {
        throw e;
      }
      if (i < retries && Date.now() < deadline) {
        const delay = Math.min(600 * (i + 1), Math.max(0, deadline - Date.now()));
        if (delay > 0) await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getText(url: string, opts: FetchOpts = {}): Promise<string> {
  return (await bookRequest(url, opts)).body;
}
async function getJson(url: string, opts: FetchOpts = {}): Promise<any> {
  const body = (
    await bookRequest(url, {
      ...opts,
      headers: { ...opts.headers, Accept: "application/json" },
    })
  ).body;
  const maxInputBytes = Math.min(opts.maxBytes ?? MAX_REMOTE_METADATA_BYTES, 16 * 1024 * 1024);
  return await parseJsonSafely(body, {
    maxInputBytes,
    maxOutputBytes: Math.min(16 * 1024 * 1024, Math.max(1024, maxInputBytes * 2)),
  });
}

// Gutendex (gutendex.com) is frequently overloaded; probe it fast and fall back
// to the reliable gutenberg.org host rather than hanging on its timeout.
const GUTENDEX_POLICY = hostAllowlistPolicy(["gutendex.com"]);
const GUTENBERG_POLICY = hostAllowlistPolicy(["gutenberg.org"], { allowSubdomains: true });
const ARCHIVE_POLICY = hostAllowlistPolicy(["archive.org"], { allowSubdomains: true });
const OPEN_LIBRARY_POLICY = hostAllowlistPolicy(["openlibrary.org"], { allowSubdomains: true });
const DOAB_POLICY = hostAllowlistPolicy(["directory.doabooks.org"]);
const SEP_POLICY = hostAllowlistPolicy(["plato.stanford.edu"]);
const GUTENDEX_OPTS: FetchOpts = {
  retries: 0,
  timeoutMs: 8_000,
  maxBytes: MAX_REMOTE_METADATA_BYTES,
  urlPolicy: GUTENDEX_POLICY,
};

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
    rdquo: "”", ldquo: "“",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : m;
    }
    return named[ent.toLowerCase()] ?? m;
  });
}

/**
 * Strip HTML in one forward pass. Cross-document lazy regexes are tempting
 * here, but malformed repeated opening tags make those patterns quadratic.
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const dropContent = new Set([
    "script", "style", "noscript", "template", "svg",
    "nav", "header", "footer", "aside", "form",
  ]);
  const blockTags = new Set([
    "p", "div", "section", "article", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "ul", "ol", "table", "br",
  ]);
  const pieces: string[] = [];
  let textStart = 0;
  let i = 0;
  let tags = 0;
  while (i < html.length) {
    const tagStart = html.indexOf("<", i);
    if (tagStart === -1) break;
    if (++tags > 100_000) {
      throw new Error("HTML contains too many tags to process safely.");
    }
    if (tagStart > textStart) pieces.push(html.slice(textStart, tagStart));

    if (lower.startsWith("<!--", tagStart)) {
      const commentEnd = lower.indexOf("-->", tagStart + 4);
      i = commentEnd === -1 ? html.length : commentEnd + 3;
      textStart = i;
      continue;
    }

    const tagEnd = html.indexOf(">", tagStart + 1);
    if (tagEnd === -1) {
      // Treat an unterminated tag as markup and stop; do not repeatedly scan it.
      i = html.length;
      textStart = i;
      break;
    }
    const token = lower.slice(tagStart + 1, tagEnd).trimStart();
    const nameMatch = token.match(/^\/?\s*([a-z][a-z0-9:-]*)/);
    const name = nameMatch?.[1] ?? "";
    const closing = token.startsWith("/");
    if (!closing && dropContent.has(name)) {
      const closingStart = lower.indexOf(`</${name}`, tagEnd + 1);
      if (closingStart === -1) {
        i = html.length;
        textStart = i;
        break;
      }
      const closingEnd = html.indexOf(">", closingStart + name.length + 2);
      i = closingEnd === -1 ? html.length : closingEnd + 1;
      pieces.push(" ");
      textStart = i;
      continue;
    }
    pieces.push(blockTags.has(name) ? "\n" : " ");
    i = tagEnd + 1;
    textStart = i;
  }
  if (textStart < html.length) pieces.push(html.slice(textStart));
  return decodeEntities(pieces.join(""))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Cache of fully-fetched/extracted bodies, keyed by source (e.g. "gut:1234",
 * "ia:<id>", a URL). Lets a tool page through a long book with offset= without
 * re-downloading it each call — the body is fetched once, then sliced.
 */
const bodyCache = new LruCache<string>(8, MAX_BODY_CACHE_BYTES, (body) =>
  Buffer.byteLength(body),
);

/** Shared `offset` input field for the read tools — keeps paging consistent. */
const offsetField = z
  .number()
  .int()
  .min(0)
  .max(100_000_000)
  .default(0)
  .describe(
    "Character offset to start from (default 0). For long texts, read a window then call " +
      "again with the offset reported in the footer to continue — avoids re-sending earlier text.",
  );

// ---------------------------------------------------------------------------
// Source-specific helpers
// ---------------------------------------------------------------------------

export function normalizeWikisourceLang(input: string): string {
  const lang = input.trim().toLowerCase();
  if (
    lang.length > 32 ||
    !/^[a-z]{2,12}(?:-[a-z0-9]{1,8})*$/.test(lang) ||
    lang.includes("--")
  ) {
    throw new NetworkSecurityError(`Invalid Wikisource language code "${input}".`);
  }
  return lang;
}

export function normalizeArchiveIdentifier(input: string): string {
  const identifier = input.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(identifier)) {
    throw new NetworkSecurityError(`Invalid Internet Archive identifier "${input}".`);
  }
  return identifier;
}

/** Canonicalize an SEP slug/path/URL while enforcing the exact SEP origin. */
export function normalizeSepEntry(input: string): string {
  const raw = input.trim();
  let slug: string;
  if (/^https?:/i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new NetworkSecurityError(`Invalid SEP URL "${input}".`);
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "plato.stanford.edu" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new NetworkSecurityError("SEP entries must use the exact https://plato.stanford.edu origin.");
    }
    const match = url.pathname.match(/^\/entries\/([a-z0-9][a-z0-9-]*)\/?$/i);
    if (!match) throw new NetworkSecurityError("SEP URL must identify one /entries/<slug>/ page.");
    slug = match[1];
  } else if (raw.startsWith("/")) {
    const match = raw.match(/^\/entries\/([a-z0-9][a-z0-9-]*)\/?$/i);
    if (!match) throw new NetworkSecurityError("SEP path must have the form /entries/<slug>/.");
    slug = match[1];
  } else {
    slug = raw.replace(/\/$/, "");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
    throw new NetworkSecurityError(`Invalid SEP entry slug "${slug}".`);
  }
  return `https://plato.stanford.edu/entries/${slug.toLowerCase()}/`;
}

function configuredFetchHosts(): string[] {
  const raw = process.env.PHILOSOPHY_FETCH_HOSTS ?? "";
  const hosts = raw
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  for (const host of hosts) {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes("..")) {
      throw new NetworkSecurityError(`Invalid PHILOSOPHY_FETCH_HOSTS entry "${host}".`);
    }
  }
  return [...new Set(hosts)];
}

function genericFetchPolicy(): UrlPolicy {
  const hosts = configuredFetchHosts();
  if (hosts.length === 0) {
    throw new NetworkSecurityError(
      "fetch_text is disabled. Set PHILOSOPHY_FETCH_HOSTS to a comma-separated list of exact " +
        "public hostnames to enable it.",
    );
  }
  return hostAllowlistPolicy(hosts);
}

/** Fallback Gutenberg search via gutenberg.org's OPDS feed (when Gutendex is overloaded). */
async function gutenbergOpds(terms: string, limit: number): Promise<Array<{ id: number; title: string; author: string }>> {
  const body = await getText(
    `https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(terms)}`,
    { maxBytes: 2 * 1024 * 1024, urlPolicy: GUTENBERG_POLICY },
  );
  const root: any = await parseXmlSafely(body);
  const items: Array<{ id: number; title: string; author: string }> = [];
  for (const entry of asArr<any>(root?.feed?.entry)) {
    const title = String(entry?.title ?? "").trim();
    const content = entry?.content;
    const contentText =
      content && typeof content === "object" ? content["#text"] : content;
    const authorRaw = entry?.author?.name ?? contentText;
    const author = String(Array.isArray(authorRaw) ? authorRaw[0] : authorRaw ?? "").trim();
    let bid: number | null = null;
    for (const ln of asArr<any>(entry?.link)) {
      const m = String(ln?.["@_href"] ?? "").match(
        /\/(?:ebooks|epub|files|cache\/epub)\/(\d+)(?:[/.?#]|$)/,
      );
      if (m) {
        bid = parseInt(m[1], 10);
        break;
      }
    }
    if (bid === null) {
      // OPDS also contains facets/navigation entries whose query text may be
      // numeric. Only a canonical ebook path is evidence of a Gutenberg id.
      const m = String(entry?.id ?? "").match(/\/ebooks\/(\d+)(?:[/?#]|$)/);
      bid = m ? parseInt(m[1], 10) : null;
    }
    if (bid === null) continue; // skip facet/navigation entries
    items.push({ id: bid, title, author });
    if (items.length >= limit) break;
  }
  return items;
}

/** Lazily-built, cached SEP entry index from the static contents page. */
let sepIndex: Array<[string, string]> | null = null;
async function getSepIndex(): Promise<Array<[string, string]>> {
  if (sepIndex === null) {
    const html = await getText("https://plato.stanford.edu/contents.html", {
      maxBytes: MAX_REMOTE_METADATA_BYTES,
      urlPolicy: SEP_POLICY,
    });
    const idx: Array<[string, string]> = [];
    const seen = new Set<string>();
    const lower = html.toLowerCase();
    let cursor = 0;
    while (idx.length < 20_000) {
      const anchorStart = lower.indexOf("<a", cursor);
      if (anchorStart === -1) break;
      const afterName = lower[anchorStart + 2] ?? "";
      if (afterName && !/[\s/>]/.test(afterName)) {
        cursor = anchorStart + 2;
        continue;
      }
      const tagEnd = html.indexOf(">", anchorStart + 2);
      if (tagEnd === -1) break;
      if (tagEnd - anchorStart > 8192) {
        cursor = tagEnd + 1;
        continue;
      }
      const closeStart = lower.indexOf("</a", tagEnd + 1);
      if (closeStart === -1) break;
      const closeEnd = html.indexOf(">", closeStart + 3);
      if (closeEnd === -1) break;
      const opening = html.slice(anchorStart, tagEnd + 1);
      const hrefMatch = opening.match(/\bhref\s*=\s*["']([^"']{1,2048})["']/i);
      cursor = closeEnd + 1;
      if (!hrefMatch) continue;
      const rawHref = hrefMatch[1];
      if (!/^(?:https:\/\/plato\.stanford\.edu\/)?entries\//i.test(rawHref)) continue;
      const inner = html.slice(tagEnd + 1, Math.min(closeStart, tagEnd + 1 + 64_000));
      const title = htmlToText(inner).trim().slice(0, 1000);
      let url: string;
      try {
        const path = rawHref.replace(/^https:\/\/plato\.stanford\.edu\//i, "");
        url = normalizeSepEntry(`/${path.replace(/^\//, "")}`);
      } catch {
        continue;
      }
      if (!title || seen.has(url)) continue;
      seen.add(url);
      idx.push([title, url]);
    }
    sepIndex = idx;
  }
  return sepIndex;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerBookTools(server: McpServer): void {
  // --- Project Gutenberg ---------------------------------------------------
  server.registerTool(
    "search_gutenberg",
    {
      title: "Search Project Gutenberg (public-domain classics)",
      description:
        "Search Project Gutenberg for public-domain classics and out-of-copyright translations " +
        "(Kant, Hegel, Nietzsche, Schopenhauer, Marx, Fichte, ...). Returns title, author, " +
        "languages, a Gutenberg page link, and download URLs. Use the numeric id with get_gutenberg_text.",
      inputSchema: {
        query: z.string().trim().max(1000).default("").describe("Free-text search over title + author."),
        author: z.string().trim().max(1000).default("").describe("Author name to fold into the search."),
        topic: z.string().trim().max(1000).default("").describe("Subject/bookshelf filter, e.g. 'philosophy'."),
        languages: z.string().trim().max(256).default("").describe("Comma-separated ISO codes, e.g. 'en,de'."),
        limit: z.number().int().min(1).max(32).default(10).describe("Max results (1–32)."),
      },
    },
    async ({ query, author, topic, languages, limit }) => {
      const terms = [query, author].filter(Boolean).join(" ").trim();
      // Primary: Gutendex (rich JSON + language/topic filters).
      try {
        const params = new URLSearchParams();
        if (terms) params.set("search", terms);
        if (topic) params.set("topic", topic);
        if (languages) params.set("languages", languages.replace(/\s/g, ""));
        const data = await getJson(`https://gutendex.com/books?${params.toString()}`, GUTENDEX_OPTS);
        const results: any[] = (data.results ?? []).slice(0, limit);
        if (results.length) {
          const lines = results.map((b) => {
            const fmts: Record<string, string> = b.formats ?? {};
            const epub = Object.entries(fmts).find(([k]) => k.includes("epub"))?.[1] ?? "";
            const txt = Object.entries(fmts).find(([k]) => k.startsWith("text/plain"))?.[1] ?? "";
            const authors = asArr<any>(b.authors).map((a) => a.name).join(", ") || "—";
            return [
              `• [${b.id}] ${b.title ?? "?"}`,
              `   author: ${authors} | lang: ${asArr<string>(b.languages).join(",")} | downloads: ${b.download_count ?? 0}`,
              `   gutenberg: https://www.gutenberg.org/ebooks/${b.id}`,
              epub ? `   epub: ${epub}` : "",
              txt ? `   text: ${txt}` : "",
            ].filter(Boolean).join("\n");
          });
          return ok([`Project Gutenberg — ${data.count ?? 0} total match(es), showing ${results.length}:`, "", ...lines].join("\n"));
        }
      } catch {
        // Gutendex is frequently overloaded — fall back to gutenberg.org OPDS.
      }
      const queryTerms = terms || topic;
      if (!queryTerms) return fail("Provide a query, author, or topic to search Project Gutenberg.");
      try {
        const items = await gutenbergOpds(queryTerms, limit);
        if (!items.length) return ok("No Project Gutenberg matches.");
        const lines = items.map((b) =>
          [
            `• [${b.id}] ${b.title || "?"}`,
            `   author: ${b.author || "—"}`,
            `   gutenberg: https://www.gutenberg.org/ebooks/${b.id}`,
          ].join("\n"),
        );
        return ok([`Project Gutenberg (via gutenberg.org) — showing ${items.length}:`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`Project Gutenberg unreachable (Gutendex down; gutenberg.org error: ${e?.message ?? e}).`);
      }
    },
  );

  server.registerTool(
    "get_gutenberg_text",
    {
      title: "Read a Project Gutenberg book",
      description:
        "Fetch the plain-text body of a Project Gutenberg book by numeric id (from search_gutenberg). " +
        "Returns one window of max_chars from offset; whole books are long, so read a window and " +
        "page on with the offset in the footer. The downloaded body is cached, so paging is cheap.",
      inputSchema: {
        book_id: z.number().int().positive().max(10_000_000).describe("Gutenberg book id."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return (default 15000)."),
        offset: offsetField,
      },
    },
    async ({ book_id, max_chars, offset }) => {
      const bid = book_id;
      const key = `gut:${bid}`;
      let body = bodyCache.get(key) ?? "";
      if (!body) {
        let lastRetrievalError: unknown;
        const candidates = [
          `https://www.gutenberg.org/cache/epub/${bid}/pg${bid}.txt`,
          `https://www.gutenberg.org/files/${bid}/${bid}-0.txt`,
          `https://www.gutenberg.org/ebooks/${bid}.txt.utf-8`,
        ];
        for (const u of candidates) {
          try {
            const t = await getText(u, { retries: 1, urlPolicy: GUTENBERG_POLICY });
            if (t && t.trim()) {
              body = t;
              break;
            }
          } catch (error) {
            lastRetrievalError = error;
            /* try next layout */
          }
        }
        if (!body.trim()) {
          // last resort: Gutendex metadata -> its own text/plain link
          try {
            const meta = await getJson(`https://gutendex.com/books/${bid}`, GUTENDEX_OPTS);
            const fmts: Record<string, string> = meta.formats ?? {};
            const url = Object.entries(fmts).find(([k, v]) => k.startsWith("text/plain") && !v.endsWith(".zip"))?.[1];
            if (url) {
              body = await getText(url, { retries: 1, urlPolicy: GUTENBERG_POLICY });
            }
          } catch (error) {
            lastRetrievalError = error;
            /* ignore */
          }
        }
        if (!body.trim()) {
          const detail = lastRetrievalError
            ? ` Last retrieval error: ${errorSummary(lastRetrievalError)}.`
            : "";
          return fail(
            `Could not download plain text for Gutenberg id ${bid}. ` +
              `Try the epub from search_gutenberg or https://www.gutenberg.org/ebooks/${bid}.` +
              detail,
          );
        }
        bodyCache.set(key, body);
      }
      const m = body.slice(0, 400).match(/Project Gutenberg eBook of (.+)/);
      const title = m ? m[1].trim() : `Gutenberg ${bid}`;
      return ok(renderWindow(`# ${title} (Gutenberg ${bid})`, body, max_chars, offset));
    },
  );

  // --- Internet Archive ----------------------------------------------------
  server.registerTool(
    "search_internet_archive",
    {
      title: "Search the Internet Archive",
      description:
        "Search the Internet Archive for scanned, out-of-print monographs, journals, and " +
        "translations. Use the returned identifier with get_archive_text.",
      inputSchema: {
        query: z.string().trim().min(1).max(1000).describe("Search terms."),
        limit: z.number().int().min(1).max(25).default(10).describe("Max results (1–25)."),
        mediatype: z.string().trim().max(64).default("texts").describe("Usually 'texts'; pass '' for all media."),
      },
    },
    async ({ query, limit, mediatype }) => {
      try {
        const q = mediatype ? `(${query}) AND mediatype:${mediatype}` : `(${query})`;
        const params = new URLSearchParams({ q, rows: String(limit), output: "json" });
        for (const f of ["identifier", "title", "creator", "year", "mediatype"]) params.append("fl[]", f);
        const data = await getJson(`https://archive.org/advancedsearch.php?${params.toString()}`, {
          maxBytes: MAX_REMOTE_METADATA_BYTES,
          urlPolicy: ARCHIVE_POLICY,
        });
        const docs: any[] = asArr<any>(data?.response?.docs).slice(0, limit);
        if (!docs.length) return ok("No Internet Archive matches.");
        const lines = docs.map((d) => {
          const creator = Array.isArray(d.creator) ? d.creator.join(", ") : d.creator ?? "—";
          return [
            `• [${d.identifier}] ${d.title ?? "?"}`,
            `   creator: ${creator || "—"} | year: ${d.year ?? "?"}`,
            `   details: https://archive.org/details/${d.identifier}`,
          ].join("\n");
        });
        return ok([`Internet Archive — showing ${docs.length}:`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`Internet Archive request failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "get_archive_text",
    {
      title: "Read Internet Archive OCR text",
      description:
        "Fetch the OCR full text of an Internet Archive item by identifier (from " +
        "search_internet_archive). Returns one window of max_chars from offset; scans are long, so " +
        "read a window and page on with the offset in the footer. The text is cached after first fetch.",
      inputSchema: {
        identifier: z.string().trim().min(1).max(100).describe("IA item identifier."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return."),
        offset: offsetField,
      },
    },
    async ({ identifier, max_chars, offset }) => {
      try {
        identifier = normalizeArchiveIdentifier(identifier);
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
      const key = `ia:${identifier}`;
      let body = bodyCache.get(key) ?? "";
      if (!body) {
        let lastRetrievalError: unknown;
        const operationDeadline = Date.now() + 60_000;
        const candidates = [`https://archive.org/download/${identifier}/${identifier}_djvu.txt`];
        try {
          const meta = await getJson(`https://archive.org/metadata/${identifier}`, {
            maxBytes: MAX_REMOTE_METADATA_BYTES,
            timeoutMs: 15_000,
            urlPolicy: ARCHIVE_POLICY,
          });
          for (const f of asArr<any>(meta.files).slice(0, 200)) {
            const name = String(f.name ?? "");
            const fmt = String(f.format ?? "").toLowerCase();
            if (
              candidates.length < 3 &&
              name.length <= 1024 &&
              (name.endsWith("_djvu.txt") || (name.endsWith(".txt") && fmt.includes("text")))
            ) {
              candidates.push(`https://archive.org/download/${identifier}/${encodeURIComponent(name)}`);
            }
          }
        } catch (error) {
          lastRetrievalError = error;
          /* ignore — fall back to the conventional name */
        }
        const seen = new Set<string>();
        for (const u of candidates) {
          if (seen.has(u)) continue;
          seen.add(u);
          try {
            const remaining = operationDeadline - Date.now();
            if (remaining <= 0) break;
            const t = await getText(u, {
              retries: 1,
              timeoutMs: Math.min(20_000, remaining),
              urlPolicy: ARCHIVE_POLICY,
            });
            if (t && t.trim()) {
              body = t;
              break;
            }
          } catch (error) {
            lastRetrievalError = error;
            /* try next candidate */
          }
        }
        if (!body.trim()) {
          const detail = lastRetrievalError
            ? ` Last retrieval error: ${errorSummary(lastRetrievalError)}.`
            : "";
          return fail(
            `No OCR text file found for "${identifier}" (may be image-only or restricted). ` +
              `Browse it at https://archive.org/details/${identifier}.` + detail,
          );
        }
        bodyCache.set(key, body);
      }
      return ok(renderWindow(`# Internet Archive: ${identifier}`, body, max_chars, offset));
    },
  );

  // --- Wikisource ----------------------------------------------------------
  server.registerTool(
    "search_wikisource",
    {
      title: "Search Wikisource",
      description:
        "Search Wikisource for primary texts and translations (en, de, ko, ...). " +
        "Use get_wikisource_text to read.",
      inputSchema: {
        query: z.string().trim().min(1).max(1000).describe("Search terms."),
        lang: z.string().trim().max(32).default("en").describe("Wikisource language subdomain (en, de, ko...)."),
        limit: z.number().int().min(1).max(25).default(10).describe("Max results (1–25)."),
      },
    },
    async ({ query, lang, limit }) => {
      try {
        lang = normalizeWikisourceLang(lang);
        const policy = hostAllowlistPolicy([`${lang}.wikisource.org`]);
        const params = new URLSearchParams({
          action: "query", list: "search", srsearch: query,
          srlimit: String(limit), format: "json", srprop: "snippet",
        });
        const data = await getJson(`https://${lang}.wikisource.org/w/api.php?${params.toString()}`, {
          maxBytes: MAX_REMOTE_METADATA_BYTES,
          urlPolicy: policy,
        });
        const hits: any[] = asArr<any>(data?.query?.search).slice(0, limit);
        if (!hits.length) return ok(`No ${lang}.wikisource matches.`);
        const lines = hits.map((h) => {
          const title = String(h.title ?? "?");
          const snip = htmlToText(h.snippet ?? "").replace(/\n/g, " ");
          const link = `https://${lang}.wikisource.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
          return `• ${title}\n   ${snip}\n   ${link}`;
        });
        return ok([`Wikisource (${lang}) — showing ${hits.length}:`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`Wikisource request failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "get_wikisource_text",
    {
      title: "Read a Wikisource page",
      description:
        "Fetch the plain text of a Wikisource page by title (from search_wikisource). Returns one " +
        "window of max_chars from offset; page on with the offset in the footer. Cached after first fetch.",
      inputSchema: {
        title: z.string().trim().min(1).max(1000).describe("Exact page title."),
        lang: z.string().trim().max(32).default("en").describe("Wikisource language subdomain."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return."),
        offset: offsetField,
      },
    },
    async ({ title, lang, max_chars, offset }) => {
      try {
        lang = normalizeWikisourceLang(lang);
        const policy = hostAllowlistPolicy([`${lang}.wikisource.org`]);
        const key = `ws:${lang}:${title}`;
        let cached = bodyCache.get(key);
        let pageTitle = title;
        if (cached === undefined) {
          const params = new URLSearchParams({
            action: "parse",
            page: title,
            prop: "text",
            format: "json",
            formatversion: "2",
            redirects: "1",
          });
          const data = await getJson(`https://${lang}.wikisource.org/w/api.php?${params.toString()}`, {
            maxBytes: 8 * 1024 * 1024,
            urlPolicy: policy,
          });
          const rendered =
            typeof data?.parse?.text === "string"
              ? data.parse.text
              : String(data?.parse?.text?.["*"] ?? "");
          const extracted = htmlToText(rendered);
          if (extracted.trim()) {
            cached = extracted;
            pageTitle = String(data?.parse?.title ?? title);
            bodyCache.set(key, extracted);
          }
          if (cached === undefined) {
            return fail(
              `No rendered text for "${title}" on ${lang}.wikisource. ` +
                "Verify the title via search_wikisource.",
            );
          }
        }
        return ok(renderWindow(`# ${pageTitle} (Wikisource ${lang})`, cached, max_chars, offset));
      } catch (e: any) {
        return fail(`Wikisource request failed: ${e?.message ?? e}`);
      }
    },
  );

  // --- Open Library --------------------------------------------------------
  server.registerTool(
    "search_openlibrary",
    {
      title: "Search Open Library",
      description:
        "Search Open Library for books — strong for modern editions and translations as metadata, " +
        "with read/borrow links wherever a scan exists.",
      inputSchema: {
        query: z.string().trim().min(1).max(1000).describe("Title or keywords, e.g. 'Being and Time Heidegger'."),
        author: z.string().trim().max(1000).default("").describe("Optional author filter."),
        limit: z.number().int().min(1).max(25).default(10).describe("Max results (1–25)."),
      },
    },
    async ({ query, author, limit }) => {
      try {
        const params = new URLSearchParams({
          q: query, limit: String(limit),
          fields: "title,author_name,first_publish_year,key,ia,ebook_access,edition_count",
        });
        if (author) params.set("author", author);
        const data = await getJson(`https://openlibrary.org/search.json?${params.toString()}`, {
          maxBytes: MAX_REMOTE_METADATA_BYTES,
          urlPolicy: OPEN_LIBRARY_POLICY,
        });
        const docs: any[] = (data.docs ?? []).slice(0, limit);
        if (!docs.length) return ok("No Open Library matches.");
        const lines = docs.map((d) => {
          const authors = asArr<string>(d.author_name).join(", ") || "—";
          const ia = asArr<string>(d.ia);
          const read = ia.length ? `https://archive.org/details/${ia[0]}` : "";
          return [
            `• ${d.title ?? "?"} (${d.first_publish_year ?? "?"})`,
            `   author: ${authors} | editions: ${d.edition_count ?? "?"} | ebook: ${d.ebook_access ?? "no ebook"}`,
            `   openlibrary: https://openlibrary.org${d.key ?? ""}`,
            read ? `   read/borrow: ${read}` : "",
          ].filter(Boolean).join("\n");
        });
        const total = data.num_found ?? data.numFound ?? 0;
        return ok([`Open Library — ${total} total, showing ${docs.length}:`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`Open Library request failed: ${e?.message ?? e}`);
      }
    },
  );

  // --- DOAB ----------------------------------------------------------------
  server.registerTool(
    "search_doab",
    {
      title: "Search DOAB (open-access books)",
      description:
        "Search the Directory of Open Access Books — peer-reviewed, fully open-access academic " +
        "books, including many modern philosophy monographs readable in full.",
      inputSchema: {
        query: z.string().trim().min(1).max(1000).describe("Search terms (title/author/keyword)."),
        limit: z.number().int().min(1).max(25).default(10).describe("Max results (1–25)."),
      },
    },
    async ({ query, limit }) => {
      const manual = `https://directory.doabooks.org/discover?query=${encodeURIComponent(query)}`;
      try {
        const params = new URLSearchParams({ query, expand: "metadata", limit: String(limit) });
        const data = await getJson(`https://directory.doabooks.org/rest/search?${params.toString()}`, {
          maxBytes: MAX_REMOTE_METADATA_BYTES,
          urlPolicy: DOAB_POLICY,
        });
        if (!Array.isArray(data) || !data.length) return ok(`No DOAB matches. Browse: ${manual}`);
        const lines = data.slice(0, limit).map((item: any) => {
          const mds = asArr<any>(item.metadata).filter((m) => m && typeof m === "object");
          const vals = (...keys: string[]) =>
            mds.filter((m) => keys.includes(m.key) && m.value).map((m) => String(m.value));
          const title = vals("dc.title")[0] ?? item.name ?? "?";
          let people = vals("dc.contributor.author", "dc.creator");
          let role = "author";
          if (!people.length) {
            people = vals("dc.contributor.editor");
            role = "editor";
          }
          const who = [...new Set(people)].join(", ") || "—";
          const handle = item.handle ?? "";
          const link = handle
            ? `https://directory.doabooks.org/handle/${handle}`
            : vals("dc.identifier.uri")[0] ?? "";
          return [`• ${title}`, `   ${role}: ${who}`, link ? `   ${link}` : ""].filter(Boolean).join("\n");
        });
        return ok([`DOAB (open-access books) — showing ${Math.min(data.length, limit)}:`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`DOAB request failed: ${e?.message ?? e}\nSearch manually: ${manual}`);
      }
    },
  );

  // --- Stanford Encyclopedia of Philosophy ---------------------------------
  server.registerTool(
    "search_sep",
    {
      title: "Search the Stanford Encyclopedia of Philosophy",
      description:
        "Search SEP (the standard scholarly reference) by matching its full entry index. " +
        "Read an entry with get_sep_entry.",
      inputSchema: {
        query: z.string().trim().min(1).max(1000).describe("Topic or philosopher, e.g. 'Hegel', 'phenomenology'."),
        limit: z.number().int().min(1).max(20).default(10).describe("Max results (1–20)."),
      },
    },
    async ({ query, limit }) => {
      try {
        const idx = await getSepIndex();
        const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 32);
        if (!words.length) return fail("Provide a search term.");
        let matches = idx.filter(([t]) => words.every((w) => t.toLowerCase().includes(w)));
        if (!matches.length) matches = idx.filter(([t]) => words.some((w) => t.toLowerCase().includes(w)));
        if (!matches.length) return ok(`No SEP entries matched "${query}". Browse https://plato.stanford.edu/contents.html`);
        matches = matches.slice(0, limit);
        const lines = matches.map(([t, u]) => {
          const slug = u.replace(/\/$/, "").split("/").pop();
          return `• ${t}  (slug: ${slug})\n   ${u}`;
        });
        return ok([`Stanford Encyclopedia of Philosophy — ${matches.length} entr(ies) for "${query}":`, "", ...lines].join("\n"));
      } catch (e: any) {
        return fail(`SEP index fetch failed: ${e?.message ?? e}\nBrowse https://plato.stanford.edu/contents.html`);
      }
    },
  );

  server.registerTool(
    "get_sep_entry",
    {
      title: "Read a Stanford Encyclopedia entry",
      description:
        "Fetch the text of a SEP entry. Accepts a slug (e.g. 'hegel'), a /entries/.. path, or a " +
        "full URL. Returns one window of max_chars from offset; SEP entries are long, so read a " +
        "window and page on with the offset in the footer. Cached after first fetch.",
      inputSchema: {
        entry: z.string().trim().min(1).max(2048).describe("Entry slug, /entries/.. path, or full URL."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return."),
        offset: offsetField,
      },
    },
    async ({ entry, max_chars, offset }) => {
      let url = "";
      try {
        url = normalizeSepEntry(entry);
        const key = `sep:${url}`;
        let text = bodyCache.get(key);
        if (text === undefined) {
          text = htmlToText(
            await getText(url, { maxBytes: 8 * 1024 * 1024, urlPolicy: SEP_POLICY }),
          );
          bodyCache.set(key, text);
        }
        return ok(renderWindow(`# SEP entry: ${url}`, text, max_chars, offset));
      } catch (e: any) {
        return fail(`Could not fetch SEP entry at ${url || entry}: ${e?.message ?? e}`);
      }
    },
  );

  // --- Catch-all -----------------------------------------------------------
  server.registerTool(
    "fetch_text",
    {
      title: "Fetch readable text from an allowlisted URL",
      description:
        "Fetch readable text from a URL whose exact hostname appears in the server's " +
        "PHILOSOPHY_FETCH_HOSTS allowlist. The tool is disabled when that setting is empty. " +
        "Returns one window of max_chars from offset; page on with the offset in the footer. Cached per URL.",
      inputSchema: {
        url: z.string().trim().max(4096).url().describe("The page or text-file URL."),
        max_chars: z.number().int().min(500).max(200_000).default(15_000).describe("Characters to return."),
        offset: offsetField,
      },
    },
    async ({ url, max_chars, offset }) => {
      try {
        const policy = genericFetchPolicy();
        const canonical = new URL(url);
        canonical.hash = "";
        url = canonical.toString();
        const key = `url:${url}`;
        let text = bodyCache.get(key);
        if (text === undefined) {
          const { contentType, body } = await bookRequest(url, {
            maxBytes: MAX_GENERIC_FETCH_BYTES,
            urlPolicy: policy,
          });
          if (
            contentType &&
            !contentType.startsWith("text/") &&
            !contentType.includes("html") &&
            !contentType.includes("xml") &&
            !contentType.includes("json")
          ) {
            return fail(`Fetch refused non-text content type "${contentType}" from ${url}.`);
          }
          text =
            contentType.includes("html") || body.trimStart().startsWith("<") ? htmlToText(body) : body;
          if (!text.trim()) return ok(`Fetched ${url} but found no readable text (binary or JS-only page?).`);
          bodyCache.set(key, text);
        }
        return ok(renderWindow(`# ${url}`, text, max_chars, offset));
      } catch (e: any) {
        return fail(`Fetch failed for ${url}: ${e?.message ?? e}`);
      }
    },
  );
}
