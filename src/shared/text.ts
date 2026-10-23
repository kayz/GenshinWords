// 浏览点词和主进程校验共用字符范围与 UTF-16 偏移。
export function wordTokens(text: string) {
  return Array.from(text.matchAll(/[\p{L}\p{M}]+(?:['’‘\-‐‑–][\p{L}\p{M}]+)*/gu),
    match => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}
