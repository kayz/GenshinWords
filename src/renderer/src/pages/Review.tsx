import Primogem from '../components/Primogem';
import { normalizeStudyOrder, normalizeStudySize } from '../../../shared/study-settings';
import type { WordDetail, RatingKey, StudySize } from '../../../shared/models';
import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { COLLECTION_ID } from '../../../shared/collection';
import { highlightSurface, tokenizeClickable } from '../lib/text';
import ReviewPortrait from '../components/ReviewPortrait';
import { errorMessage, localDate } from '../lib/format';
import Pronunciation from '../components/Pronunciation';

const ratings: { key: RatingKey; label: string; hint: string }[] = [
  {
    key: 'again',
    label: '忘记了',
    hint: 'Again',
  },
  {
    key: 'hard',
    label: '有些困难',
    hint: 'Hard',
  },
  {
    key: 'good',
    label: '记得',
    hint: 'Good',
  },
  {
    key: 'easy',
    label: '很熟悉',
    hint: 'Easy',
  },
];

export default function Review() {
  const [params] = useSearchParams();
  const collectionMode = params.get('scope') === 'collection';
  const explicitBook = params.get('bookId') || '';
  return <ReviewSession key={collectionMode ? 'collection' : explicitBook || 'book'} collectionMode={collectionMode} explicitBook={explicitBook} />;
}

function ReviewSession({ collectionMode, explicitBook }: { collectionMode: boolean; explicitBook: string }) {
  const practicePath = collectionMode ? '/practice?scope=collection' : explicitBook ? '/practice?bookId=' + encodeURIComponent(explicitBook) : '/practice';
  const practiceWordPath = (id: number) => practicePath + (practicePath.includes('?') ? '&' : '?') + 'wordId=' + id;
  const [bookId, setBookId] = useState('');
  const [studySize, setStudySize] = useState<StudySize>('10');
  const [stopped, setStopped] = useState(false);
  const [refilling, setRefilling] = useState(false);
  const [marathonExhausted, setMarathonExhausted] = useState(false);
  const [dueOnly, setDueOnly] = useState(false);
  const [batchError, setBatchError] = useState<'initial' | 'refill' | null>(null);
  const [pendingRating, setPendingRating] = useState<RatingKey | null>(null);
  const seenWords = useRef(new Set<number>());
  const refillingLock = useRef(false);
  const [queue, setQueue] = useState<number[]>([]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [payload, setPayload] = useState<WordDetail | null>(null);
  const [exampleIndex, setExampleIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [wordLoading, setWordLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sessionRun, setSessionRun] = useState(0);
  const [wordRun, setWordRun] = useState(0);
  const [shortDue, setShortDue] = useState<Record<number, string>>({});
  const nextDue = Object.values(shortDue).sort()[0] ?? null;
  const [lastReviewedWordId, setLastReviewedWordId] = useState<number | null>(null);
  const locked = useRef(false);
  const cardToken = useRef('');
  const mounted = useRef(true);
  const activeWord = useRef<number | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const id = collectionMode ? COLLECTION_ID : explicitBook || await window.api.getSetting('currentBook');
        if (!active) return;
        setBookId(id);
        if (!id) return;
        const [order, savedSize] = await Promise.all([
          collectionMode ? Promise.resolve('default') : window.api.getSetting('studyOrder', 'default'),
          window.api.getSetting('studySize', '10'),
        ]);
        if (!active) return;
        const size = normalizeStudySize(savedSize);
        setStudySize(size); setStopped(false); setMarathonExhausted(false);
        seenWords.current = new Set(); refillingLock.current = false; setRefilling(false);
        const session = await window.api.nextStudyBatch(id, { limit: size === 'marathon' ? 20 : Number(size), order: normalizeStudyOrder(order), dueOnly, repeatDue: size === 'marathon' });

        if (active) {
          setQueue(session);
          setMarathonExhausted(session.length === 0);
          setWordLoading(session.length > 0);
          setShortDue({});
        }
      } catch (cause) {
        if (active) { setError(errorMessage(cause)); setBatchError('initial'); }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [sessionRun]);
  const needsMore = studySize === 'marathon' && !stopped && !marathonExhausted && !batchError && queue.length > 0 && index >= queue.length;
  useEffect(() => {
    if (!needsMore || saving || refillingLock.current) return;
    let active = true;
    refillingLock.current = true; setRefilling(true);
    void (async () => {
      const order = collectionMode ? 'default' : await window.api.getSetting('studyOrder', 'default');
      const next = await window.api.nextStudyBatch(bookId, { limit: 20, excludeNewIds: [...seenWords.current], repeatDue: true, dueOnly, order: normalizeStudyOrder(order) });
      if (!active) return;
      setRefilling(false); refillingLock.current = false;
      if (next.length) { setPayload(null); setWordLoading(true); setQueue(previous => [...previous, ...next]); }
      else setMarathonExhausted(true);
    })().catch(cause => { if (active) { refillingLock.current = false; setRefilling(false); setError(errorMessage(cause)); setBatchError('refill'); } })
      .finally(() => { if (active) { refillingLock.current = false; setRefilling(false); } });
    return () => { active = false; refillingLock.current = false; };
  }, [needsMore, saving, bookId, sessionRun]);
  const wordId = queue[index];
  useEffect(() => {
    let active = true;
    activeWord.current = null;
    locked.current = false;
    setPendingRating(null);
    cardToken.current = `${Date.now()}-${Math.random()}-${wordId ?? 'empty'}`;
    if (wordId == null) return;
    void window.api
      .getWord(wordId, bookId)
      .then(
        (data) => {
          if (active) {
            setPayload(data);
            activeWord.current = data?.word.id ?? null;
            if (!data) setError('这个单词未在本地内容包中找到。');
          }
        },
        (cause) => {
          if (active) setError(errorMessage(cause));
        },
      )
      .finally(() => {
        if (active) setWordLoading(false);
      });
    return () => {
      active = false;
    };
  }, [wordId, index, sessionRun, wordRun]);
  const example = payload?.examples[exampleIndex];
  async function rate(rating: RatingKey) {
    if (
      !mounted.current ||
      locked.current ||
      !flipped ||
      !payload ||
      !bookId ||
      payload.word.id !== wordId ||
      activeWord.current !== wordId ||
      pendingRating !== null && pendingRating !== rating
    )
      return;
    locked.current = true;
    setPendingRating(rating);
    setSaving(true);
    setError('');
    try {
      const result = await window.api.rateReview(wordId, bookId, rating, cardToken.current);
      if (!mounted.current) return;
      setShortDue(previous => {
        const next = {...previous};
        if (result.state === 1 || result.state === 3) next[wordId] = result.due;
        else delete next[wordId];
        return next;
      });
      if (result.earned.length)
        setNotice(
          `获得 ${result.earned.length} 原石：${result.earned.map((entry) => entry.lemma).join('、')}`,
        );
      seenWords.current.add(wordId);
      setLastReviewedWordId(wordId);
      setPayload(null);
      setFlipped(false);
      setExampleIndex(0);
      setSaving(false);
      setWordLoading(index + 1 < queue.length);
      setIndex((current) => current + 1);
    } catch (cause) {
      if (mounted.current) {
        setError(`评分还没确认好：${errorMessage(cause)}。请重试刚才的选择。`);
        setSaving(false);
        locked.current = false;
      }
    }
  }
  if (loading)
    return (
      <p className="gw-muted" role="status">
        正在准备今日卡片…
      </p>
    );
  if (batchError && !stopped) return <section className="gw-panel gw-study-error">
    <h1 className="gw-hero-title">派蒙还没翻好这一页。</h1>
    <p className="gw-error" role="alert">{error}</p>
    <div className="gw-actions"><button type="button" className="gw-btn" onClick={() => {
      const failed = batchError; setError(''); setBatchError(null);
      if (failed === 'initial') { setLoading(true); setSessionRun(value => value + 1); }
    }}>{batchError === 'initial' ? '重新准备词卡' : '继续翻页'}</button>
    {batchError === 'refill' ? <button type="button" className="gw-btn gw-btn-ghost" onClick={() => { setStopped(true); setError(''); setBatchError(null); }}>结束本次</button> : null}
    <Link to={collectionMode ? '/collection' : '/'} className="gw-btn gw-btn-ghost">返回{collectionMode ? '收藏词表' : '首页'}</Link></div>
  </section>;
  if (!bookId)
    return (
      <p>
        请先在 <Link to="/">首页</Link> 选择词书。
      </p>
    );
  if ((refilling || needsMore) && !stopped) return <section><p className="gw-muted" role="status">派蒙正在翻下一页词卡…</p><button type="button" className="gw-btn gw-btn-ghost" onClick={() => { setStopped(true); setRefilling(false); }}>结束本次</button></section>;
  if (stopped || queue.length === 0 || index >= queue.length)
    return (
      <section className="gw-session-end">
        <Primogem className="gw-gem" sparkle />
        <h1 className="gw-hero-title">{stopped ? '休息一下，再出发。' : '这一页，已记下。'}</h1>
        <p className="gw-hero-sub">
          {error || (stopped ? '派蒙替你记好了进度，随时都能继续旅行。' : '这一轮的词卡都看过啦，去单词自测检查一下吧。')}
        </p>
        <p className="gw-muted">已完成 {index} 次复习，遇见 {seenWords.current.size} 个单词。</p>
        {nextDue ? (
          <p className="gw-muted">{nextDue <= new Date().toISOString() ? '有短期词卡已经到期，可以继续检查啦。' : `短期复习将在 ${localDate(nextDue)} 到期；到时可检查下一轮。`}</p>
        ) : null}
        {notice ? (
          <p className="gw-reward-notice" role="status">
            <Primogem sparkle /> {notice}
          </p>
        ) : null}
        <div className="gw-actions">
          {lastReviewedWordId !== null ? <Link to={practiceWordPath(lastReviewedWordId)} className="gw-btn gw-btn-ghost">检查刚复习的词</Link> : null}
          <Link to={practicePath} className="gw-btn">
            进入单词自测
          </Link>
          <button
            type="button"
            className="gw-btn gw-btn-ghost"
            onClick={() => {
              setLoading(true);
              setStopped(false); setDueOnly(true); setBatchError(null);
              setPayload(null);
              setError('');
              setIndex(0);
              setQueue([]);
              setSessionRun((value) => value + 1);
            }}
          >
            检查到期卡
          </button>
          <Link to={collectionMode ? '/collection' : '/'} className="gw-btn gw-btn-ghost">
            {collectionMode ? '返回收藏词表' : '返回首页'}
          </Link>
        </div>
      </section>
    );
  if (wordLoading)
    return (
      <p className="gw-muted" role="status">
        正在打开下一张词卡…
      </p>
    );
  if (!payload)
    return (
      <div className="gw-panel">
        <p className="gw-error" role="alert">
          {error || '词卡未能载入。'}
        </p>
        <button
          type="button"
          className="gw-btn"
          onClick={() => {
            setWordLoading(true);
            setError('');
            setWordRun((value) => value + 1);
          }}
        >
          重新载入
        </button>
      </div>
    );
  return (
    <section>
      {lastReviewedWordId !== null ? <p><Link to={practiceWordPath(lastReviewedWordId)} className="gw-text-link">检查刚复习的词 →</Link></p> : null}
      <div className="gw-review-heading">
        <span className="gw-eyebrow">{collectionMode ? '收藏词复习' : '今日词卡'}</span>
        <span className="gw-muted">
          {studySize === 'marathon' ? '马拉松 · 第 ' + (index + 1) + ' 张' : (index + 1) + ' / ' + queue.length}
          {studySize === 'marathon' ? <button type="button" className="gw-btn gw-btn-ghost gw-stop-study" disabled={saving} onClick={() => setStopped(true)}>结束本次</button> : null}
        </span>
      </div>
      <div className="gw-panel gw-review-card gw-review-portrait">
        <ReviewPortrait portrait={example?.portrait ?? null} />
        <div className="gw-word-content">
          <h1 className="gw-word">{payload.word.lemma}</h1>
          <Pronunciation wordId={payload.word.id} />
          <button
            type="button"
            className={`gw-btn ${flipped ? 'gw-btn-ghost' : ''}`}
            aria-expanded={flipped}
            onClick={() => setFlipped((value) => !value)}
          >
            {flipped ? '隐藏释义与台词' : '显示释义与台词'}
          </button>
          {flipped ? (
            <div className="gw-word-answer">
              <div className="gw-answer-scroll" tabIndex={0} aria-label="释义与来源原句">
              <p className="gw-translation">
                {payload.word.pos && !payload.word.translation.trimStart().toLowerCase().startsWith(payload.word.pos.toLowerCase() + '.') ? <span className="gw-muted">{payload.word.pos}</span> : null}
                {payload.word.translation}
              </p>
          {payload.examples.length > 1 ? (
            <div className="gw-example-switch" aria-label="例句来源">
              {payload.examples.map((item, i) => (
                <button
                  key={item.line_id ?? i}
                  type="button"
                  className={i === exampleIndex ? 'active' : ''}
                  aria-pressed={i === exampleIndex}
                  onClick={() => {
                    if (i === exampleIndex) return;
                    setExampleIndex(i);
                  }}
                >
                  {i + 1} · {item.speaker || '故事'}
                </button>
              ))}
            </div>
          ) : null}
              {example ? (
                <blockquote className="gw-example">
                  <div className="gw-speaker">
                    {example.speaker || '旁白'}
                    {example.source_type === 'voice' || example.chapter_type === 'voice'
                      ? null
                      : ` · ${example.source_label || '任务文本'}`}
                    {example.version ? ` · v${example.version}` : ''}
                  </div>
                  <p>{highlightSurface(example.text_en, example.surface || payload.word.lemma)}</p>
                  <p className="gw-muted">{example.text_chs}</p>
                  <footer className="gw-muted">
                    {example.chapter_title_chs || example.chapter_title_en}
                    {example.chapter_variant_label ? ' · ' + example.chapter_variant_label : ''}
                    {example.source_type === 'voice' || example.chapter_type === 'voice'
                      ? example.quest_title_chs
                        ? ` · ${example.quest_title_chs}`
                        : ''
                      : example.quest_title_en
                        ? ` · ${example.quest_title_en}`
                        : ''}
                  </footer>
                </blockquote>
              ) : (
                <p className="gw-muted">{collectionMode ? '此旧收藏尚未记录来源句，可继续复习释义；在本地剧情中重新点选该词即可补齐来源并测试。' : '暂无匹配到的原神例句。'}</p>
              )}
              </div>
              <div className="gw-rate">
                {ratings.map((rating) => (
                  <button
                    type="button"
                    key={rating.key}
                    className={rating.key}
                    disabled={saving || pendingRating !== null && pendingRating !== rating.key}
                    aria-label={pendingRating === rating.key && error ? '重试上次评分：' + rating.label : undefined}
                    onClick={() => void rate(rating.key)}
                  >
                    {rating.label}
                    <small>{rating.hint}</small>
                  </button>
                ))}
              </div>
              {saving ? (
                <p className="gw-muted" role="status">
                  正在保存记忆进度…
                </p>
              ) : null}
            </div>
          ) : (
            <p className="gw-muted gw-flip-hint">先在心里回忆释义，再查看答案。</p>
          )}
          {error ? (
            <p className="gw-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      {notice ? (
        <p className="gw-reward-notice" role="status">
          <Primogem sparkle /> {notice}
        </p>
      ) : null}
    </section>
  );
}
