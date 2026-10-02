import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
function envInteger(name, fallback, minimum, maximum) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
    return parsed;
}
const MAX_ACTIVE_WORKERS = envInteger("PHILOSOPHY_MAX_PDF_WORKERS", 1, 1, 4);
const MAX_QUEUED_JOBS = envInteger("PHILOSOPHY_MAX_PDF_QUEUE", 4, 0, 32);
const DEFAULT_MAX_PAGES = envInteger("PHILOSOPHY_MAX_PDF_PAGES", 10_000, 1, 100_000);
const workerQueue = [];
let activeWorkers = 0;
const liveParserProcesses = new Set();
let parserShutdownStarted = false;
function killParser(child) {
    if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
    }
}
// Emergency cleanup for explicit process.exit(). The normal shutdown path
// below also waits for exits so parser children cannot be orphaned at PPid 1.
process.once("exit", () => {
    for (const child of liveParserProcesses)
        killParser(child);
});
export async function shutdownPdfParsers() {
    parserShutdownStarted = true;
    const children = [...liveParserProcesses];
    if (children.length === 0)
        return;
    const exits = children.map((child) => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        child.once("close", () => resolve());
        killParser(child);
    }));
    let timer;
    try {
        await Promise.race([
            Promise.all(exits),
            new Promise((resolve) => {
                timer = setTimeout(resolve, 2_000);
                timer.unref();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function makeRelease() {
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        const next = workerQueue.shift();
        if (next) {
            // Transfer this slot directly to the oldest queued job. activeWorkers does
            // not change, so the configured limit is never exceeded between jobs.
            next(makeRelease());
        }
        else {
            activeWorkers--;
        }
    };
}
function acquireWorkerSlot(timeoutMs) {
    if (activeWorkers < MAX_ACTIVE_WORKERS) {
        activeWorkers++;
        return Promise.resolve(makeRelease());
    }
    if (workerQueue.length >= MAX_QUEUED_JOBS) {
        return Promise.reject(new Error(`PDF extraction queue is full (${MAX_ACTIVE_WORKERS} active, ` +
            `${MAX_QUEUED_JOBS} queued). Retry after an existing extraction finishes.`));
    }
    return new Promise((resolve, reject) => {
        let timer;
        const waiter = (release) => {
            clearTimeout(timer);
            resolve(release);
        };
        workerQueue.push(waiter);
        timer = setTimeout(() => {
            const index = workerQueue.indexOf(waiter);
            if (index === -1)
                return;
            workerQueue.splice(index, 1);
            reject(new Error(`PDF extraction timed out after ${timeoutMs} ms while queued.`));
        }, timeoutMs);
        timer.unref();
    });
}
async function runPdfWorker(source, options) {
    if (parserShutdownStarted) {
        throw new Error("PDF parsing is unavailable because the server is shutting down.");
    }
    return await new Promise((resolve, reject) => {
        let timer;
        const child = fork(fileURLToPath(new URL("./pdf-child.js", import.meta.url)), [], {
            execArgv: [
                "--max-old-space-size=192",
                "--max-semi-space-size=32",
                "--stack-size=8192",
            ],
            serialization: "advanced",
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        liveParserProcesses.add(child);
        child.once("close", () => liveParserProcesses.delete(child));
        let outcome;
        let completed = false;
        const requestStop = (error, result) => {
            if (outcome)
                return;
            outcome = { error, result };
            if (timer)
                clearTimeout(timer);
            if (child.exitCode === null && !child.killed)
                child.kill("SIGKILL");
        };
        const settleAfterExit = (fallback) => {
            if (completed)
                return;
            completed = true;
            if (timer)
                clearTimeout(timer);
            const error = outcome?.error ?? fallback;
            if (error)
                reject(error);
            else if (outcome?.result)
                resolve(outcome.result);
            else
                reject(new Error("PDF parser process exited before returning a result."));
        };
        timer = setTimeout(() => {
            requestStop(new Error(`PDF extraction timed out after ${options.timeoutMs} ms.`));
        }, options.timeoutMs);
        timer.unref();
        child.once("message", (message) => {
            if (!message?.ok) {
                requestStop(new Error(message?.error ?? "PDF extraction failed."));
                return;
            }
            requestStop(undefined, {
                text: typeof message.text === "string" ? message.text : undefined,
                pages: Array.isArray(message.pages) ? message.pages.map(String) : undefined,
                totalPages: Number(message.totalPages ?? 0),
            });
        });
        // `close` is delivered after either a normal exit or a spawn error and is
        // the one lifecycle event Node guarantees once stdio/IPC handles close.
        child.once("error", (error) => requestStop(error));
        child.once("close", (code, signal) => {
            settleAfterExit(outcome
                ? undefined
                : new Error(`PDF parser process exited unexpectedly (code ${code}, signal ${signal ?? "none"}).`));
        });
        child.send({
            bytes: source,
            mergePages: options.mergePages,
            maxChars: options.maxChars,
            maxPages: options.maxPages,
        }, (error) => {
            if (error)
                requestStop(error);
        });
    });
}
/** Parse an untrusted PDF in a separate, heap-limited process with a hard wall timeout. */
export async function extractPdfSafely(source, options) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 0) {
        throw new Error("PDF maxChars must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100_000) {
        throw new Error("PDF maxPages must be an integer between 1 and 100000.");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
        throw new Error("PDF timeoutMs must be an integer between 1 and 300000 milliseconds.");
    }
    const deadline = Date.now() + timeoutMs;
    const release = await acquireWorkerSlot(timeoutMs);
    try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            throw new Error(`PDF extraction timed out after ${timeoutMs} ms while queued.`);
        }
        return await runPdfWorker(source, {
            mergePages: options.mergePages,
            maxChars: options.maxChars,
            maxPages,
            timeoutMs: remainingMs,
        });
    }
    finally {
        release();
    }
}
