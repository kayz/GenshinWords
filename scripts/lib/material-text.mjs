export function plainText(value) {
    return String(value ?? '').replace(/\\r\\n|\\n/g, '\n').replace(/\r\n?/g, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div)>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '').replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16))).replace(/&#(\d+);/g, (_, x) => String.fromCodePoint(Number(x))).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n]);
}
export function splitParagraphs(text) { let empty = 0; const result = []; for (const line of text.split('\n')) {
    if (!line.trim()) {
        empty++;
        continue;
    }
    result.push({ order: result.length, blank_lines_before: empty, text: line });
    empty = 0;
} return result; }
