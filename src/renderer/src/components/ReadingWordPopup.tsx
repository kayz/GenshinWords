import { useEffect, useRef, useState } from 'react';
import type { WordSummary } from '../../../shared/models';
import Pronunciation from './Pronunciation';

export interface ReadingWordSelection { surface: string; paragraph: number; start: number; end: number }
interface Props { selection: ReadingWordSelection; attemptId: string; onClose: () => void }

export default function ReadingWordPopup({ selection, attemptId, onClose }: Props) {
  const [word, setWord] = useState<WordSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const closing = useRef(onClose);
  const saveLock = useRef(false);
  closing.current = onClose;
  useEffect(() => {
    let active = true;
    setLoading(true);
    void window.api.lookupWord(selection.surface).then((next) => {
      if (active) setWord(next);
    }).catch(() => {
      if (active) setError('唔，这一页词典还没翻开，再试一次吧。');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selection.surface]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = requestAnimationFrame(() => {
      if (!dialog.current?.closest('[inert]')) dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    });
    function keyboard(event: KeyboardEvent) {
      if (event.defaultPrevented || !dialog.current || dialog.current.closest('[inert], [aria-hidden="true"]')) return;
      if (event.key === 'Escape') { event.preventDefault(); closing.current(); return; }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]') || []);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); dialog.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keyboard);
    return () => { cancelAnimationFrame(focusFrame); document.removeEventListener('keydown', keyboard); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  async function collect() {
    if (!word || saveLock.current || saved) return;
    saveLock.current = true;
    setSaving(true); setError('');
    try {
      const result = await window.api.collectReadingWord({ attemptId, paragraph: selection.paragraph, start: selection.start, end: selection.end });
      const messages = {
        added: '记好啦！这个词和故事里的句子一起放进收藏词表了。',
        existing: '已经在收藏里啦，派蒙替你留着原来那句话。',
        restored: '欢迎回来！这个词又回到收藏词表啦。',
        'source-added': '这回连故事里的句子也一起记好了！',
      };
      setMessage(messages[result.status]); setSaved(true);
    } catch {
      setError('派蒙还没记好这个词，再点一次试试吧。');
      saveLock.current = false;
    } finally { setSaving(false); }
  }
  return <div className="rd-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="reading-word-title" tabIndex={-1} className="rd-word-popup">
      <button type="button" className="rd-modal-close" aria-label="关闭单词释义" onClick={onClose}>×</button>
      <p className="gw-eyebrow">派蒙的小词典</p>
      <h2 id="reading-word-title" lang="en">{word?.lemma || selection.surface}</h2>
      {loading ? <p role="status">派蒙翻翻词典…</p> : word ? <>
        {word.lemma.toLowerCase() !== selection.surface.toLowerCase() ? <p className="gw-muted">故事里写的是 <span lang="en">{selection.surface}</span></p> : null}
        <p className="rd-popup-translation">{word.translation}</p>
        <Pronunciation wordId={word.id} />
        <button type="button" className="gw-btn" disabled={saving || saved} onClick={() => void collect()}>{saving ? '正在记下来…' : saved ? '已放进收藏词表' : '加入收藏词表'}</button>
      </> : !error ? <p>唔，派蒙还没在词典里找到「<span lang="en">{selection.surface}</span>」。换个词看看吧。</p> : null}
      {message ? <p className="rd-popup-message" role="status">{message}</p> : null}
      {error ? <p className="gw-error" role="alert">{error}</p> : null}
    </div>
  </div>;
}
