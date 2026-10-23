/** A displayed name, not its raw source ID. Iterate Unicode code points, never split a Han character. */
export function speakerInitial(name: string | null | undefined): string {
  const value = (name || '').normalize('NFKC').trim();
  if (!value) return '旁';
  const first = Array.from(value).find(character => /[\p{L}\p{N}]/u.test(character));
  return first ? first.toLocaleUpperCase('en-US') : '？';
}
