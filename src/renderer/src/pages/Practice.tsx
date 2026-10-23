import Primogem from '../components/Primogem';
import type { FormEvent } from 'react';
import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ExerciseResult, StudyExercise, SelfTestMode } from '../../../shared/practice';
import Pronunciation from '../components/Pronunciation';
import { localImage } from '../lib/assets';
import { errorMessage } from '../lib/format';
import { COLLECTION_ID } from '../../../shared/collection';

export default function Practice() {
  const [searchParams, setSearchParams] = useSearchParams();
  const explicitBook = searchParams.get('bookId') || '';
  const collectionMode = searchParams.get('scope') === 'collection' || explicitBook === COLLECTION_ID;
  const mode: SelfTestMode = searchParams.get('mode') === 'spelling' ? 'spelling' : 'meaning';
  const requested = searchParams.get('wordId');
  const targetWordId = requested === null ? undefined : Number(requested);
  const reviewPath = collectionMode ? '/review?scope=collection' : explicitBook ? '/review?bookId=' + encodeURIComponent(explicitBook) : '/review';
  const [bookId, setBookId] = useState('');
  const [bookName, setBookName] = useState('');
  const [exercise, setExercise] = useState<StudyExercise | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ExerciseResult | null>(null);
  const [cover, setCover] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  const [pendingSource, setPendingSource] = useState(0);
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    let active = true;
    lock.current = false;
    setLoading(true); setExercise(null); setAnswers({}); setResult(null); setCover(null); setError(''); setSubmitting(false);
    void (async () => {
      try {
        const id = collectionMode ? COLLECTION_ID : explicitBook || await window.api.getSetting('currentBook');
        if (!active) return;
        setBookId(id);
        if (!id) return;
        const [books, next, stats] = await Promise.all([
          window.api.listBooks(), window.api.buildExercise(id, targetWordId, mode),
          collectionMode ? window.api.getStats(id) : Promise.resolve(null),
        ]);
        if (!active) return;
        setBookName(collectionMode ? '收藏词表' : books.find(book => book.id === id)?.name_zh || id);
        setPendingSource(stats?.pendingSource || 0);
        setExercise(next);
        if (next?.coverPath) {
          const image = await localImage(next.coverPath);
          if (active) setCover(image);
        }
      } catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { if (active && request === generation.current) setLoading(false); }
    })();
    return () => { active = false; generation.current += 1; };
  }, [round, targetWordId, collectionMode, explicitBook, mode]);
  function nextRound(wordId?: number, nextMode = mode) {
    const params: Record<string, string> = {};
    if (collectionMode) params.scope = 'collection';
    if (explicitBook) params.bookId = explicitBook;
    if (!collectionMode) params.mode = nextMode;
    if (wordId !== undefined) params.wordId = String(wordId);
    setSearchParams(params, { replace: true });
    setRound(value => value + 1);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!exercise || result || lock.current) return;
    if (exercise.blanks.some(blank => !answers[blank.id]?.trim())) { setError('请先完成本题，再检查答案。'); return; }
    const request = generation.current;
    lock.current = true; setSubmitting(true); setError('');
    try {
      const next = await window.api.submitExercise(exercise.id, answers);
      if (request === generation.current) setResult(next);
    } catch (cause) {
      if (request === generation.current) { setError('答案未能保存：' + errorMessage(cause)); lock.current = false; }
    } finally { if (request === generation.current) setSubmitting(false); }
  }
  return <section>
    <div className="gw-eyebrow">提瓦特 · 单词自测</div>
    <h1 className="gw-hero-title">让记忆，经得起回望。</h1>
    <p className="gw-hero-sub">{collectionMode ? '仅使用收录时的原句检查收藏词，答对后领取这个词的一颗原石。' : '先学习词卡，再收起答案自测。每词首次通过获得一颗原石；篇章阅读另外计分。'}</p>
    <p className="gw-muted">建议每学 5–8 个词回测一组。本轮通过后，仍按记忆曲线继续复习。</p>
    {bookName ? <p className="gw-muted">{bookName} · <Link to={collectionMode ? '/collection' : '/'}>{collectionMode ? '返回收藏词表' : '选择词书'}</Link></p> : null}
    {!collectionMode ? <div className="gw-actions" aria-label="自测方式">
      <button className={'gw-btn ' + (mode === 'meaning' ? '' : 'gw-btn-ghost')} type="button" aria-pressed={mode === 'meaning'} disabled={submitting} onClick={() => nextRound(targetWordId, 'meaning')}>英文认义</button>
      <button className={'gw-btn ' + (mode === 'spelling' ? '' : 'gw-btn-ghost')} type="button" aria-pressed={mode === 'spelling'} disabled={submitting} onClick={() => nextRound(targetWordId, 'spelling')}>重点拼写</button>
      <Link className="gw-btn gw-btn-ghost" to="/reading">第二阶段 · 分级阅读 →</Link>
    </div> : null}
    {collectionMode && pendingSource > 0 ? <p className="gw-muted">{pendingSource} 个旧收藏待补来源句，暂不参与测试。</p> : null}
    {error ? <p className="gw-error" role="alert">{error}</p> : null}
    {loading ? <p className="gw-muted" role="status">正在准备单词自测…</p>
      : !bookId ? <div className="gw-panel"><p>先选择一本词书，再开始自测。</p><Link className="gw-btn" to="/">选择词书</Link></div>
      : !exercise ? <div className="gw-panel gw-empty-state">
        <h2>{error ? '自测暂未准备好' : '先学几个词，再来检查记忆。'}</h2>
        <p className="gw-muted">{collectionMode ? '请先学习收藏词，并为旧收藏补齐原句。' : '当前词书还没有学过的词。完成词卡学习后即可自测，也可先进入分级阅读。'}</p>
        <div className="gw-actions"><Link to={reviewPath} className="gw-btn">去学习单词</Link><button className="gw-btn gw-btn-ghost" type="button" onClick={() => nextRound()}>重新准备</button></div>
      </div> : <form className="gw-panel gw-reading-page" onSubmit={event => void submit(event)}>
        {cover ? <img className="gw-book-cover" src={cover} alt={exercise.sourceTitle + '配图'} /> : null}
        <div className="gw-eyebrow">{exercise.kind === 'collection' ? '收录时原句 · ' : ''}{exercise.sourceTitle}</div><h2>{exercise.title}</h2>
        <p className="gw-muted">{exercise.prompt}</p>
        {exercise.speaker ? <p className="gw-speaker">{exercise.speaker}</p> : null}
        {exercise.kind === 'spelling' ? <Pronunciation wordId={exercise.blanks[0].wordId} /> : null}
        {exercise.letterBank ? <p className="gw-muted">字母提示：{exercise.letterBank}</p> : null}
        {exercise.kind === 'recognition' ? <>
          <p className="gw-selftest-word" lang="en">{exercise.parts.filter(part => 'text' in part).map(part => 'text' in part ? part.text : '').join('')}</p>
          <fieldset className="gw-selftest-options" disabled={submitting || !!result}>
            <legend>请选择释义</legend>
            {exercise.options?.map((option, index) => <label key={option.id}>
              <input type="radio" name="meaning-answer" value={option.id} checked={answers[exercise.blanks[0].id] === option.id}
                onChange={() => setAnswers({ [exercise.blanks[0].id]: option.id })} />
              <span>{String.fromCharCode(65 + index)}. {option.text}</span>
            </label>)}
          </fieldset>
        </> : <div className="gw-reading-text">
          {exercise.parts.map((part, index) => {
            if ('text' in part) return <span key={index}>{part.text}</span>;
            const blank = exercise.blanks.find(item => item.id === part.blankId);
            if (!blank) return null;
            const checked = result?.answers.find(item => item.id === blank.id);
            return <span key={blank.id} className={'gw-cloze ' + (checked ? checked.correct ? 'correct' : 'incorrect' : '')}>
              <input id={'blank-' + blank.id} value={answers[blank.id] || ''} disabled={submitting || !!result} autoComplete="off" spellCheck={false} autoCapitalize="off"
                aria-label={(blank.translation || blank.phonetic || '单词拼写') + '，首字母 ' + blank.firstLetter} aria-describedby={'hint-' + blank.id}
                style={{ width: Math.min(25, Math.max(6, blank.length + 1)) + 'ch' }}
                placeholder={blank.firstLetter + '·'.repeat(Math.max(1, Math.min(blank.length - 1, 18)))}
                onChange={event => setAnswers(previous => ({ ...previous, [blank.id]: event.target.value }))} />
              <label id={'hint-' + blank.id} htmlFor={'blank-' + blank.id} className="gw-cloze-hint">{blank.firstLetter} · {blank.translation || blank.phonetic || '单词拼写'} · 长度 {blank.length}</label>
              {checked ? <span className="gw-cloze-feedback">{checked.correct ? '✓ 正确' : '应填 ' + checked.expected}</span> : null}
            </span>;
          })}
        </div>}
        {!result ? <div className="gw-actions"><button className="gw-btn" type="submit" disabled={submitting}>{submitting ? '正在检查并保存…' : '检查答案'}</button><span className="gw-muted">首次有效通过领取 +1 原石。</span></div>
          : <div className="gw-practice-result" role="status">
            <h3>{result.answers.every(answer => answer.correct) ? '本轮通过' : '记下订正，再安排一次回测。'}</h3>
            <p>答对 {result.answers.filter(answer => answer.correct).length} / {result.answers.length} 处 · {result.firstCorrect ? '首次自测通过' : '首次自测未通过'} · 累计自测 {result.attempts ?? 1} 次</p>
            {exercise.kind === 'recognition' ? <p>正确释义：{result.answers[0]?.expected}</p> : null}
            {result.earned.length ? <p className="gw-reward-notice"><Primogem sparkle /> 获得 {result.earned.length} 原石：{result.earned.map(entry => entry.lemma).join('、')}</p>
              : <p className="gw-muted">{result.answers.every(answer => answer.correct) ? '这个词已领取过奖励，重复通过不再发放。' : '答错不扣原石，已安排短期再学；先复习或换一词，再回来检查。'}</p>}
            <div className="gw-actions">
              <button className="gw-btn" type="button" onClick={() => nextRound()}>检查下一个词</button>
              <Link className="gw-btn gw-btn-ghost" to={reviewPath}>返回词卡学习</Link>
              <Link className="gw-btn gw-btn-ghost" to={collectionMode ? '/rewards?scope=collection' : '/rewards'}>奖励明细 · 共 {result.total} 原石</Link>
            </div>
          </div>}
      </form>}
    {exercise ? <p className="gw-muted">{exercise.kind === 'collection' ? '题目只引用本地保存的收录原句。' : '自测使用本地词典。认义干扰项不足时改用拼写，阅读材料在独立模块中使用。'}</p> : null}
  </section>;
}
