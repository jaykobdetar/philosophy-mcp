# philosophy-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An MCP server for **philosophy texts** — both current scholarship and the canon.
It folds these into one keyless server:

- **PhilPapers / PhilArchive** — the philosophy preprint archive (the field's closest
  analog to arXiv): search papers, read abstracts, browse recent submissions, pull full text.
- **Books, classics & reference** — public-domain originals and translations (Project
  Gutenberg, Internet Archive, Wikisource), open-access academic books (DOAB), modern
  editions (Open Library), and the Stanford Encyclopedia of Philosophy. The generic
  `fetch_text` tool is available only for explicitly allowlisted hosts.
- **Local documents** — open a large local PDF or text file and work it without loading the
  whole thing into context: outline, in-file search, and paged reading.

**No API key required.** Everything runs against keyless public endpoints.

> Renamed and expanded from **philpapers-mcp** (which covered only the PhilPapers tools).
> The `philpapers-mcp` binary name still works as an alias.

## Tools

### Philosophy scholarship (PhilPapers / PhilArchive)

| Tool | What it does | Backend |
| --- | --- | --- |
| `search_papers` | Keyword search (title/abstract/full text), returns metadata + PhilArchive links + PDF URL | OpenAlex, filtered to the PhilPapers Foundation source |
| `research` | One-shot scan: search **and** pull each hit's verbatim full abstract + subjects in a single call | OpenAlex + OAI-PMH `GetRecord` |
| `get_paper` | Canonical metadata + full abstract for one record id | PhilArchive OAI-PMH `GetRecord` |
| `list_recent` | Records added/updated in a date window | PhilArchive OAI-PMH `ListRecords` |
| `fetch_pdf` | Download a record's open-access PDF to disk, return the path | `philpapers.org/archive/<ID>.pdf` |
| `get_fulltext` | Download the open-access PDF and return its **extracted full text** | PDF + `unpdf` text extraction |

PhilArchive is the open-access archive built on the PhilPapers database, so a record id
such as `BROTNO-9` resolves on both `philarchive.org` and `philpapers.org`.

### Books, classics & reference

| Tool | What it does | Source |
| --- | --- | --- |
| `search_gutenberg` / `get_gutenberg_text` | Find and read public-domain classics + out-of-copyright translations | Project Gutenberg (Gutendex, with a gutenberg.org fallback) |
| `search_internet_archive` / `get_archive_text` | Find scanned, out-of-print works and read their OCR text | Internet Archive |
| `search_wikisource` / `get_wikisource_text` | Find and read primary texts/translations in any language (en, de, ko, …) | Wikisource |
| `search_openlibrary` | Modern editions & translations as metadata, with read/borrow links | Open Library |
| `search_doab` | Peer-reviewed, fully open-access academic books (readable in full) | DOAB |
| `search_sep` / `get_sep_entry` | Search and read the standard scholarly reference | Stanford Encyclopedia of Philosophy |
| `fetch_text` | Readable text from an exact hostname configured in `PHILOSOPHY_FETCH_HOSTS`; disabled by default | explicitly allowed sites |

All text-returning tools (`get_fulltext`, the `get_*_text` readers, `get_sep_entry`,
`fetch_text`) return **one window** — `max_chars` characters (default 15000) starting at
`offset` (default 0). When the body is longer, the footer reports the next `offset` to
continue from, so you page through a long work a window at a time instead of dumping it whole
(and re-dumping from the start to read further). Each fetched/extracted body is cached, so
paging doesn't re-download or re-parse the source.

### Local documents

| Tool | What it does |
| --- | --- |
| `local_doc_info` | Overview of a local PDF/text file — pages, characters, ~tokens, and a heuristic outline — without loading the whole file |
| `local_doc_search` | Find literal keywords or phrases and return just the matching snippets with page numbers |
| `local_doc_read` | Read a bounded page range / chunk, capped at `max_chars` so it can't flood context, reporting the next page to continue from |

These read a large local file the way you'd skim a thick book — get an outline, jump to the
relevant pages by searching, then read a chunk at a time — so only the parts that matter reach
the context. Local access is disabled by default. Enable it with `PHILOSOPHY_DOC_ROOTS`, pointing
only at dedicated document directories. The server never adds `$HOME` implicitly, rejects hidden
and extensionless files, resolves symlinks before checking containment, and applies file-size and
PDF-extraction limits.

## Example

`search_papers` with `{ "query": "phenomenal consciousness higher-order", "open_access_only": true, "limit": 2 }`:

```
Found 1,806 match(es) in PhilPapers/PhilArchive; showing 2 (open-access only).

1. The HOROR theory of phenomenal consciousness (2014)
   id: BROTNO-9
   authors: Richard Brown
   philarchive: https://philarchive.org/rec/BROTNO-9
   pdf: https://philpapers.org/archive/BROTNO-9.pdf
```

Then `get_fulltext` with `{ "id": "BROTNO-9" }` returns the paper's extracted full text.

For the canon: `search_gutenberg` with `{ "query": "kant critique", "languages": "en" }` returns book
ids, and `get_gutenberg_text` with `{ "book_id": 4280 }` reads *The Critique of Pure Reason* directly;
`search_sep` → `get_sep_entry` reads an encyclopedia entry. After explicitly allowing a hostname,
`fetch_text` can read a source without a dedicated tool.

> 20th-century authors still in copyright (Heidegger, Adorno, Gadamer, Habermas) won't have free
> full texts here — you'll get metadata, SEP coverage, and read/borrow links.

## Setup

Use Node 22 or newer and install from this reviewed checkout. Do not replace it with an
unreviewed copy of the upstream repository:

```bash
cd philosophy-mcp
npm ci --ignore-scripts
npm run build
```

### Updating

Upstream changes may alter the security boundaries described below. Review and test them before
merging them into this hardened branch. After any update, rebuild and **restart the MCP server**
(reconnect in Claude Code, or restart Claude Desktop) so it loads the new build. Maintainers:
rebuild and commit `dist/` whenever `src/` changes — CI fails if the two drift.

## Register with Claude Code

```bash
claude mcp add philosophy -- node /absolute/path/to/philosophy-mcp/dist/index.js
```

To enable local documents, point the server at a dedicated directory rather than your home folder:

```bash
claude mcp add philosophy \
  -e PHILOSOPHY_DOC_ROOTS=/absolute/path/to/philosophy-documents \
  -- node /absolute/path/to/philosophy-mcp/dist/index.js
```

Then `/mcp` inside Claude Code lists `philosophy` with its tools.

## Register with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "philosophy": {
      "command": "node",
      "args": ["/absolute/path/to/philosophy-mcp/dist/index.js"],
      "env": {
        "OPENALEX_MAILTO": "you@example.com",
        "PHILOSOPHY_DOC_ROOTS": "/absolute/path/to/philosophy-documents"
      }
    }
  }
}
```

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `OPENALEX_API_KEY` | unset; anonymous access | Optional OpenAlex bearer credential for a higher request budget. It is sent only in the Authorization header and must be treated as a secret. |
| `OPENALEX_MAILTO` | project repository URL | Optional operator contact included in the OpenAlex User-Agent. It no longer changes OpenAlex request limits. |
| `PHILOSOPHY_CONTACT` | `OPENALEX_MAILTO`, then project repository URL | Operator email or URL included in book/reference request identification. An email is recommended for regular Open Library use. |
| `PHILPAPERS_DOWNLOAD_DIR` | private per-user directory under OS temp | Persistent, quota-managed directory where `fetch_pdf` saves 0600 files; it is not automatically cleaned between runs. If set, it must be absolute, owned by the current user, and mode 0700. |
| `PHILPAPERS_MAX_PDF_BYTES` | `33554432` | Maximum downloaded PDF size. |
| `PHILPAPERS_MAX_DOWNLOAD_TOTAL_BYTES` | `536870912` | Aggregate quota for generated PDF and in-progress download files. |
| `PHILPAPERS_MAX_DOWNLOAD_FILES` | `64` | Aggregate generated-file count, including in-progress files. |
| `PHILPAPERS_MAX_PENDING_DOWNLOADS` | `4` | Maximum active/queued PDF publications; excess calls fail fast. |
| `PHILOSOPHY_DOC_ROOTS` | unset; local access disabled | Delimiter-separated absolute document directories. These replace the old implicit-home behavior. |
| `PHILOSOPHY_FETCH_HOSTS` | unset; `fetch_text` disabled | Comma-separated exact public hostnames that `fetch_text` may contact. |
| `PHILOSOPHY_MAX_LOCAL_FILE_BYTES` | `33554432` | Maximum local document size. |
| `PHILOSOPHY_MAX_EXTRACTED_CHARS` | `20000000` | Maximum extracted characters from one local PDF/text document. |
| `PHILOSOPHY_MAX_DOCUMENT_PAGES` | `20000` | Maximum pages or form-feed-delimited text sections in a local document. |
| `PHILOSOPHY_MAX_LOCAL_CACHE_BYTES` | `67108864` | Maximum local-document cache weight. |
| `PHILOSOPHY_MAX_REMOTE_TEXT_BYTES` | `33554432` | Maximum body size for dedicated book/reference readers. |
| `PHILOSOPHY_MAX_GENERIC_FETCH_BYTES` | `8388608` | Maximum body size for `fetch_text`. |
| `PHILOSOPHY_MAX_REMOTE_CACHE_BYTES` | `67108864` | Maximum remote-text cache weight. |
| `PHILOSOPHY_MAX_PDF_WORKERS` | `1` | Maximum simultaneous isolated PDF parser processes (range 1–4). |
| `PHILOSOPHY_MAX_PDF_QUEUE` | `4` | Maximum queued PDF extractions; excess calls fail fast. |
| `PHILOSOPHY_MAX_PDF_PAGES` | `10000` | Default page limit enforced inside the PDF parser process. |

## Security boundaries

- Every outbound connection resolves and validates public IP addresses once, then pins the socket
  to those checked addresses. Redirects are followed manually and revalidated on every hop.
- Dedicated tools enforce exact service hostnames. HTTPS downgrades, URL credentials, private/LAN
  addresses, special-use IP ranges, unsafe ports, and mixed public/private DNS answers are rejected.
- Remote and local bodies have byte limits. PDF parsing runs in a separate heap-limited process;
  metadata parsing runs in a heap-limited worker. Both have wall timeouts and bounded admission
  queues, and PDFs also have a page cap. Caches are
  bounded by entry count and bytes.
- Local documents are opt-in and restricted to explicit roots. JavaScript regular-expression search
  is disabled; `local_doc_search` performs literal matching. On Linux, the opened descriptor itself
  is checked through `/proc/self/fd` to close intermediate-symlink races.
- `fetch_pdf` writes through an exclusive 0600 temporary file into a private directory, then
  publishes a unique filename atomically. All writes stay anchored to an opened directory descriptor;
  platforms without a usable descriptor filesystem fail closed. Aggregate file/byte quotas and a
  bounded publication queue prevent repeated calls from filling storage or retaining unlimited PDF buffers.
- JSON-RPC input lines, tool input strings, tool outputs, concurrent network requests, local loads,
  and generated-document page counts all have explicit bounds.
- Direct dependency versions are exact and the published package includes `npm-shrinkwrap.json`, so
  installs use the reviewed transitive dependency graph rather than floating to newer releases.

Retrieved pages, OCR, PDFs, and local documents remain **untrusted content**: they can contain text
that attempts to influence an AI client. Keep tool approvals enabled for consequential actions and
run the server with a dedicated low-privilege account or sandbox when handling adversarial files.
For hostile PDFs, also apply an OS/container memory limit: the parser subprocess has a V8 heap
limit and wall timeout, but those do not hard-cap every native or typed-array allocation. MCP
cancellation is handled conservatively, so canceled work may retain a bounded slot until its own
deadline or until the client reconnects.
On non-Linux POSIX systems, local-file validation combines trusted path-component checks with
repeated canonical-path and inode checks because Node does not expose Linux's descriptor path.
Windows local-document access and PDF publication fail closed because Node cannot enforce the
required ownership, permission, and descriptor-relative path guarantees there.

## Smoke test

```bash
npm test
```

The test command rebuilds committed `dist/`, runs focused network, filesystem, download, cache,
PDF-parser, prompt-boundary, and MCP integration regressions, then runs `smoke-test.mjs`. The tests
do not require live network access. The older `node test-client.mjs` exercises a smaller set of live
source calls.

## Notes & limits

- The book/reference tools are keyless and read-only. Search tools return compact lists; the
  `get_*` / `fetch_text` tools return one `max_chars` window from `offset` and report the next
  `offset` to continue — page through long works instead of pulling them whole.
- **Gutendex** (the Project Gutenberg API host) is frequently overloaded; `search_gutenberg`
  probes it briefly and falls back to gutenberg.org's OPDS feed. `get_gutenberg_text` reads the
  text directly from gutenberg.org, so it works even when Gutendex is down.
- **SEP** has no keyword API (its on-site search is JavaScript-driven), so `search_sep` matches
  against the published entry index (`contents.html`) — i.e. title/topic matching.
- `list_recent` filters on the OAI **datestamp**, returns only the first OAI page, and not every
  record has an open-access PDF — `get_paper` reports availability; `fetch_pdf` fails clearly.

## Publishing (maintainers)

CI (`.github/workflows/ci.yml`) builds on Node 22/24 for every push and PR.

To publish a new version to npm:

1. In the package settings on npmjs.com, configure `.github/workflows/publish.yml` from this
   repository as a **Trusted Publisher** allowed to run `npm publish`. The workflow uses OIDC and
   does not require a long-lived npm token. The package owner must perform an initial manual publish
   before configuring this relationship if the package does not exist yet.
2. Bump the version and tag: `npm version patch && git push --follow-tags`.
3. Cut a GitHub Release — `.github/workflows/publish.yml` runs `npm publish` automatically.

For an initial manual publish, use `npm login` or a narrowly scoped granular access token, then run
`npm publish --access public`.

## License

MIT
