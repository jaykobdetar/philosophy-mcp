import { Worker } from "node:worker_threads";
const DEFAULT_INPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ACTIVE_METADATA_WORKERS = 1;
const MAX_QUEUED_METADATA_JOBS = 4;
let activeMetadataWorkers = 0;
const metadataWaiters = [];
async function acquireXmlSlot(timeoutMs) {
    if (activeMetadataWorkers < MAX_ACTIVE_METADATA_WORKERS) {
        activeMetadataWorkers++;
    }
    else {
        if (metadataWaiters.length >= MAX_QUEUED_METADATA_JOBS) {
            throw new Error("Metadata parser queue is full; try again later.");
        }
        await new Promise((resolve, reject) => {
            let timer;
            const waiter = () => {
                clearTimeout(timer);
                resolve();
            };
            metadataWaiters.push(waiter);
            timer = setTimeout(() => {
                const index = metadataWaiters.indexOf(waiter);
                if (index === -1)
                    return;
                metadataWaiters.splice(index, 1);
                reject(new Error(`Metadata parsing timed out after ${timeoutMs} ms while queued.`));
            }, timeoutMs);
            timer.unref();
        });
    }
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        const next = metadataWaiters.shift();
        if (next)
            next();
        else
            activeMetadataWorkers--;
    };
}
/** Parse untrusted structured metadata outside the main event loop with strict bounds. */
async function parseStructuredSafely(source, format, options = {}) {
    const sourceBytes = Buffer.byteLength(source);
    const maxInputBytes = options.maxInputBytes ?? DEFAULT_INPUT_BYTES;
    if (!Number.isSafeInteger(maxInputBytes) ||
        maxInputBytes < 1024 ||
        maxInputBytes > 16 * 1024 * 1024) {
        throw new Error("Metadata maxInputBytes must be between 1024 and 16777216 bytes.");
    }
    if (sourceBytes > maxInputBytes) {
        throw new Error(`${format.toUpperCase()} input is ${sourceBytes.toLocaleString()} bytes; the limit is ` +
            `${maxInputBytes.toLocaleString()} bytes.`);
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        throw new Error("Metadata timeoutMs must be an integer between 1 and 60000 milliseconds.");
    }
    if (!Number.isSafeInteger(maxOutputBytes) ||
        maxOutputBytes < 1024 ||
        maxOutputBytes > 16 * 1024 * 1024) {
        throw new Error("Metadata maxOutputBytes must be between 1024 and 16777216 bytes.");
    }
    const deadline = Date.now() + timeoutMs;
    const release = await acquireXmlSlot(timeoutMs);
    try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            throw new Error(`Metadata parsing timed out after ${timeoutMs} ms while queued.`);
        }
        const bytes = Uint8Array.from(Buffer.from(source)).buffer;
        return await new Promise((resolve, reject) => {
            const worker = new Worker(new URL("./xml-worker.js", import.meta.url), {
                execArgv: [],
                workerData: { bytes, format, maxOutputBytes },
                transferList: [bytes],
                resourceLimits: {
                    maxOldGenerationSizeMb: 128,
                    maxYoungGenerationSizeMb: 32,
                    stackSizeMb: 4,
                },
            });
            let settled = false;
            let timer;
            const finish = (error, value) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                void worker.terminate().then(() => (error ? reject(error) : resolve(value)), (terminationError) => reject(error ?? terminationError));
            };
            timer = setTimeout(() => finish(new Error(`Metadata parsing timed out after ${timeoutMs} ms.`)), remainingMs);
            timer.unref();
            worker.once("message", (message) => {
                if (!message?.ok) {
                    finish(new Error(message?.error ?? "Metadata parsing failed."));
                    return;
                }
                try {
                    finish(undefined, JSON.parse(String(message.json)));
                }
                catch (error) {
                    finish(error);
                }
            });
            worker.once("error", (error) => finish(error));
            worker.once("exit", (code) => {
                if (!settled)
                    finish(new Error(`Metadata parser worker exited unexpectedly (code ${code}).`));
            });
        });
    }
    finally {
        release();
    }
}
/** Parse untrusted XML metadata outside the main event loop with strict bounds. */
export async function parseXmlSafely(source, options = {}) {
    return await parseStructuredSafely(source, "xml", options);
}
/** Parse untrusted JSON metadata outside the main event loop with strict bounds. */
export async function parseJsonSafely(source, options = {}) {
    return await parseStructuredSafely(source, "json", options);
}
