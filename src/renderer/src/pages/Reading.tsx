import ReadingPaperBody, { readingPracticeLabel } from '../components/ReadingPaperBody';
import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  READING_LEVELS, type ReadingAnalysis, type ReadingLevel, type ReadingPaperResult,
  type ReadingUnit, type ReadingUnitSummary,
} from '../../../shared/reading';
import { tokenizeClickable } from '../lib/text';
import ReadingWordPopup, { type ReadingWordSelection } from '../components/ReadingWordPopup';
import ReadingRewardAnimation from '../components/ReadingRewardAnimation';
import ReadingPackageManager from '../components/ReadingPackageManager';
import { useTraveler } from '../components/TravelerProvider';
import './reading.css';

const levelEntries = Object.entries(READING_LEVELS) as Array<[ReadingLevel, string]>;
function isLevel(value: string | null): value is ReadingLevel {
  return value !== null && Object.hasOwn(READING_LEVELS, value);
}
interface DraftSnapshot { attemptId: string; answers: Record<string, string>; locked: boolean }

export default function Reading() {
  const { pickerOpen } = useTraveler();
  const [params, setParams] = useSearchParams();
  const requestedUnit = params.get('unitId') || '';
  const requestedAttempt = params.get('attemptId') || '';
  const requestedQuestion = params.get('questionId') || '';
  const paragraphParam = params.get('paragraph') || '';
  const parsedParagraph = /^[1-9]\d*$/.test(paragraphParam) ? Number(paragraphParam) : 0;
  const requestedParagraph = Number.isSafeInteger(parsedParagraph) ? parsedParagraph : 0;
  const requestedLevel = params.get('level');
  const [level, setLevel] = useState<ReadingLevel>(() => isLevel(requestedLevel) ? requestedLevel : 'sh_zhongkao');
  const [units, setUnits] = useState<ReadingUnitSummary[]>([]);
  const [unit, setUnit] = useState<ReadingUnit | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [paper, setPaper] = useState<ReadingPaperResult | null>(null);
  const [viewed, setViewed] = useState(false);
  const [analysis, setAnalysis] = useState<ReadingAnalysis | null>(null);
  const [rewardVisible, setRewardVisible] = useState(false);
  const [wordSelection, setWordSelection] = useState<ReadingWordSelection | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [unitLoading, setUnitLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [packageBusy, setPackageBusy] = useState(false);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [listReload, setListReload] = useState(0);
  const [highlightParagraph, setHighlightParagraph] = useState<number | null>(null);
  const generation = useRef(0);
  const mutationLock = useRef(false);
  const snapshot = useRef<DraftSnapshot | null>(null);
  const lastSaved = useRef('');
  const draftVersion = useRef(0);
  const paperCommand = useRef<{ answers: string; id: string } | null>(null);
  const locked = !!paper;
  const busy = submitting || exporting || analysisLoading || unitLoading || navigating || packageBusy;

  function restoreUnit(next: ReadingUnit) {
    const restoredAnswers = next.paperResult?.answers || next.answers || {};
    setUnit(next); setLevel(next.level); setAnswers(restoredAnswers);
    setPaper(next.paperResult || null); setViewed(!!next.answersViewed);
    if (next.answersViewed && !next.paperResult) setNotice('PDF里有答案哦，这一轮就当热身，重开一轮再来拿奖励吧！');
    setRewardVisible(!!next.paperResult?.earnedCount && !!(next.rewardAnimationPending ?? next.paperResult.rewardAnimationPending));
    lastSaved.current = JSON.stringify(restoredAnswers);
    snapshot.current = { attemptId: next.attemptId, answers: restoredAnswers, locked: !!next.paperResult };
    setDraftStatus('idle');
  }
  async function loadAnalysis(attemptId: string, request: number, scroll = false) {
    setAnalysisLoading(true);
    try {
      const next = await window.api.getReadingAnalysis(attemptId);
      if (request !== generation.current) return;
      setAnalysis(next); setViewed(true);
      if (snapshot.current?.attemptId === attemptId) snapshot.current.locked = true;
      if (scroll && !requestedQuestion) requestAnimationFrame(() => jumpTo('reading-analysis'));
    } catch {
      if (request === generation.current) setError('派蒙还没整理好这页解答，等一下再翻翻吧。');
    } finally { if (request === generation.current) setAnalysisLoading(false); }
  }

  useEffect(() => {
    if (!requestedUnit && isLevel(requestedLevel)) setLevel(requestedLevel);
  }, [requestedUnit, requestedLevel]);
  useEffect(() => {
    let active = true;
    setListLoading(true); setListError('');
    void window.api.listReadingUnits(level).then(
      (next) => { if (active) setUnits(next); },
      () => { if (active) setListError('派蒙还没找到这一摞故事，再翻一次看看吧。'); },
    ).finally(() => { if (active) setListLoading(false); });
    return () => { active = false; };
  }, [level, listReload, requestedUnit]);

  useEffect(() => {
    const request = ++generation.current;
    setError(''); setNotice(''); setUnit(null); setBanner(null); setAnalysis(null);
    setAnswers({}); setPaper(null); setViewed(false); setRewardVisible(false);
    setWordSelection(null); setSubmitting(false); setExporting(false); setAnalysisLoading(false); setNavigating(false);
    setDraftStatus('idle'); setHighlightParagraph(null);
    snapshot.current = null; lastSaved.current = ''; paperCommand.current = null;
    mutationLock.current = false;
    if (!requestedUnit) { setUnitLoading(false); return; }
    setUnitLoading(true);
    void (async () => {
      try {
        const location = await window.api.resolveReadingLocation(requestedUnit, {
          questionId: requestedQuestion || undefined, paragraph: requestedParagraph || undefined,
          attemptId: requestedAttempt || undefined,
        });
        if (request !== generation.current) return;
        const canonicalQuestion = location.questionId || '';
        const canonicalParagraph = location.paragraph || 0;
        const canonicalAttempt = location.attemptId || '';
        if (location.unitId !== requestedUnit || canonicalQuestion !== requestedQuestion || canonicalParagraph !== requestedParagraph || canonicalAttempt !== requestedAttempt) {
          const canonical = new URLSearchParams(params);
          canonical.set('unitId', location.unitId);
          if (canonicalQuestion) canonical.set('questionId', canonicalQuestion); else canonical.delete('questionId');
          if (canonicalParagraph) canonical.set('paragraph', String(canonicalParagraph)); else canonical.delete('paragraph');
          if (canonicalAttempt) canonical.set('attemptId', canonicalAttempt); else canonical.delete('attemptId');
          setParams(canonical, { replace: true });
          // Changing the unit starts a fresh load effect. Resolve the old URL before opening any attempt.
          if (location.unitId !== requestedUnit || canonicalAttempt !== requestedAttempt) return;
        }
        const next = await window.api.getReadingUnit(location.unitId, false, location.attemptId);
        if (request !== generation.current) return;
        if (location.attemptId && next.attemptId !== location.attemptId) {
          const canonical = new URLSearchParams(params);
          canonical.set('unitId', next.id); canonical.set('attemptId', next.attemptId);
          setParams(canonical, { replace: true });
          return;
        }
        const image = await window.api.getReadingBanner(location.unitId, undefined, next.attemptId).catch(() => null);
        if (request !== generation.current) return;
        restoreUnit(next); setBanner(image);
        if (next.paperResult) await loadAnalysis(next.attemptId, request);
      } catch {
        if (request === generation.current) setError('这篇故事还没翻开，派蒙陪你再试一次。');
      } finally { if (request === generation.current) setUnitLoading(false); }
    })();
    return () => {
      generation.current += 1;
      const pending = snapshot.current;
      if (pending && !pending.locked && JSON.stringify(pending.answers) !== lastSaved.current) {
        void window.api.saveReadingDraft(pending.attemptId, pending.answers).catch(() => {});
      }
    };
  }, [requestedUnit, requestedAttempt, reload]);

  useEffect(() => {
    if (!unit || locked || submitting || exporting || unitLoading) return;
    snapshot.current = { attemptId: unit.attemptId, answers, locked: false };
    const serialized = JSON.stringify(answers);
    if (serialized === lastSaved.current) return;
    const request = generation.current, version = ++draftVersion.current, attemptId = unit.attemptId;
    const timer = window.setTimeout(() => {
      if (request !== generation.current || snapshot.current?.locked) return;
      setDraftStatus('saving');
      void window.api.saveReadingDraft(attemptId, answers).then(() => {
        if (request === generation.current && version === draftVersion.current && !snapshot.current?.locked) {
          lastSaved.current = serialized; setDraftStatus('saved');
        }
      }).catch(() => {
        if (request === generation.current && version === draftVersion.current && !snapshot.current?.locked) setDraftStatus('error');
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [answers, unit?.attemptId, locked, submitting, exporting, unitLoading]);

  useEffect(() => {
    if (!unit || !requestedQuestion || unitLoading) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById((analysis ? 'reading-analysis-q-' : 'reading-q-') + requestedQuestion);
      target?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [unit?.id, requestedQuestion, unitLoading, !!analysis]);
  useEffect(() => {
    if (!unit || unitLoading || requestedQuestion || requestedParagraph < 1 || requestedParagraph > unit.paragraphs.length) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById((analysis ? 'reading-bilingual-' : 'reading-p-') + unit.id + '-' + requestedParagraph);
      target?.scrollIntoView({ block: 'center' });
      target?.focus({ preventScroll: true });
      setHighlightParagraph(requestedParagraph);
    });
    return () => cancelAnimationFrame(frame);
  }, [unit?.id, requestedParagraph, requestedQuestion, unitLoading, !!analysis]);
  useEffect(() => {
    if (highlightParagraph === null) return;
    const timer = window.setTimeout(() => setHighlightParagraph(null), 2500);
    return () => window.clearTimeout(timer);
  }, [highlightParagraph]);

  function changeAnswer(questionId: string, answer: string) {
    if (locked || mutationLock.current) return;
    setAnswers((previous) => {
      const next = { ...previous, [questionId]: answer };
      if (unit) snapshot.current = { attemptId: unit.attemptId, answers: next, locked: false };
      return next;
    });
    setDraftStatus('idle');
  }
  function jumpTo(id: string) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  function showEvidence(paragraph: number) {
    if (!unit) return;
    const target = document.getElementById('reading-bilingual-' + unit.id + '-' + paragraph);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target?.focus({ preventScroll: true }); setHighlightParagraph(paragraph);
  }
  async function savePendingDraft(): Promise<boolean> {
    const request = generation.current;
    const pending = snapshot.current;
    if (pending && !pending.locked && JSON.stringify(pending.answers) !== lastSaved.current) {
      try {
        await window.api.saveReadingDraft(pending.attemptId, pending.answers);
        if (request !== generation.current || snapshot.current?.attemptId !== pending.attemptId) return false;
        lastSaved.current = JSON.stringify(pending.answers);
      } catch {
        if (request === generation.current && snapshot.current?.attemptId === pending.attemptId) setError('派蒙还没记好你的答案，稍等一下再出发吧。');
        return false;
      }
    }
    return request === generation.current;
  }
  async function directory(nextLevel = level) {
    if (packageBusy) return;
    if (!await savePendingDraft()) return;
    setLevel(nextLevel); setParams({ level: nextLevel });
  }
  async function nextReading() {
    if (!unit || busy || mutationLock.current) return;
    const request = generation.current;
    mutationLock.current = true; setNavigating(true); setError(''); setNotice('');
    try {
      if (!await savePendingDraft()) return;
      // Read current persisted results so a just-submitted perfect round is skipped.
      const available = await window.api.listReadingUnits(unit.level);
      if (request !== generation.current) return;
      setUnits(available);
      const current = available.findIndex(item => item.id === unit.id);
      const ordered = current < 0 ? available : [...available.slice(current + 1), ...available.slice(0, current)];
      const next = ordered.find(item => item.id !== unit.id && item.completionStatus !== 'perfect');
      if (next) {
        setParams({ level: next.level, unitId: next.id });
        requestAnimationFrame(() => window.scrollTo({ top: 0 }));
      } else {
        setNotice(available.length && available.every(item => item.completionStatus === 'perfect')
          ? '这一层的故事都答对啦！回目录换一层书架看看吧。'
          : '这一层没有其他待挑战的故事啦，可以重读这一篇，或者回目录换个级别看看！');
        requestAnimationFrame(() => jumpTo('reading-notice'));
      }
    } catch {
      if (request === generation.current) {
        setError('派蒙还没找到下一篇故事，再试一次吧。');
        requestAnimationFrame(() => jumpTo('reading-error'));
      }
    } finally {
      if (request === generation.current) { setNavigating(false); mutationLock.current = false; }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!unit || locked || busy || mutationLock.current) return;
    const missing = unit.questions.map((question, index) => ({ question, number: index + 1 })).filter(({ question }) => !answers[question.id]?.trim());
    if (missing.length) {
      setError('还有第 ' + missing.map((item) => item.number).join('、') + ' 题没写呢，填好再让派蒙一起看看吧。');
      jumpTo('reading-q-' + missing[0].question.id);
      document.getElementById('reading-q-' + missing[0].question.id)?.querySelector<HTMLElement>('input,select')?.focus({ preventScroll: true });
      return;
    }
    const request = generation.current, attemptId = unit.attemptId, serialized = JSON.stringify(answers);
    if (!paperCommand.current || paperCommand.current.answers !== serialized) paperCommand.current = { answers: serialized, id: crypto.randomUUID() };
    mutationLock.current = true;
    if (snapshot.current) snapshot.current.locked = true;
    setSubmitting(true); setError(''); setNotice('');
    try {
      const result = await window.api.submitReadingPaper(attemptId, answers, paperCommand.current.id);
      if (request !== generation.current) return;
      setPaper(result); setAnswers(result.answers);
      setRewardVisible(result.earnedCount > 0 && result.rewardAnimationPending);
      snapshot.current = { attemptId, answers: result.answers, locked: true };
      lastSaved.current = JSON.stringify(result.answers);
      await loadAnalysis(attemptId, request, true);
    } catch {
      if (request === generation.current) {
        setError('派蒙还没看清这张答卷，再交一次就好。');
        try {
          const restored = await window.api.getReadingUnit(unit.id, false, unit.attemptId);
          if (request === generation.current) {
            if (restored.paperResult) {
              restoreUnit(restored); setError(''); await loadAnalysis(restored.attemptId, request, true);
            } else {
              setViewed(!!restored.answersViewed);
              if (snapshot.current?.attemptId === attemptId) snapshot.current.locked = false;
            }
          }
        } catch { if (snapshot.current?.attemptId === attemptId) snapshot.current.locked = false; }
      }
    } finally {
      if (request === generation.current) { setSubmitting(false); mutationLock.current = false; }
    }
  }
  async function acknowledgeReward() {
    if (!paper) return;
    const request = generation.current, attemptId = paper.attemptId;
    await window.api.acknowledgeReadingReward(attemptId);
    if (request === generation.current) {
      setRewardVisible(false);
      setPaper((previous) => previous?.attemptId === attemptId ? { ...previous, rewardAnimationPending: false } : previous);
    }
  }
  async function exportPdf() {
    if (!unit || busy || mutationLock.current) return;
    const request = generation.current;
    mutationLock.current = true; setExporting(true); setError(''); setNotice('');
    try {
      const currentDraft = snapshot.current;
      if (currentDraft && !currentDraft.locked) {
        await window.api.saveReadingDraft(currentDraft.attemptId, currentDraft.answers);
        if (request !== generation.current || snapshot.current?.attemptId !== currentDraft.attemptId) return;
        lastSaved.current = JSON.stringify(currentDraft.answers);
      }
      if (request !== generation.current || snapshot.current?.attemptId !== unit.attemptId) return;
      const result = await window.api.exportReadingPdf(unit.id, unit.attemptId);
      if (request !== generation.current) return;
      if (result.ok) {
        setViewed(true);
        setNotice(paper ? '带好啦！故事、题目和解答都放进 PDF 里了。' : 'PDF里有答案哦，这一轮就当热身，重开一轮再来拿奖励吧！');
      } else setNotice(result.error.includes('取消') ? '取消保存啦，咱们接着读。' : '这次没能把故事带走，再试一次吧。');
    } catch {
      if (request === generation.current) {
        setError('这次没能把故事带走，再试一次吧。');
        try {
          const restored = await window.api.getReadingUnit(unit.id, false, unit.attemptId);
          if (request === generation.current) setViewed(!!restored.answersViewed);
        } catch { /* Retain the user's current answers. */ }
      }
    } finally {
      if (request === generation.current) { setExporting(false); mutationLock.current = false; }
    }
  }
  async function startNew() {
    if (!unit || busy || mutationLock.current || (!paper && !viewed && !unit.updateAvailable)) return;
    const request = generation.current;
    mutationLock.current = true; setUnitLoading(true); setError('');
    try {
      if (!await savePendingDraft()) return;
      const next = await window.api.getReadingUnit(unit.id, true);
      if (request !== generation.current) return;
      const image = await window.api.getReadingBanner(next.id, undefined, next.attemptId).catch(() => null);
      if (request !== generation.current) return;
      restoreUnit(next); setBanner(image); setAnalysis(null); setNotice('新的答卷准备好啦，再读一遍故事吧！');
      if (requestedAttempt) setParams({ level: next.level, unitId: next.id }, { replace: true });
      paperCommand.current = null;
      requestAnimationFrame(() => jumpTo('reading-passage'));
    } catch { if (request === generation.current) setError('新答卷还没准备好，派蒙再找找。'); }
    finally { if (request === generation.current) { setUnitLoading(false); mutationLock.current = false; } }
  }

  return <section className="rd-page">
    <div className="gw-eyebrow">派蒙的故事时间</div>
    <h1 className="gw-hero-title">提瓦特大陆有太多故事</h1>
    <p className="gw-hero-sub rd-intro">背单词累了吗？来读读故事吧，答对题有奖励哦。</p>
    {!requestedUnit ? <>
      <ReadingPackageManager onImported={() => setListReload((value) => value + 1)} onBusyChange={setPackageBusy} />
      <div className="rd-levels" role="group" aria-label="选择阅读级别">{levelEntries.map(([key, label]) =>
        <button key={key} type="button" className={'gw-btn ' + (key === level ? 'rd-level-active' : 'gw-btn-ghost')} aria-pressed={key === level} disabled={packageBusy} onClick={() => void directory(key)}>{label}</button>)}</div>
      <div className="rd-catalog-heading"><h2>{READING_LEVELS[level]}</h2><Link to="/practice">再背一会儿单词 →</Link></div>
      {listError ? <div className="gw-error" role="alert"><p>{listError}</p><button type="button" className="gw-btn gw-btn-ghost" onClick={() => setListReload((value) => value + 1)}>再找找故事</button></div> : null}
      {listLoading ? <p className="gw-muted" role="status">派蒙翻翻故事书…</p> : !units.length && !listError ? <div className="gw-panel"><p>这层书架还空着，去别处看看吧。</p></div>
        : <div className="rd-catalog">{units.map((item) => <article key={item.id} className="gw-panel rd-unit-card" data-reading-unit={item.id} data-reading-status={item.completionStatus}>
          <div className="gw-eyebrow rd-reading-meta"><span>{readingPracticeLabel(item.practiceType)}</span><span>{item.wordCount} 词</span><span>{item.questionCount} 题</span>{item.estimatedMinutes ? <span>建议 {item.estimatedMinutes} 分钟</span> : null}</div>
          <div className="rd-unit-title"><h3>{item.title}</h3>{item.completionStatus !== 'unsubmitted' ? <span className={'rd-completion-badge ' + (item.completionStatus === 'perfect' ? 'rd-completion-perfect' : '')}><span aria-hidden="true">{item.completionStatus === 'perfect' ? '✦' : '✓'}</span>{item.completionStatus === 'perfect' ? '已全对' : '已做过'}</span> : null}</div>
          {item.packageName ? <p className="gw-muted rd-unit-package">{item.packageName}{item.contentVersion ? ` · 版本 ${item.contentVersion}` : ''}</p> : null}
          <button type="button" className="gw-btn" disabled={packageBusy} onClick={() => setParams({ level: item.level, unitId: item.id })}>读读这个故事</button>
        </article>)}</div>}
    </> : <>
      <div className="gw-actions rd-toolbar">
        <button type="button" className="gw-btn gw-btn-ghost" disabled={busy} onClick={() => void directory()}>← 返回故事目录</button>
        {unit ? <button type="button" className="gw-btn gw-btn-ghost" disabled={busy} onClick={() => void exportPdf()}>{exporting ? '派蒙在装进背包…' : '保存题目与解析 PDF'}</button> : null}
        {unit && viewed && !paper ? <button type="button" className="gw-btn gw-btn-ghost" disabled={busy} onClick={() => void startNew()}>重新挑战</button> : null}
      </div>
      {unitLoading ? <p className="gw-muted" role="status">派蒙找到书签啦，马上就好…</p> : null}
      {error ? <div id="reading-error" className="gw-error" role="alert"><p>{error}</p>{!unit ? <button type="button" className="gw-btn gw-btn-ghost" onClick={() => setReload((value) => value + 1)}>再翻开一次</button> : null}</div> : null}
      {notice ? <p id="reading-notice" className="rd-notice" role="status">{notice}</p> : null}
      {unit && !unitLoading ? <>
        {unit.updateAvailable ? <aside className="rd-notice rd-version-notice" aria-label="阅读内容版本提示">
          <p>本轮使用{unit.packageName ? `「${unit.packageName}」` : '阅读包'}{unit.contentVersion ? `版本 ${unit.contentVersion}` : '的原版本'}。阅读包已更新，本轮可以继续完成，新一轮会使用当前版本。</p>
          <p>派蒙把这张答卷留好啦，继续读，或者准备一张新答卷吧。</p>
          <div className="gw-actions"><button type="button" className="gw-btn gw-btn-ghost" disabled={busy} onClick={() => jumpTo(paper ? 'reading-analysis' : 'reading-passage')}>{paper ? '查看本轮答卷' : '继续本轮'}</button><button type="button" className="gw-btn" disabled={busy} onClick={() => void startNew()}>从新版开始新一轮</button></div>
        </aside> : null}
        <nav className="rd-section-nav" aria-label="故事导航">
          <button type="button" onClick={() => jumpTo('reading-passage')}>读故事</button>
          <button type="button" onClick={() => jumpTo('reading-questions')}>答题区</button>
          {paper || analysis ? <button type="button" onClick={() => jumpTo('reading-analysis')}>看看解答</button> : null}
        </nav>
        <ReadingPaperBody unit={unit} banner={banner} answers={answers} locked={locked} busy={busy}
          submitting={submitting} draftStatus={draftStatus} highlightParagraph={highlightParagraph}
          onAnswer={changeAnswer} onSubmit={(event) => void submit(event)} />
        {paper || analysis ? <section id="reading-analysis" className="rd-analysis" aria-labelledby="reading-analysis-title">
          <div className="rd-analysis-heading"><h2 id="reading-analysis-title">{paper ? <>本轮得分 <strong className="rd-paper-score">{paper.score} / {paper.maxScore}</strong></> : '派蒙的故事笔记'}</h2><button type="button" className="gw-btn" disabled={busy} onClick={() => void nextReading()}>{navigating ? '派蒙找下一篇…' : '下一篇阅读 →'}</button></div>
          {analysisLoading ? <p className="gw-muted" role="status">派蒙在整理故事笔记…</p> : !analysis ? <button type="button" className="gw-btn" onClick={() => void loadAnalysis(unit.attemptId, generation.current)}>翻开解答</button> : <>
            <div className="gw-panel rd-analysis-block"><h3>答案解析</h3>{analysis.questions.map((item) => {
              const index = unit.questions.findIndex((question) => question.id === item.questionId);
              const question = unit.questions[index], result = paper?.questionResults[item.questionId];
              const answer = question?.options?.find((option) => option.id === answers[item.questionId])?.text || answers[item.questionId];
              return <article key={item.questionId} id={'reading-analysis-q-' + item.questionId} className="rd-answer-explanation">
                <h4>第 {index + 1} 题{result ? <span className={result.correct ? 'rd-verdict-correct' : 'rd-verdict-wrong'}>{result.correct ? '答对啦' : '再看看这里'}</span> : null}</h4>
                <p className="gw-muted">你的答案：<span lang="en">{answer || '还没作答'}</span></p>
                <p className="rd-answer-line">正确答案：<strong lang="en">{item.answer}</strong></p>
                <p>{item.explanation}</p>
                {item.optionExplanations?.length ? <ul className="rd-option-analysis">{item.optionExplanations.map((option) => {
                  const optionIndex = question?.options?.findIndex((candidate) => candidate.id === option.id) ?? -1;
                  return <li key={option.id}>{/^P[1-9]\d*$/.test(option.id) ? option.id : optionIndex >= 0 ? String.fromCharCode(65 + optionIndex) : option.id}：{option.text}</li>;
                })}</ul> : null}
                <div className="rd-evidence">{item.evidence.map((paragraph) => <button type="button" key={paragraph} className="rd-text-button" onClick={() => showEvidence(paragraph)}>读读原文 P{paragraph} ↓</button>)}</div>
              </article>;
            })}</div>
            <div className="gw-panel rd-analysis-block rd-bilingual"><h3>原文与译文</h3><p className="gw-muted">点一下英文单词，派蒙陪你查一查；喜欢的词还能收藏起来。</p>
              {analysis.bilingualParagraphs.map((paragraph) => <article key={paragraph.paragraph} id={'reading-bilingual-' + unit.id + '-' + paragraph.paragraph} tabIndex={-1} className={'rd-bilingual-paragraph ' + (highlightParagraph === paragraph.paragraph ? 'rd-paragraph-highlight' : '')}>
                <div className="gw-eyebrow">P{paragraph.paragraph}</div>
                <p lang="en" className="rd-bilingual-en" onClick={(event) => { if (event.target instanceof HTMLElement) event.target.closest<HTMLElement>('.gw-token')?.focus({ preventScroll: true }); }}>{tokenizeClickable(paragraph.textEn, (surface, start, end) => setWordSelection({ surface, start, end, paragraph: paragraph.paragraph }))}</p>
                <p lang="zh-CN" className="rd-bilingual-chs">{paragraph.textChs}</p>
              </article>)}
              <details className="rd-story-notes"><summary>再读懂一点</summary><p>{analysis.overview}</p>
                <h4>故事脉络</h4><ol className="rd-structure">{analysis.structure.map((item, index) => <li key={index}><p>{item.description}</p><div className="rd-evidence">{item.paragraphs.map((paragraph) => <button key={paragraph} type="button" className="rd-text-button" onClick={() => showEvidence(paragraph)}>P{paragraph}</button>)}</div></li>)}</ol>
                <h4>句子拆解</h4>{analysis.sentences.map((item, index) => <div key={index} className="rd-key-sentence"><button type="button" className="rd-text-button" onClick={() => showEvidence(item.paragraph)}>P{item.paragraph}</button><blockquote lang="en">{item.text}</blockquote><p>{item.explanation}</p></div>)}
              </details>
            </div>
            <div className="gw-panel rd-analysis-block"><h3>单词解释</h3><dl className="rd-glossary">{analysis.glossary.map((item,index) => <div key={item.kind + '-' + item.term+'-'+index}><dt lang="en">{item.term}</dt><dd>{item.explanation}</dd></div>)}</dl></div>
          </>}
          <div className="gw-actions rd-footer-actions"><button type="button" className="gw-btn" disabled={busy} onClick={() => void nextReading()}>{navigating ? '派蒙找下一篇…' : '下一篇阅读 →'}</button><button type="button" className="gw-btn gw-btn-ghost" disabled={busy} onClick={() => void directory()}>返回故事目录</button><button type="button" className="gw-btn gw-btn-ghost" disabled={busy} onClick={() => void startNew()}>再读再答一次</button><Link to="/collection" className="gw-btn gw-btn-ghost">看看收藏词表</Link></div>
        </section> : null}
      </> : null}
    </>}
    {unit && wordSelection ? <ReadingWordPopup key={unit.attemptId + '-' + wordSelection.paragraph + '-' + wordSelection.start} selection={wordSelection} attemptId={unit.attemptId} onClose={() => setWordSelection(null)} /> : null}
    {paper && rewardVisible && !pickerOpen ? <ReadingRewardAnimation key={paper.attemptId} count={paper.earnedCount} onFinish={acknowledgeReward} /> : null}
  </section>;
}
