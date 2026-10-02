import { extractText, getDocumentProxy } from "unpdf";
function cleanText(value) {
    return String(value ?? "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
async function parse(input) {
    const pdf = await getDocumentProxy(new Uint8Array(input.bytes));
    const declaredPages = Number(pdf.numPages ?? 0);
    if (!Number.isSafeInteger(declaredPages) || declaredPages < 0) {
        throw new Error("PDF parser returned an invalid page count.");
    }
    if (declaredPages > input.maxPages) {
        throw new Error(`PDF has ${declaredPages.toLocaleString()} pages; the configured limit is ` +
            `${input.maxPages.toLocaleString()} page(s).`);
    }
    const extracted = input.mergePages
        ? await extractText(pdf, { mergePages: true })
        : await extractText(pdf, { mergePages: false });
    const totalPages = Number(extracted?.totalPages ?? 0);
    const raw = extracted?.text;
    if (!Number.isSafeInteger(totalPages) ||
        totalPages < 0 ||
        totalPages > input.maxPages ||
        (Array.isArray(raw) && raw.length > input.maxPages)) {
        throw new Error(`Extracted PDF page count exceeds the ${input.maxPages.toLocaleString()}-page limit.`);
    }
    const pages = (Array.isArray(raw) ? raw : [raw]).map(cleanText);
    const totalChars = pages.reduce((total, page) => total + page.length, 0);
    if (totalChars > input.maxChars) {
        throw new Error(`Extracted PDF text exceeds the ${input.maxChars.toLocaleString()}-character limit.`);
    }
    return input.mergePages
        ? { ok: true, text: pages.join("\n\n"), totalPages }
        : { ok: true, pages, totalPages };
}
process.once("message", (message) => {
    void parse(message)
        .then((result) => process.send?.(result, () => process.disconnect()))
        .catch((error) => process.send?.({ ok: false, error: error?.message ?? String(error) }, () => process.disconnect()));
});
