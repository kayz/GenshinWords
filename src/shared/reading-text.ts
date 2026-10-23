import type { ReadingGloss } from './reading';

export interface AnnotatedReadingPart { text: string; note?: string }

/** Keep source text intact; explain each exact term only at its first occurrence. */
export function annotateReadingParagraphs(
  paragraphs: string[],
  glossary: ReadingGloss[],
): AnnotatedReadingPart[][] {
  const explanations = new Map<string, string>();
  for (const entry of glossary) {
    const term = entry.term.trim();
    if (term && entry.explanation.trim() && !explanations.has(term.toLowerCase())) {
      explanations.set(term.toLowerCase(), entry.explanation.trim());
    }
  }
  if (!explanations.size) return paragraphs.map((text) => [{ text }]);
  const terms = [...explanations.keys()].sort((a, b) => b.length - a.length);
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const boundary = "[\\p{L}\\p{N}\\p{M}_'’]";
  const pattern = new RegExp(
    '(?<!' + boundary + ')((?:' + escaped.join('|') + "))(?:['’]s|['’])?(?!" + boundary + ')',
    'giu',
  );
  const seen = new Set<string>();
  return paragraphs.map((text) => {
    pattern.lastIndex = 0;
    const parts: AnnotatedReadingPart[] = [];
    let offset = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const term = match[1].toLowerCase();
      if (seen.has(term)) continue;
      if (match.index > offset) parts.push({ text: text.slice(offset, match.index) });
      parts.push({ text: match[0], note: explanations.get(term) });
      seen.add(term);
      offset = match.index + match[0].length;
    }
    if (offset < text.length || !parts.length) parts.push({ text: text.slice(offset) });
    return parts;
  });
}
