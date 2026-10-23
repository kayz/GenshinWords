import { useEffect, useRef, useState } from 'react';
import paimon from '../assets/logo.png';
import Primogem from './Primogem';

export default function ReadingRewardAnimation({ count, onFinish }: { count: number; onFinish: () => Promise<void> }) {
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const action = useRef(onFinish);
  const finishing = useRef(false);
  action.current = onFinish;
  async function finish() {
    if (finishing.current) return;
    finishing.current = true; setSaving(true); setError('');
    try { await action.current(); }
    catch { setError('派蒙还没记下这次庆祝，再点一下收好吧。'); finishing.current = false; setSaving(false); }
  }
  const finishAction = useRef(finish);
  finishAction.current = finish;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = requestAnimationFrame(() => {
      if (!dialog.current?.closest('[inert]')) dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    });
    function keyboard(event: KeyboardEvent) {
      if (event.defaultPrevented || !dialog.current || dialog.current.closest('[inert], [aria-hidden="true"]')) return;
      if (event.key === 'Escape') { event.preventDefault(); void finishAction.current(); }
      if (event.key === 'Tab') { event.preventDefault(); dialog.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
    }
    document.addEventListener('keydown', keyboard);
    const timer = reduced ? null : window.setTimeout(() => void finishAction.current(), 3800);
    return () => {
      cancelAnimationFrame(focusFrame);
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('keydown', keyboard); document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [reduced]);
  return <div className={'rd-modal-backdrop rd-celebration-backdrop' + (reduced ? ' rd-reduced-celebration' : '')}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="reading-reward-title" className="rd-celebration">
      <div className="rd-reward-stars" aria-hidden="true"><span>✦</span><span>✧</span><span>✦</span><span>✧</span></div>
      <img src={paimon} alt="" className="rd-reward-paimon" />
      <h2 id="reading-reward-title">嘿嘿，读故事也有收获！</h2>
      <div className="rd-reward-gems" aria-label={'获得 ' + count + ' 颗原石'}><Primogem sparkle className="rd-reward-primogem"/> +{count}</div>
      <p>这些原石是你的啦，快收好吧！</p>
      <button type="button" className="gw-btn" disabled={saving} onClick={() => void finish()}>{saving ? '正在收好…' : '收好啦！'}</button>
      {error ? <p className="gw-error" role="alert">{error}</p> : null}
    </div>
  </div>;
}
