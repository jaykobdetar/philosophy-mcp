import { parentPort, workerData } from "node:worker_threads";
import { XMLParser } from "fast-xml-parser";
function assertBoundedShape(root) {
    const stack = [{ value: root, depth: 0 }];
    let nodes = 0;
    let scheduled = 1;
    while (stack.length > 0) {
        const { value, depth } = stack.pop();
        if (++nodes > 50_000)
            throw new Error("Parsed metadata contains too many values.");
        if (depth > 100)
            throw new Error("Parsed metadata is nested too deeply.");
        if (!value || typeof value !== "object")
            continue;
        if (Array.isArray(value)) {
            for (const child of value) {
                if (++scheduled > 50_000)
                    throw new Error("Parsed metadata contains too many values.");
                stack.push({ value: child, depth: depth + 1 });
            }
        }
        else {
            for (const key in value) {
                if (++scheduled > 50_000)
                    throw new Error("Parsed metadata contains too many values.");
                stack.push({ value: value[key], depth: depth + 1 });
            }
        }
    }
}
async function main() {
    if (!parentPort)
        throw new Error("XML worker requires a parent port.");
    const input = workerData;
    const source = Buffer.from(input.bytes).toString("utf8");
    const parsed = input.format === "json"
        ? JSON.parse(source)
        : new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "@_",
            removeNSPrefix: true,
            trimValues: true,
        }).parse(source);
    assertBoundedShape(parsed);
    const json = JSON.stringify(parsed);
    if (Buffer.byteLength(json) > input.maxOutputBytes) {
        throw new Error(`Parsed XML exceeds the ${input.maxOutputBytes.toLocaleString()}-byte output limit.`);
    }
    parentPort.postMessage({ ok: true, json });
}
main().catch((error) => {
    parentPort?.postMessage({ ok: false, error: error?.message ?? String(error) });
});
