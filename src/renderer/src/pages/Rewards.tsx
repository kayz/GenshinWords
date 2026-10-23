import Primogem from '../components/Primogem';
import type { RewardSummary } from '../../../shared/rewards';
import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { COLLECTION_ID } from '../../../shared/collection';
import { READING_LEVELS, type ReadingLevel } from '../../../shared/reading';
import { errorMessage, localDate } from '../lib/format';

type SourceFilter = 'all' | 'word' | 'reading' | 'collection';
export default function Rewards() {
  const [params] = useSearchParams();
  const collectionMode = params.get('scope') === 'collection';
  const [source, setSource] = useState<SourceFilter>(collectionMode ? 'collection' : 'all');
  const [summary, setSummary] = useState<RewardSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setSource(collectionMode ? 'collection' : 'all'); setPage(0); }, [collectionMode]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void window.api.getRewards().then(value => { if (active) setSummary(value); })
      .catch(cause => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);
  const normalized = query.trim().toLowerCase();
  const entries = summary?.history.filter(entry => {
    if (source === 'collection' && (entry.source !== 'word' || entry.bookId !== COLLECTION_ID)) return false;
    if (source !== 'all' && source !== 'collection' && entry.source !== source) return false;
    const text = entry.source === 'word' ? entry.lemma + ' ' + entry.translation + ' ' + entry.bookName
      : entry.unitTitle + ' ' + entry.questionTitle + ' ' + (entry.questionFormat || '');
    return text.toLowerCase().includes(normalized);
  }) || [];
  const pages = Math.max(1, Math.ceil(entries.length / 30));
  const currentPage = Math.min(page, pages - 1);
  return <section>
    <div className="gw-eyebrow">提瓦特 · 奖励明细</div>
    <h1 className="gw-hero-title">每一颗，都有来处。</h1>
    <p className="gw-hero-sub">单词自测与阅读答题分别奖励，合计为原石总数。同一学习项只领取一次，答错不扣除。</p>
    {loading ? <p className="gw-muted" role="status">正在读取本地奖励记录…</p> : error ? <div className="gw-panel">
      <p className="gw-error" role="alert">{error}</p><button className="gw-btn" type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button>
    </div> : summary ? <>
      <div className="gw-panel gw-reward-overview">
        <Primogem className="gw-gem" sparkle />
        <div><span className="gw-eyebrow">全部学习内容累计</span><div><strong className="gw-reward-total">{summary.total}</strong> 原石</div>
          <p className="gw-muted">单词自测 {summary.wordTotal} · 阅读答题 {summary.readingTotal}</p></div>
        <div className="gw-actions"><Link to="/practice" className="gw-btn gw-btn-ghost">单词自测</Link><Link to="/reading" className="gw-btn">分级阅读</Link></div>
      </div>
      <div className="gw-browse-filters">
        <label className="gw-label">奖励来源
          <select className="gw-select" value={source} onChange={event => { setSource(event.target.value as SourceFilter); setPage(0); }}>
            <option value="all">全部来源</option><option value="word">单词自测（含收藏词）</option><option value="reading">阅读答题</option><option value="collection">仅收藏词原句自测</option>
          </select>
        </label>
        <label className="gw-label">查找学习内容
          <input className="gw-input" value={query} placeholder="单词、释义、篇章或题目" onChange={event => { setQuery(event.target.value); setPage(0); }} />
        </label>
      </div>
      <p className="gw-muted">当前筛选：{entries.length} 笔，每笔 +1。已获得的原石保留在累计记录中。</p>
      <div className="gw-reward-entries">
        {entries.slice(currentPage * 30, (currentPage + 1) * 30).map(entry => <article className="gw-panel gw-reward-entry" key={entry.id}>
          <div><span className="gw-eyebrow">{entry.source === 'word' ? '单词自测 · ' + entry.bookName
            : '阅读答题 · ' + (READING_LEVELS[entry.level as ReadingLevel] || entry.level)}</span>
            <h2>{entry.source === 'word' ? entry.lemma : entry.unitTitle}</h2>
            <p>{entry.source === 'word' ? entry.translation : (entry.questionNumber ? '第 ' + entry.questionNumber + ' 题 · ' : '') + (entry.questionFormat ? entry.questionFormat + ' · ' : '') + entry.questionTitle}</p>
            <p className="gw-muted"><time dateTime={entry.earnedAt}>{localDate(entry.earnedAt)}</time></p>
          </div>
          <div className="gw-reward-entry-action"><strong className="gw-text-link"><Primogem /> +1</strong>
            <Link to={entry.source === 'word'
              ? '/practice?wordId=' + entry.wordId + '&bookId=' + encodeURIComponent(entry.bookId) + (entry.bookId === COLLECTION_ID ? '&scope=collection' : '')
              : '/reading?unitId=' + encodeURIComponent(entry.unitId) + '&questionId=' + encodeURIComponent(entry.questionId) + (entry.attemptId ? '&attemptId=' + encodeURIComponent(entry.attemptId) : '')} className="gw-btn gw-btn-ghost">回到学习内容</Link>
          </div>
        </article>)}
      </div>
      {!entries.length ? <div className="gw-panel gw-empty-state"><h2>{summary.total ? '没有匹配的奖励记录。' : '第一颗原石，等你点亮。'}</h2><p className="gw-muted">先学习几个词并完成自测，或在分级阅读中答对一道题。</p></div> : null}
      {pages > 1 ? <div className="gw-pagination"><button className="gw-btn gw-btn-ghost" type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pages}</span><button className="gw-btn gw-btn-ghost" type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div> : null}
    </> : null}
  </section>;
}
