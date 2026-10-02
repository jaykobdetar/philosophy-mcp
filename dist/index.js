#!/usr/bin/env node
/**
 * Philosophy MCP server.
 *
 * PhilPapers / PhilArchive scholarship (all keyless):
 *   - Keyword search  -> OpenAlex, filtered to the PhilPapers/PhilArchive source.
 *   - Record metadata -> PhilArchive OAI-PMH (GetRecord).
 *   - Recent papers   -> PhilArchive OAI-PMH (ListRecords, by date).
 *   - Full text        -> https://philpapers.org/archive/<ID>.pdf (downloaded + text-extracted)
 *
 * PhilArchive is the open-access archive built on the PhilPapers database, so a
 * PhilPapers record id (e.g. "BROTNO-9") resolves on both hosts.
 *
 * Book & reference tools (Gutenberg, Internet Archive, Wikisource, Open Library,
 * DOAB, Stanford Encyclopedia, and a generic fetch_text) live in ./books.ts and
 * are attached below via registerBookTools().
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { Transform } from "node:stream";
import { z } from "zod";
import { registerBookTools } from "./books.js";
import { registerLocalTools } from "./local.js";
import { LruCache, windowText, windowNote, pastEndNote } from "./textwindow.js";
import { MAX_PDF_BYTES, savePdfSafely } from "./download.js";
import { headerValue, hostAllowlistPolicy, secureRequest } from "./net.js";
import { extractPdfSafely, shutdownPdfParsers } from "./pdf.js";
import { parseJsonSafely, parseXmlSafely } from "./xml.js";
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
/** Active OpenAlex source id for the PhilPapers Foundation repository (covers PhilArchive). */
const OPENALEX_SOURCE = "S4306402130";
const OPENALEX_WORKS = "https://api.openalex.org/works";
const OAI_BASE = "https://philarchive.org/oai.pl";
const PDF_BASE = "https://philpapers.org/archive";
/** Contact metadata for the OpenAlex User-Agent. */
const configuredMailto = process.env.OPENALEX_MAILTO?.trim() ?? "";
const OPENALEX_CONTACT = /^[^\s\r\n]{3,254}$/.test(configuredMailto)
    ? configuredMailto
    : "https://github.com/sea9401/philosophy-mcp";
const OPENALEX_USER_AGENT = `philosophy-mcp/0.5 (+${OPENALEX_CONTACT})`;
const configuredOpenAlexApiKey = process.env.OPENALEX_API_KEY?.trim() ?? "";
if (configuredOpenAlexApiKey &&
    (configuredOpenAlexApiKey.length > 1024 || /[\s\x00-\x1f\x7f]/.test(configuredOpenAlexApiKey))) {
    throw new Error("OPENALEX_API_KEY contains whitespace, control characters, or is too long.");
}
const OPENALEX_HEADERS = configuredOpenAlexApiKey
    ? { Authorization: `Bearer ${configuredOpenAlexApiKey}` }
    : {};
const ARCHIVE_USER_AGENT = "philosophy-mcp/0.5 (+research/educational)";
const HTTP_TIMEOUT_MS = 30_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_FULLTEXT_CHARS = 20_000_000;
const MAX_MCP_MESSAGE_BYTES = 1024 * 1024;
const MAX_INFLIGHT_MCP_REQUESTS = 16;
const MAX_ACTIVE_TOOL_CALLS = 8;
const MAX_ACTIVE_PDF_PIPELINES = 2;
const MAX_QUEUED_PDF_PIPELINES = 4;
const OPENALEX_POLICY = hostAllowlistPolicy(["api.openalex.org"]);
const PHILARCHIVE_POLICY = hostAllowlistPolicy(["philarchive.org"], { allowSubdomains: true });
const PHILPAPERS_POLICY = hostAllowlistPolicy(["philpapers.org"], { allowSubdomains: true });
const QUERY_INPUT = z.string().trim().min(1).max(1000);
const RECORD_ID_INPUT = z.string().trim().min(1).max(512);
const YEAR_INPUT = z.number().int().min(1000).max(9999);
const ISO_DATE_INPUT = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Date must be a real UTC calendar date in YYYY-MM-DD form.");
// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function asArray(v) {
    if (v === undefined || v === null)
        return [];
    return Array.isArray(v) ? v : [v];
}
async function requestBuffer(url, policy, maxBytes, options = {}) {
    const response = await secureRequest(url, {
        method: options.method,
        maxBytes,
        timeoutMs: HTTP_TIMEOUT_MS,
        headers: {
            "User-Agent": options.userAgent ?? ARCHIVE_USER_AGENT,
            ...options.headers,
        },
        urlPolicy: policy,
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status} ${response.statusText} — ${url}`);
    }
    return response;
}
async function requestText(url, policy, userAgent = ARCHIVE_USER_AGENT, headers = {}) {
    return (await requestBuffer(url, policy, MAX_METADATA_BYTES, { userAgent, headers })).body.toString("utf8");
}
async function requestJson(url, policy, userAgent = ARCHIVE_USER_AGENT, headers = {}) {
    return await parseJsonSafely(await requestText(url, policy, userAgent, headers), {
        maxInputBytes: MAX_METADATA_BYTES,
        maxOutputBytes: 4 * 1024 * 1024,
    });
}
/** Accept "BROTNO-9", a /rec/ URL, an oai: identifier, or "<ID>.pdf" and return the bare id. */
function normalizeRecId(input) {
    let s = input.trim();
    const m = s.match(/rec\/([^/?#\s]+)/i);
    if (m)
        s = m[1];
    s = s.replace(/^oai:philarchive\.org\/rec\//i, "");
    s = s.replace(/\.pdf$/i, "");
    return s;
}
/**
 * PhilArchive record ids are short alphanumeric-plus-hyphen codes (e.g.
 * "BROTNO-9"). Validate a client-supplied id against an allowlist before using
 * it in a filesystem path or an upstream URL, so it can't carry "../" path
 * traversal or other surprises into fetch_pdf / downloadPdf.
 */
const REC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
function assertSafeRecId(recId) {
    if (recId.length > 128 || !REC_ID_RE.test(recId)) {
        throw new Error(`Invalid PhilArchive record id "${recId}" — expected letters, digits, and ` +
            `hyphens only (e.g. "BROTNO-9").`);
    }
    return recId;
}
/** OpenAlex stores abstracts as an inverted index; rebuild the running text. */
function reconstructAbstract(inv) {
    if (!inv)
        return "";
    const slots = [];
    outer: for (const [rawWord, positions] of Object.entries(inv)) {
        const word = rawWord.slice(0, 200);
        if (!Array.isArray(positions))
            continue;
        for (const p of positions) {
            if (slots.length >= 50_000)
                break outer;
            if (Number.isSafeInteger(p) && p >= 0 && p <= 1_000_000)
                slots.push([p, word]);
        }
    }
    slots.sort((a, b) => a[0] - b[0]);
    const words = [];
    let chars = 0;
    for (const [, word] of slots) {
        const remaining = 200_000 - chars - (words.length ? 1 : 0);
        if (remaining <= 0)
            break;
        const piece = word.slice(0, remaining);
        words.push(piece);
        chars += piece.length + (words.length > 1 ? 1 : 0);
    }
    return words.join(" ");
}
function truncate(s, n) {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n).trimEnd() + "…" : t;
}
/** Pull the PhilArchive id / links out of an OpenAlex work's locations. */
function philLinks(work) {
    let recId;
    let landing;
    let pdfUrl;
    for (const loc of asArray(work.locations).slice(0, 500)) {
        const lp = String(loc?.landing_page_url ?? "").slice(0, 4096);
        const pu = String(loc?.pdf_url ?? "").slice(0, 4096);
        const m = lp.match(/phil(?:archive|papers)\.org\/rec\/([^/?#]+)/i);
        if (m && !recId) {
            try {
                recId = assertSafeRecId(normalizeRecId(m[1]));
            }
            catch {
                // Ignore malformed upstream identifiers.
            }
        }
        if (/philarchive\.org\/rec\//i.test(lp) && !landing)
            landing = lp;
        if (/philpapers\.org\/archive\//i.test(pu) && !pdfUrl)
            pdfUrl = pu;
    }
    if (recId && !landing)
        landing = `https://philarchive.org/rec/${recId}`;
    return { recId, landing, pdfUrl };
}
function ok(text) {
    const bounded = text.length <= 250_000
        ? text
        : `${text.slice(0, 250_000)}\n\n[output truncated at 250,000 characters]`;
    return { content: [{ type: "text", text: bounded }] };
}
function fail(text) {
    const bounded = text.length <= 16_000 ? text : `${text.slice(0, 16_000)}…`;
    return { content: [{ type: "text", text: bounded }], isError: true };
}
async function mapWithConcurrency(items, concurrency, mapper) {
    const output = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length)
                return;
            output[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return output;
}
let activePdfPipelines = 0;
const pdfPipelineWaiters = [];
async function acquirePdfPipeline() {
    if (activePdfPipelines < MAX_ACTIVE_PDF_PIPELINES) {
        activePdfPipelines++;
    }
    else {
        if (pdfPipelineWaiters.length >= MAX_QUEUED_PDF_PIPELINES) {
            throw new Error("Too many PDF operations are active; try again later.");
        }
        await new Promise((resolve) => pdfPipelineWaiters.push(resolve));
    }
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        const next = pdfPipelineWaiters.shift();
        if (next)
            next();
        else
            activePdfPipelines--;
    };
}
async function withPdfPipeline(operation) {
    const release = await acquirePdfPipeline();
    try {
        return await operation();
    }
    finally {
        release();
    }
}
/** Bound each newline-delimited JSON-RPC frame before the SDK starts concatenating it. */
class LineLimitedInput extends Transform {
    pending = Buffer.allocUnsafe(MAX_MCP_MESSAGE_BYTES);
    pendingBytes = 0;
    inFlightFrames = 0;
    completeFrame() {
        if (this.inFlightFrames > 0)
            this.inFlightFrames--;
    }
    _transform(chunk, encoding, callback) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        let start = 0;
        while (start < data.length) {
            const newline = data.indexOf(0x0a, start);
            const end = newline === -1 ? data.length : newline;
            const segmentBytes = end - start;
            if (this.pendingBytes + segmentBytes > MAX_MCP_MESSAGE_BYTES) {
                callback(new Error(`MCP message exceeded the ${MAX_MCP_MESSAGE_BYTES.toLocaleString()}-byte limit.`));
                return;
            }
            data.copy(this.pending, this.pendingBytes, start, end);
            this.pendingBytes += segmentBytes;
            if (newline === -1)
                break;
            const framed = Buffer.allocUnsafe(this.pendingBytes + 1);
            this.pending.copy(framed, 0, 0, this.pendingBytes);
            framed[this.pendingBytes] = 0x0a;
            if (this.inFlightFrames >= MAX_INFLIGHT_MCP_REQUESTS) {
                callback(new Error(`More than ${MAX_INFLIGHT_MCP_REQUESTS} MCP messages were in flight without ` +
                    "completed responses."));
                return;
            }
            this.inFlightFrames++;
            this.push(framed);
            this.pendingBytes = 0;
            start = newline + 1;
        }
        callback();
    }
    _flush(callback) {
        if (this.pendingBytes > 0) {
            callback(new Error("MCP input ended with an unterminated JSON-RPC message."));
            return;
        }
        callback();
    }
}
/** Serialize stdout writes and tie input admission to completed protocol responses. */
class BoundedStdioServerTransport extends StdioServerTransport {
    boundedInput;
    sendTail = Promise.resolve();
    inboundRequests = new Map();
    constructor(boundedInput) {
        super(boundedInput, process.stdout);
        this.boundedInput = boundedInput;
        const baseOnData = this._ondata;
        this._ondata = (chunk) => {
            try {
                const message = JSONRPCMessageSchema.parse(JSON.parse(chunk.toString("utf8")));
                this.noteInbound(message);
            }
            catch (error) {
                this.boundedInput.completeFrame();
                this.boundedInput.destroy(error instanceof Error ? error : new Error("Invalid JSON-RPC message."));
                return;
            }
            baseOnData(chunk);
        };
    }
    requestKey(id) {
        return `${typeof id}:${String(id)}`;
    }
    releaseInbound(id) {
        const key = this.requestKey(id);
        if (!this.inboundRequests.delete(key))
            return;
        this.boundedInput.completeFrame();
    }
    noteInbound(message) {
        if ("method" in message && "id" in message) {
            const key = this.requestKey(message.id);
            if (this.inboundRequests.has(key)) {
                throw new Error(`Duplicate outstanding JSON-RPC request id: ${String(message.id)}`);
            }
            this.inboundRequests.set(key, 1);
            return;
        }
        // Notifications and client responses do not receive a response from this
        // server, so their own admission slot completes as soon as they dispatch.
        // Do not release a target request for notifications/cancelled here: unknown
        // methods have no SDK AbortController but may already have a backpressured
        // error response queued. A cancellation may therefore only conservatively
        // retain the target slot until a response is written or the connection hits
        // its bounded in-flight limit and closes.
        this.boundedInput.completeFrame();
    }
    send(message, _options) {
        const operation = this.sendTail.then(() => super.send(message));
        this.sendTail = operation.catch(() => { });
        return operation.finally(() => {
            if (!("method" in message) && "id" in message)
                this.releaseInbound(message.id);
        });
    }
}
async function openAlexSearch(query, opts) {
    const filters = [`locations.source.id:${OPENALEX_SOURCE}`];
    if (opts.yearFrom)
        filters.push(`from_publication_date:${opts.yearFrom}-01-01`);
    if (opts.yearTo)
        filters.push(`to_publication_date:${opts.yearTo}-12-31`);
    if (opts.openAccessOnly)
        filters.push("open_access.is_oa:true");
    // Over-fetch a little when filtering to PDFs so we can still fill `limit`.
    const perPage = Math.min(50, opts.openAccessOnly ? opts.limit * 3 : opts.limit);
    const url = new URL(OPENALEX_WORKS);
    url.searchParams.set("search", query);
    url.searchParams.set("filter", filters.join(","));
    // OpenAlex keeps repository backlogs in its expansion corpus, which is not
    // searched by default. Request both corpora so this repository search stays
    // complete rather than silently omitting older PhilArchive records.
    url.searchParams.set("corpus", "all");
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("select", "id,title,publication_year,authorships,doi,locations,abstract_inverted_index");
    const data = await requestJson(url.toString(), OPENALEX_POLICY, OPENALEX_USER_AGENT, OPENALEX_HEADERS);
    const total = data?.meta?.count ?? 0;
    let hits = asArray(data.results).slice(0, 150).map((w) => {
        const links = philLinks(w);
        return {
            id: links.recId,
            title: String(w.title ?? "(untitled)").slice(0, 2000),
            year: w.publication_year,
            authors: asArray(w.authorships)
                .slice(0, 100)
                .map((a) => a?.author?.display_name)
                .filter(Boolean)
                .map((name) => String(name).slice(0, 500)),
            doi: w.doi ? String(w.doi).slice(0, 2048) : undefined,
            philarchive: links.landing,
            pdf: links.pdfUrl,
            abstract: reconstructAbstract(w.abstract_inverted_index),
        };
    });
    if (opts.openAccessOnly)
        hits = hits.filter((h) => h.pdf);
    hits = hits.slice(0, opts.limit);
    return { total, hits };
}
// ---------------------------------------------------------------------------
// OAI-PMH helpers
// ---------------------------------------------------------------------------
class OaiPmhError extends Error {
    code;
    constructor(code, message) {
        super(`OAI-PMH error [${code}] ${message}`.trim());
        this.code = code;
        this.name = "OaiPmhError";
    }
}
async function oaiRequest(params) {
    const url = new URL(OAI_BASE);
    for (const [k, v] of Object.entries(params))
        url.searchParams.set(k, v);
    const body = await requestText(url.toString(), PHILARCHIVE_POLICY);
    const root = await parseXmlSafely(body);
    const oai = root["OAI-PMH"];
    if (!oai)
        throw new Error("Malformed OAI-PMH response (no OAI-PMH root).");
    if (oai.error) {
        const err = oai.error;
        const code = (Array.isArray(err) ? err[0] : err)?.["@_code"] ?? "unknown";
        const msg = typeof err === "string" ? err : (Array.isArray(err) ? err[0] : err)?.["#text"] ?? "";
        throw new OaiPmhError(String(code), String(msg));
    }
    return oai;
}
function parseOaiRecord(record) {
    const deleted = record?.header?.["@_status"] === "deleted";
    const dc = record?.metadata?.dc ?? {};
    const values = (input, maxItems, maxChars) => asArray(input).slice(0, maxItems).map((value) => String(value).slice(0, maxChars));
    const identifiers = values(dc.identifier, 100, 2048);
    const landing = identifiers.find((s) => /philarchive\.org\/rec\//i.test(s)) ?? identifiers[0];
    return {
        deleted,
        id: landing ? normalizeRecId(landing) : undefined,
        title: values(dc.title, 20, 2000).join(" ").trim().slice(0, 4000),
        authors: values(dc.creator, 100, 500),
        date: values(dc.date, 20, 100).join(", ").slice(0, 1000),
        subjects: values(dc.subject, 200, 500),
        language: values(dc.language, 50, 100).join(", ").slice(0, 1000),
        abstract: values(dc.description, 20, 50_000).join("\n\n").trim().slice(0, 200_000),
        url: landing,
    };
}
/** GetRecord by record id; returns null only when the archive says it does not exist. */
async function fetchOaiMeta(recId) {
    try {
        const oai = await oaiRequest({
            verb: "GetRecord",
            metadataPrefix: "oai_dc",
            identifier: `oai:philarchive.org/rec/${recId}`,
        });
        const record = oai?.GetRecord?.record;
        return record ? parseOaiRecord(record) : null;
    }
    catch (error) {
        if (error instanceof OaiPmhError && error.code === "idDoesNotExist")
            return null;
        throw error;
    }
}
async function probePdfAvailability(recId) {
    const url = `${PDF_BASE}/${recId}.pdf`;
    try {
        const res = await secureRequest(url, {
            method: "HEAD",
            maxBytes: 0,
            timeoutMs: 12_000,
            headers: { "User-Agent": ARCHIVE_USER_AGENT },
            urlPolicy: PHILPAPERS_POLICY,
        });
        if (res.status === 404 || res.status === 410)
            return { state: "unavailable" };
        if (res.status < 200 || res.status >= 300) {
            return { state: "unknown", reason: `probe returned HTTP ${res.status} ${res.statusText}`.trim() };
        }
        const contentType = headerValue(res.headers, "content-type").toLowerCase();
        return contentType.includes("pdf")
            ? { state: "available", url }
            : {
                state: "unknown",
                reason: `probe returned unexpected content-type "${contentType || "unknown"}"`,
            };
    }
    catch (error) {
        return {
            state: "unknown",
            reason: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 500),
        };
    }
}
/** Download a record's open-access PDF; throws clearly when there isn't one. */
async function downloadPdf(recId) {
    const pdfUrl = `${PDF_BASE}/${recId}.pdf`;
    const res = await requestBuffer(pdfUrl, PHILPAPERS_POLICY, MAX_PDF_BYTES);
    const contentType = headerValue(res.headers, "content-type").toLowerCase();
    if (!contentType.includes("pdf")) {
        throw new Error(`No open-access PDF for "${recId}" (server returned content-type "${contentType}"). ` +
            `The paper may not be open access on PhilArchive.`);
    }
    if (!res.body.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
        throw new Error(`Downloaded body for "${recId}" does not contain a PDF header.`);
    }
    return res.body;
}
// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "philosophy", version: "0.5.0" });
// The SDK dispatches requests concurrently. Cap all registered handlers so
// cached/CPU-only calls cannot bypass the network, local-load, and PDF queues
// and build an unbounded stdout backlog.
{
    const registerTool = server.registerTool.bind(server);
    let activeToolCalls = 0;
    server.registerTool = (name, config, callback) => registerTool(name, config, async (...args) => {
        if (activeToolCalls >= MAX_ACTIVE_TOOL_CALLS) {
            return fail("Too many tool calls are active; retry after an existing call finishes.");
        }
        activeToolCalls++;
        try {
            return await callback(...args);
        }
        finally {
            activeToolCalls--;
        }
    });
}
server.registerTool("search_papers", {
    title: "Search philosophy papers",
    description: "Keyword search across PhilPapers / PhilArchive (philosophy preprints and published " +
        "papers indexed by the PhilPapers Foundation), powered by OpenAlex full-text search. " +
        "Returns title, authors, year, a short abstract, the PhilArchive record id + URL, and an " +
        "open-access PDF URL when one exists. Use the returned `id` with get_paper, research, or " +
        "fetch_pdf. For a richer one-shot digest with full abstracts, use `research` instead.",
    inputSchema: {
        query: QUERY_INPUT.describe("Search terms, e.g. 'phenomenal consciousness higher-order'."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(10)
            .describe("Max results to return (1–50, default 10)."),
        year_from: YEAR_INPUT.optional().describe("Only papers published in or after this year."),
        year_to: YEAR_INPUT.optional().describe("Only papers published in or before this year."),
        open_access_only: z
            .boolean()
            .default(false)
            .describe("Only return papers that have a downloadable open-access PDF on PhilArchive."),
    },
}, async ({ query, limit, year_from, year_to, open_access_only }) => {
    try {
        const { total, hits } = await openAlexSearch(query, {
            limit,
            yearFrom: year_from,
            yearTo: year_to,
            openAccessOnly: open_access_only,
        });
        if (hits.length === 0)
            return ok(`No PhilPapers/PhilArchive results for "${query}".`);
        const lines = hits.map((it, i) => {
            const authors = it.authors.length
                ? it.authors.slice(0, 6).join(", ") + (it.authors.length > 6 ? ", et al." : "")
                : "(authors unknown)";
            const parts = [
                `${i + 1}. ${it.title}${it.year ? ` (${it.year})` : ""}`,
                `   id: ${it.id ?? "—"}`,
                `   authors: ${authors}`,
                `   philarchive: ${it.philarchive ?? "—"}`,
                `   pdf: ${it.pdf ?? "— (not open access)"}`,
            ];
            if (it.doi)
                parts.push(`   doi: ${it.doi}`);
            if (it.abstract)
                parts.push(`   abstract: ${truncate(it.abstract, 400)}`);
            return parts.join("\n");
        });
        const header = `Found ${total.toLocaleString()} match(es) in PhilPapers/PhilArchive; ` +
            `showing ${hits.length}${open_access_only ? " (open-access only)" : ""}.`;
        return ok([header, "", ...lines].join("\n"));
    }
    catch (e) {
        return fail(`search_papers failed: ${e?.message ?? e}`);
    }
});
server.registerTool("research", {
    title: "Research a topic (search + full abstracts)",
    description: "One-shot literature scan: runs a keyword search across PhilPapers/PhilArchive and, for " +
        "each hit, fetches the archive's canonical metadata (verbatim full abstract, subjects, " +
        "language) via OAI-PMH — so you get a ready-to-read digest in a single call instead of " +
        "search_papers + get_paper per result. Returns fewer results than search_papers by default " +
        "because it does more work per item.",
    inputSchema: {
        query: QUERY_INPUT.describe("Topic or search terms to research."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .default(5)
            .describe("How many papers to include with full abstracts (1–20, default 5)."),
        year_from: YEAR_INPUT.optional().describe("Only papers published in or after this year."),
        year_to: YEAR_INPUT.optional().describe("Only papers published in or before this year."),
        open_access_only: z
            .boolean()
            .default(false)
            .describe("Only include papers with a downloadable open-access PDF."),
    },
}, async ({ query, limit, year_from, year_to, open_access_only }) => {
    try {
        const { total, hits } = await openAlexSearch(query, {
            limit,
            yearFrom: year_from,
            yearTo: year_to,
            openAccessOnly: open_access_only,
        });
        if (hits.length === 0)
            return ok(`No PhilPapers/PhilArchive results for "${query}".`);
        // Enrich every hit with canonical OAI metadata in parallel.
        const enriched = await mapWithConcurrency(hits, 4, async (h) => {
            // A literature scan still has useful OpenAlex metadata when the OAI
            // enrichment endpoint is temporarily unavailable. The single-record
            // get_paper tool, by contrast, reports that upstream failure clearly.
            const meta = h.id ? await fetchOaiMeta(h.id).catch(() => null) : null;
            const usable = meta && !meta.deleted ? meta : null;
            const oaiAbstract = usable?.abstract ?? "";
            return {
                ...h,
                // Prefer the archive's verbatim abstract when it's at least as complete.
                abstract: oaiAbstract.length >= h.abstract.length ? oaiAbstract : h.abstract,
                subjects: usable?.subjects ?? [],
            };
        });
        const blocks = enriched.map((it, i) => {
            const authors = it.authors.length ? it.authors.join(", ") : "(authors unknown)";
            return [
                `### ${i + 1}. ${it.title}${it.year ? ` (${it.year})` : ""}`,
                `- id: ${it.id ?? "—"}`,
                `- authors: ${authors}`,
                it.subjects.length ? `- subjects: ${it.subjects.join(", ")}` : "",
                `- philarchive: ${it.philarchive ?? "—"}`,
                `- pdf: ${it.pdf ?? "— (not open access)"}`,
                it.doi ? `- doi: ${it.doi}` : "",
                "",
                it.abstract || "(no abstract available)",
            ]
                .filter(Boolean)
                .join("\n");
        });
        const header = `# Research: "${query}"\n${total.toLocaleString()} total match(es) in ` +
            `PhilPapers/PhilArchive; showing ${enriched.length}` +
            `${open_access_only ? " (open-access only)" : ""} with full abstracts.`;
        return ok([header, ...blocks].join("\n\n"));
    }
    catch (e) {
        return fail(`research failed: ${e?.message ?? e}`);
    }
});
server.registerTool("get_paper", {
    title: "Get paper metadata",
    description: "Fetch canonical metadata for one PhilArchive/PhilPapers record via OAI-PMH. " +
        "Accepts a record id (e.g. 'BROTNO-9'), a philarchive.org/philpapers.org /rec/ URL, " +
        "or an oai: identifier. Returns title, authors, date, subjects, language, full abstract, " +
        "the landing-page URL, and whether an open-access PDF is available.",
    inputSchema: {
        id: RECORD_ID_INPUT.describe("PhilArchive record id or URL, e.g. 'BROTNO-9'."),
    },
}, async ({ id }) => {
    try {
        const recId = assertSafeRecId(normalizeRecId(id));
        const meta = await fetchOaiMeta(recId);
        if (!meta)
            return fail(`No record found for id "${recId}".`);
        if (meta.deleted)
            return fail(`Record "${recId}" is marked deleted in PhilArchive.`);
        const pdf = await probePdfAvailability(meta.id ?? recId);
        const pdfDescription = pdf.state === "available"
            ? pdf.url
            : pdf.state === "unavailable"
                ? "not available"
                : `availability unknown (${pdf.reason})`;
        const lines = [
            `Title: ${meta.title || "(untitled)"}`,
            `Authors: ${meta.authors.join("; ") || "(unknown)"}`,
            `Date: ${meta.date || "(unknown)"}`,
            `Language: ${meta.language || "(unspecified)"}`,
            `Subjects: ${meta.subjects.join(", ") || "(none)"}`,
            `URL: ${meta.url ?? `https://philarchive.org/rec/${recId}`}`,
            `Open-access PDF: ${pdfDescription}`,
            "",
            "Abstract:",
            meta.abstract || "(no abstract provided)",
        ];
        return ok(lines.join("\n"));
    }
    catch (e) {
        return fail(`get_paper failed: ${e?.message ?? e}`);
    }
});
server.registerTool("list_recent", {
    title: "List recent submissions",
    description: "List recently added/updated PhilArchive records in a date window, via OAI-PMH " +
        "(harvesting, not keyword search). Returns the first page of results (~up to `limit`). " +
        "Dates are UTC YYYY-MM-DD; defaults to the last 7 days.",
    inputSchema: {
        from: ISO_DATE_INPUT.optional().describe("Start date (YYYY-MM-DD, UTC). Default: 7 days ago."),
        until: ISO_DATE_INPUT.optional().describe("End date (YYYY-MM-DD, UTC). Default: now."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(20)
            .describe("Max records from the first page (1–100, default 20)."),
    },
}, async ({ from, until, limit }) => {
    try {
        const dayMs = 86_400_000;
        const fromDate = (from ?? new Date(Date.now() - 7 * dayMs).toISOString().slice(0, 10)).slice(0, 10);
        if (until && fromDate > until)
            return fail("list_recent requires from <= until.");
        const params = {
            verb: "ListRecords",
            metadataPrefix: "oai_dc",
            from: `${fromDate}T00:00:00Z`,
        };
        if (until)
            params.until = `${until.slice(0, 10)}T23:59:59Z`;
        const oai = await oaiRequest(params);
        const all = asArray(oai?.ListRecords?.record).map(parseOaiRecord).filter((r) => !r.deleted);
        const records = all.slice(0, limit);
        if (records.length === 0) {
            return ok(`No PhilArchive records found from ${fromDate}${until ? ` to ${until}` : ""}.`);
        }
        const lines = records.map((r, i) => {
            const authors = r.authors.slice(0, 5).join(", ") + (r.authors.length > 5 ? ", et al." : "");
            return [
                `${i + 1}. ${r.title || "(untitled)"}${r.date ? ` [${r.date}]` : ""}`,
                `   id: ${r.id ?? "—"}  |  ${r.url ?? ""}`,
                `   authors: ${authors || "(unknown)"}`,
                r.abstract ? `   abstract: ${truncate(r.abstract, 240)}` : "",
            ]
                .filter(Boolean)
                .join("\n");
        });
        const more = all.length > records.length ? " (more available)" : "";
        return ok([
            `PhilArchive records since ${fromDate}${until ? ` until ${until}` : ""} — ${records.length}${more}:`,
            "",
            ...lines,
        ].join("\n"));
    }
    catch (e) {
        return fail(`list_recent failed: ${e?.message ?? e}`);
    }
});
server.registerTool("fetch_pdf", {
    title: "Download paper PDF",
    description: "Download the open-access PDF of a PhilArchive record and save it into the server's " +
        "private download directory (optionally set via PHILPAPERS_DOWNLOAD_DIR), returning the file " +
        "path so it can be read. Accepts a record id or URL. Fails clearly if the paper has no " +
        "open-access PDF. To get the text directly instead of a file, use get_fulltext.",
    inputSchema: {
        id: RECORD_ID_INPUT.describe("PhilArchive record id or URL, e.g. 'BROTNO-9'."),
    },
}, async ({ id }) => {
    try {
        const recId = assertSafeRecId(normalizeRecId(id));
        return await withPdfPipeline(async () => {
            const buf = await downloadPdf(recId);
            const file = await savePdfSafely(recId, buf);
            return ok([
                `Saved PhilArchive PDF for "${recId}".`,
                `Path: ${file}`,
                `Size: ${(buf.length / 1024).toFixed(1)} KiB`,
                `Source: ${PDF_BASE}/${recId}.pdf`,
            ].join("\n"));
        });
    }
    catch (e) {
        return fail(`fetch_pdf failed: ${e?.message ?? e}`);
    }
});
/**
 * Cache of extracted PDF bodies, keyed by record id. Extraction (download +
 * unpdf parse) is the expensive part, so paging through a paper with offset=
 * reuses the parse instead of re-downloading the whole PDF each call.
 */
const fulltextCache = new LruCache(4, 64 * 1024 * 1024, (entry) => Buffer.byteLength(entry.text));
const fulltextInFlight = new Map();
server.registerTool("get_fulltext", {
    title: "Get paper full text",
    description: "Download a PhilArchive record's open-access PDF and extract its full text. Accepts a record " +
        "id or URL. Returns one window of max_chars starting at offset (default the first 15000 chars); " +
        "for a long paper, read a window and continue with the offset reported in the footer instead of " +
        "pulling the whole thing at once. The extracted text is cached, so paging doesn't re-download. " +
        "Fails clearly if the paper has no open-access PDF.",
    inputSchema: {
        id: RECORD_ID_INPUT.describe("PhilArchive record id or URL, e.g. 'BROTNO-9'."),
        max_chars: z
            .number()
            .int()
            .min(500)
            .max(200_000)
            .default(15_000)
            .describe("Max characters of extracted text to return in this window (default 15000)."),
        offset: z
            .number()
            .int()
            .min(0)
            .max(100_000_000)
            .default(0)
            .describe("Character offset to start from (default 0). Continue a long paper with the offset " +
            "reported in the previous call's footer — avoids re-sending earlier text."),
    },
}, async ({ id, max_chars, offset }) => {
    try {
        const recId = assertSafeRecId(normalizeRecId(id));
        let entry = fulltextCache.get(recId);
        if (!entry) {
            let pending = fulltextInFlight.get(recId);
            if (!pending) {
                pending = withPdfPipeline(async () => {
                    const buf = await downloadPdf(recId);
                    const extracted = await extractPdfSafely(buf, {
                        mergePages: true,
                        maxChars: MAX_FULLTEXT_CHARS,
                    });
                    const loaded = { text: extracted.text ?? "", totalPages: extracted.totalPages };
                    fulltextCache.set(recId, loaded);
                    return loaded;
                });
                fulltextInFlight.set(recId, pending);
                void pending.finally(() => {
                    if (fulltextInFlight.get(recId) === pending)
                        fulltextInFlight.delete(recId);
                }).catch(() => { });
            }
            entry = await pending;
        }
        const source = `Source: ${PDF_BASE}/${recId}.pdf`;
        if (entry.text.length === 0) {
            return ok(`Full text of "${recId}" — ${entry.totalPages} page(s).\n${source}\n\n` +
                "(no extractable text — the PDF may be image-only)");
        }
        const w = windowText(entry.text, max_chars, offset);
        if (w.slice === "") {
            return ok(`Full text of "${recId}".\n${source}\n\n${pastEndNote(w.total, w.start)}`);
        }
        const header = `Full text of "${recId}" — ${entry.totalPages} page(s), ${w.total.toLocaleString()} chars total.\n` +
            source;
        return ok(`${header}\n\n${w.slice}${windowNote(w)}`);
    }
    catch (e) {
        return fail(`get_fulltext failed: ${e?.message ?? e}`);
    }
});
// Book & reference tools (Gutenberg, Internet Archive, Wikisource, Open Library,
// DOAB, Stanford Encyclopedia, fetch_text).
registerBookTools(server);
// Local document tools (info / search / read for large local PDFs & text files)
// — work a long local file without loading it whole into context.
registerLocalTools(server);
// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
    const input = new LineLimitedInput();
    const transport = new BoundedStdioServerTransport(input);
    const keepAlive = setInterval(() => { }, 60_000);
    let finishTerminal;
    const terminal = new Promise((resolve) => {
        let finished = false;
        finishTerminal = (error) => {
            if (finished)
                return;
            finished = true;
            clearInterval(keepAlive);
            resolve(error);
        };
    });
    input.once("end", () => finishTerminal());
    input.once("close", () => finishTerminal());
    input.once("error", (error) => finishTerminal(error));
    process.stdin.once("error", (error) => finishTerminal(error));
    process.stdin.pipe(input);
    try {
        await server.connect(transport);
    }
    catch (error) {
        clearInterval(keepAlive);
        process.stdin.unpipe(input);
        process.stdin.pause();
        throw error;
    }
    // stdout is the protocol channel — log only to stderr.
    console.error("philosophy-mcp running on stdio");
    // Some Node versions do not keep a piped stdin stream referenced after the
    // transport attaches its listeners. Keep the process alive explicitly, then
    // return cleanly when the client closes stdin instead of racing process.exit().
    process.stdin.resume();
    const terminalError = await terminal;
    process.stdin.unpipe(input);
    process.stdin.pause();
    await server.close().catch(() => { });
    await shutdownPdfParsers();
    if (terminalError)
        throw terminalError;
    // EOF on the protocol input means the stdio client has disconnected. Node's
    // special process.stdout stream cannot be reliably destroyed while a pipe is
    // backpressured, so exit explicitly after closing the server and intentionally
    // discard responses that the disconnected client can no longer consume.
    process.exit(0);
}
let signalShutdownStarted = false;
async function shutdownForSignal(exitCode) {
    if (signalShutdownStarted)
        return;
    signalShutdownStarted = true;
    await server.close().catch(() => { });
    await shutdownPdfParsers();
    process.exit(exitCode);
}
process.once("SIGTERM", () => void shutdownForSignal(143));
process.once("SIGINT", () => void shutdownForSignal(130));
main().catch(async (e) => {
    console.error("Fatal:", e);
    await shutdownPdfParsers();
    process.exit(1);
});
