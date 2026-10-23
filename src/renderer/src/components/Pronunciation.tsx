import type { Pronunciation as PronunciationData } from '../../../shared/models';
import { useState, useEffect, useRef } from 'react';

export default function Pronunciation({ wordId }: { wordId: number }) {
  const [record, setRecord] = useState<{ wordId: number; data: PronunciationData } | null>(null);
  const data = record?.wordId === wordId ? record.data : null;
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState<'uk' | 'us' | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const run = useRef(0);
  useEffect(() => {
    let active = true;
    run.current += 1;
    void window.api.getPronunciation(wordId).then(
      (value) => {
        if (active) {
          setRecord({
            wordId,
            data: value,
          });
          setError('');
          setPlaying(null);
        }
      },
      () => {
        if (active) setError('音标暂不可用');
      },
    );
    return () => {
      active = false;
      run.current += 1;
      audio.current?.pause();
      audio.current = null;
    };
  }, [wordId]);
  async function play(accent: 'uk' | 'us') {
    const path = accent === 'uk' ? data?.audio_uk : data?.audio_us;
    if (!path) return;
    const request = ++run.current;
    audio.current?.pause();
    setError('');
    setPlaying(accent);
    try {
      const url = await window.api.audioDataUrl(path);
      if (request !== run.current) return;
      if (!url) throw new Error('本地音频缺失');
      const player = new Audio(url);
      audio.current = player;
      player.onended = () => {
        if (request === run.current) setPlaying(null);
      };
      player.onerror = () => {
        if (request === run.current) {
          setPlaying(null);
          setError('音频播放失败，请重试');
        }
      };
      await player.play();
    } catch {
      if (request === run.current) {
        setPlaying(null);
        setError('音频播放失败，请重试');
      }
    }
  }
  return (
    <div className="gw-pronunciations">
      {(['uk', 'us'] as const).map((accent) => {
        const phonetic = accent === 'uk' ? data?.phonetic_uk : data?.phonetic_us;
        const path = accent === 'uk' ? data?.audio_uk : data?.audio_us;
        return (
          <button
            key={accent}
            type="button"
            className="gw-pronunciation"
            disabled={!path}
            onClick={() => void play(accent)}
            aria-label={`播放${accent === 'uk' ? '英式' : '美式'}发音`}
            title={path ? '播放本地发音' : '未收录本地音频'}
          >
            <span>{accent === 'uk' ? '英' : '美'}</span>
            <span className="gw-phonetic">
              {phonetic ? `/${phonetic.replace(/^\/+|\/+$/g, '')}/` : '音标未收录'}
            </span>
            <span aria-hidden="true">{playing === accent ? '◼' : '▶'}</span>
          </button>
        );
      })}
      {error ? (
        <span className="gw-muted" role="status">
          {error}
        </span>
      ) : null}
    </div>
  );
}
