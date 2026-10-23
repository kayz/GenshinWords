import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { TRAVELERS, normalizeTraveler, type TravelerChoice } from '../../../shared/traveler';
import aetherPortrait from '../assets/aether-companion.webp';
import luminePortrait from '../assets/lumine-companion.webp';
import aetherAvatar from '../assets/aether-avatar.webp';
import lumineAvatar from '../assets/lumine-avatar.webp';
import './traveler.css';

const ART = {
  aether: { portrait: aetherPortrait, avatar: aetherAvatar },
  lumine: { portrait: luminePortrait, avatar: lumineAvatar },
};
interface TravelerContextValue {
  choice: TravelerChoice; name: string; portrait: string; avatar: string; pickerOpen: boolean; openPicker: () => void;
}
const TravelerContext = createContext<TravelerContextValue | null>(null);
export function useTraveler(): TravelerContextValue {
  const value = useContext(TravelerContext);
  if (!value) throw new Error('TravelerProvider is missing');
  return value;
}
export default function TravelerProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<TravelerChoice | null>(null);
  const [ready, setReady] = useState(false);
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const lock = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let active = true;
    setReady(false); setError('');
    void window.api.getSetting('traveler').then(value => {
      if (!active) return;
      const next = normalizeTraveler(value);
      setChoice(next); setPicker(!next); setReady(true);
    }).catch(() => { if (active) setError('派蒙没能翻开旅行手册，再试一次吧。'); });
    return () => { active = false; };
  }, [retry]);
  const isOpen = ready && (!choice || picker);
  useEffect(() => {
    if (!isOpen) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus());
    return () => {
      cancelAnimationFrame(frame);
      requestAnimationFrame(() => {
        if (document.activeElement instanceof HTMLElement && document.activeElement.closest('[role="dialog"][aria-modal="true"]')) return;
        const previous = previousFocus.current;
        if (previous?.isConnected) previous.focus();
        else document.querySelector<HTMLElement>('.gw-brand')?.focus();
      });
    };
  }, [isOpen]);
  async function choose(next: TravelerChoice) {
    if (lock.current) return;
    lock.current = true; setSaving(true); setError('');
    try {
      await window.api.setSetting('traveler', next);
      setChoice(next); setPicker(false);
    } catch { setError('还没记下来呢，和派蒙再试一次吧。'); }
    finally { lock.current = false; setSaving(false); }
  }
  function close() { if (choice && !saving) { setPicker(false); setError(''); } }
  const selected = choice || 'lumine';
  return <TravelerContext.Provider value={{ choice: selected, name: TRAVELERS[selected].name, ...ART[selected], pickerOpen: isOpen, openPicker: () => { setError(''); setPicker(true); } }}>
    <div inert={isOpen ? true : undefined}>
      {ready && choice ? children : <main className="gw-traveler-welcome">
        <div className="gw-eyebrow">提瓦特 · 旅途的起点</div>
        <h1 className="gw-hero-title">嘿，旅行者！</h1>
        {!ready && !error ? <p role="status">派蒙正在准备旅行手册…</p> : null}
        {!ready && error ? <><p className="gw-error" role="alert">{error}</p><button className="gw-btn" type="button" onClick={() => setRetry(value => value + 1)}>再试一次</button></> : null}
      </main>}
    </div>
    {isOpen ? <div className="gw-traveler-backdrop">
      <div ref={panel} className="gw-traveler-picker" role="dialog" aria-modal="true" aria-labelledby="traveler-picker-title"
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          if (event.key === 'Tab') {
            const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || [])];
            const first = buttons[0], last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <div className="gw-eyebrow">派蒙的旅行手册</div>
        <h1 id="traveler-picker-title">{choice ? '想换个模样，继续出发吗？' : '这次，和谁一起踏上旅途？'}</h1>
        <p>选好空或荧，派蒙就记住啦！以后点右上角的旅行者头像，随时都能换。</p>
        <div className="gw-traveler-choices">
          {(['aether', 'lumine'] as const).map(value => <button type="button" className="gw-traveler-choice" data-traveler-choice={value} key={value}
            aria-pressed={choice === value} disabled={saving} onClick={() => void choose(value)}>
            <img src={ART[value].portrait} alt={TRAVELERS[value].name + '的官方立绘'} />
            <strong>{TRAVELERS[value].name}</strong><span>和{TRAVELERS[value].name}一起出发</span>
          </button>)}
        </div>
        {error ? <p className="gw-error" role="alert">{error}</p> : null}
        {saving ? <p role="status">好嘞，派蒙记下来啦…</p> : null}
        {choice ? <button type="button" className="gw-btn gw-btn-ghost" disabled={saving} onClick={close}>这次先不换啦</button> : null}
      </div>
    </div> : null}
  </TravelerContext.Provider>;
}
