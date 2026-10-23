import { wordTokens } from '../../../shared/text';

export function highlightSurface(text: string, surface?: string | null) {
  if (!surface) return text;
  const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'i').exec(text);
  if (!match) return text;
  const idx = match.index;
  return (
    <>
      {text.slice(0, idx)}
      <span className="gw-highlight">{text.slice(idx, idx + surface.length)}</span>
      {text.slice(idx + surface.length)}
    </>
  );
}

export function tokenizeClickable(text: string, onWord: (word: string, start: number, end: number) => void) {
  const parts = [];
  let cursor = 0;
  for (const token of wordTokens(text)) {
    if (token.start > cursor) parts.push(<span key={'text-' + cursor}>{text.slice(cursor, token.start)}</span>);
    parts.push(
      <span key={'word-' + token.start} className="gw-token" role="button" tabIndex={0}
        onClick={() => onWord(token.text, token.start, token.end)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault(); onWord(token.text, token.start, token.end);
          }
        }}>{token.text}</span>,
    );
    cursor = token.end;
  }
  if (cursor < text.length) parts.push(<span key={'text-' + cursor}>{text.slice(cursor)}</span>);
  return parts;
}
