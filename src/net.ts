import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type UrlPolicy = (url: URL) => void | Promise<void>;

export interface SecureRequestOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  resolver?: Resolver;
  urlPolicy?: UrlPolicy;
}

export interface SecureResponse {
  url: string;
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export class NetworkSecurityError extends Error {
  override name = "NetworkSecurityError";
}

export class ResponseTooLargeError extends Error {
  override name = "ResponseTooLargeError";
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_ACTIVE_REQUESTS = 8;
const MAX_QUEUED_REQUESTS = 32;
const MAX_RESERVED_RESPONSE_BYTES = 64 * 1024 * 1024;
let activeRequests = 0;
let reservedResponseBytes = 0;
const requestWaiters: Array<{ weight: number; resolve: () => void }> = [];

function requestFits(weight: number): boolean {
  return (
    activeRequests < MAX_ACTIVE_REQUESTS &&
    (reservedResponseBytes + weight <= MAX_RESERVED_RESPONSE_BYTES || activeRequests === 0)
  );
}

function admitWaitingRequests(): void {
  while (requestWaiters.length > 0 && requestFits(requestWaiters[0].weight)) {
    const next = requestWaiters.shift()!;
    activeRequests++;
    reservedResponseBytes += next.weight;
    next.resolve();
  }
}

async function acquireRequestSlot(weight: number, timeoutMs: number): Promise<() => void> {
  if (requestWaiters.length === 0 && requestFits(weight)) {
    activeRequests++;
    reservedResponseBytes += weight;
  } else {
    if (requestWaiters.length >= MAX_QUEUED_REQUESTS) {
      throw new NetworkSecurityError("Too many concurrent outbound requests; try again later.");
    }
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const waiter = {
        weight,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      requestWaiters.push(waiter);
      timer = setTimeout(() => {
        const index = requestWaiters.indexOf(waiter);
        if (index === -1) return;
        requestWaiters.splice(index, 1);
        admitWaitingRequests();
        reject(new Error(`Outbound request admission timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      timer.unref();
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRequests--;
    reservedResponseBytes -= weight;
    admitWaitingRequests();
  };
}

const BLOCKED_V4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, "ipv4");
}

// Public unicast IPv6 comes from 2000::/3. Exclude special-use ranges within it.
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, "ipv6");
}

/** True only for globally routable unicast addresses. */
export function isPublicIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !BLOCKED_V4.check(address, "ipv4");
  if (version === 6) {
    return GLOBAL_V6.check(address, "ipv6") && !BLOCKED_V6.check(address, "ipv6");
  }
  return false;
}

function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** Parse a URL and reject schemes or authority syntax that should never reach the network. */
export function parsePublicHttpUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = raw instanceof URL ? new URL(raw.toString()) : new URL(raw);
  } catch {
    throw new NetworkSecurityError(`Invalid URL: ${String(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NetworkSecurityError(`Only http(s) URLs are allowed (got "${url.protocol}").`);
  }
  if (url.username || url.password) {
    throw new NetworkSecurityError("URLs containing credentials are not allowed.");
  }
  const host = bareHostname(url);
  if (!host) throw new NetworkSecurityError("URL has no hostname.");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new NetworkSecurityError("Refusing to contact localhost.");
  }
  url.hash = "";
  return url;
}

export function hostAllowlistPolicy(
  hosts: Iterable<string>,
  options: { allowSubdomains?: boolean; requireHttps?: boolean } = {},
): UrlPolicy {
  const allowed = [...hosts].map((host) => host.toLowerCase().replace(/\.$/, ""));
  if (allowed.length === 0) {
    throw new NetworkSecurityError("URL host allowlist is empty.");
  }
  return (url) => {
    const host = bareHostname(url);
    const hostAllowed = allowed.some(
      (entry) => host === entry || (options.allowSubdomains && host.endsWith(`.${entry}`)),
    );
    if (!hostAllowed) throw new NetworkSecurityError(`Host "${host}" is not allowed for this tool.`);
    if ((options.requireHttps ?? true) && url.protocol !== "https:") {
      throw new NetworkSecurityError("This tool requires HTTPS.");
    }
    if (url.port && url.port !== "443") {
      throw new NetworkSecurityError("Non-default ports are not allowed for this tool.");
    }
  };
}

const systemResolver: Resolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers
    .filter((answer): answer is { address: string; family: 4 | 6 } =>
      answer.family === 4 || answer.family === 6,
    )
    .map(({ address, family }) => ({ address, family }));
};

/** Resolve once, reject mixed/private results, and return addresses to pin at connect time. */
export async function resolvePublicAddresses(
  url: URL,
  resolver: Resolver = systemResolver,
): Promise<ResolvedAddress[]> {
  const hostname = bareHostname(url);
  const literalVersion = isIP(hostname);
  const addresses: ResolvedAddress[] = literalVersion
    ? [{ address: hostname, family: literalVersion as 4 | 6 }]
    : await resolver(hostname);
  if (addresses.length === 0) {
    throw new NetworkSecurityError(`Could not resolve host "${hostname}".`);
  }
  for (const answer of addresses) {
    if (!isPublicIp(answer.address)) {
      throw new NetworkSecurityError(
        `Refusing to contact "${hostname}" because it resolves to non-public address ` +
          `${answer.address}.`,
      );
    }
  }
  return addresses;
}

export function pinnedLookup(addresses: ResolvedAddress[]): NonNullable<RequestOptions["lookup"]> {
  // Node's LookupFunction has several overloads. This implementation handles the
  // `family` and `all` forms while never performing another DNS lookup.
  return ((_hostname: string, options: any, callback: any) => {
    const requestedFamily =
      typeof options === "number" ? options : Number(options?.family ?? 0);
    const candidates = requestedFamily
      ? addresses.filter((entry) => entry.family === requestedFamily)
      : addresses;
    if (candidates.length === 0) {
      callback(new Error(`No validated address for requested family ${requestedFamily}.`));
      return;
    }
    if (typeof options === "object" && options?.all) {
      callback(null, candidates);
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  }) as NonNullable<RequestOptions["lookup"]>;
}

export function resolveRedirectTarget(current: URL, location: string): URL {
  let next: URL;
  try {
    next = parsePublicHttpUrl(new URL(location, current));
  } catch (error) {
    if (error instanceof NetworkSecurityError) throw error;
    throw new NetworkSecurityError(`Invalid redirect target: ${location}`);
  }
  if (current.protocol === "https:" && next.protocol !== "https:") {
    throw new NetworkSecurityError("Refusing an HTTPS-to-HTTP redirect.");
  }
  return next;
}

export async function readStreamLimited(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of stream) {
    const chunk = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw);
    total += chunk.length;
    if (total > maxBytes) {
      throw new ResponseTooLargeError(
        `Response exceeded the ${maxBytes.toLocaleString()}-byte limit.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestOnce(
  url: URL,
  addresses: ResolvedAddress[],
  opts: Required<Pick<SecureRequestOptions, "method" | "maxBytes" | "timeoutMs">> & {
    headers: Record<string, string>;
  },
): Promise<SecureResponse> {
  return await new Promise<SecureResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, response?: SecureResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: opts.method,
        headers: { "Accept-Encoding": "identity", ...opts.headers },
        agent: false,
        lookup: pinnedLookup(addresses),
        maxHeaderSize: 32 * 1024,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const redirect = REDIRECT_STATUS.has(status) && firstHeader(res.headers, "location");
        if (redirect || opts.method === "HEAD") {
          // We do not need a redirect/HEAD body. Destroy the response instead of
          // draining it without a limit after this hop has already completed.
          res.destroy();
          finish(undefined, {
            url: url.toString(),
            status,
            statusText: res.statusMessage ?? "",
            headers: res.headers,
            body: Buffer.alloc(0),
          });
          return;
        }

        const declared = firstHeader(res.headers, "content-length");
        if (declared && /^\d+$/.test(declared) && Number(declared) > opts.maxBytes) {
          res.destroy();
          finish(
            new ResponseTooLargeError(
              `Response declares ${Number(declared).toLocaleString()} bytes; the limit is ` +
                `${opts.maxBytes.toLocaleString()} bytes.`,
            ),
          );
          return;
        }

        void readStreamLimited(res, opts.maxBytes)
          .then((body) =>
            finish(undefined, {
              url: url.toString(),
              status,
              statusText: res.statusMessage ?? "",
              headers: res.headers,
              body,
            }),
          )
          .catch((error) => {
            res.destroy();
            finish(error);
          });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${opts.timeoutMs} ms.`));
    }, opts.timeoutMs);
    timer.unref();
    req.once("error", (error) => finish(error));
    req.end();
  });
}

/**
 * Request a public URL with validated, connection-pinned DNS and per-hop redirect
 * checks. The timeout covers DNS, redirects, headers, and the response body.
 */
export async function secureRequest(
  raw: string | URL,
  options: SecureRequestOptions,
): Promise<SecureResponse> {
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer.");
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new Error("maxRedirects must be an integer between 0 and 20.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("timeoutMs must be an integer between 1 and 300000 milliseconds.");
  }
  const deadline = Date.now() + timeoutMs;
  const release = await acquireRequestSlot(options.maxBytes, timeoutMs);
  try {
    const policy = options.urlPolicy ?? (() => {});
    const resolver = options.resolver ?? systemResolver;
    const seen = new Set<string>();
    let current = parsePublicHttpUrl(raw);

    for (let hop = 0; ; hop++) {
      const canonical = current.toString();
      if (seen.has(canonical)) throw new NetworkSecurityError("Redirect loop detected.");
      seen.add(canonical);
      await policy(current);
      let remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Request timed out after ${timeoutMs} ms.`);
      const addresses = await withTimeout(
        resolvePublicAddresses(current, resolver),
        remaining,
        `DNS resolution timed out after ${timeoutMs} ms.`,
      );
      remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Request timed out after ${timeoutMs} ms.`);
      const response = await requestOnce(current, addresses, {
        method,
        maxBytes: options.maxBytes,
        timeoutMs: remaining,
        headers: options.headers ?? {},
      });

      if (!REDIRECT_STATUS.has(response.status)) return response;
      const location = firstHeader(response.headers, "location");
      if (!location) {
        throw new NetworkSecurityError(`Redirect response ${response.status} did not include Location.`);
      }
      if (hop >= maxRedirects) throw new NetworkSecurityError("Too many redirects.");
      current = resolveRedirectTarget(current, location);
    }
  } finally {
    release();
  }
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string {
  return firstHeader(headers, name.toLowerCase()) ?? "";
}
