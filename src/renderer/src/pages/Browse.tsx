import { coverObjectPosition } from '../../../shared/cover-focus';
import { speakerInitial } from '../../../shared/speaker-initial';
import { useTraveler } from '../components/TravelerProvider';
import { isTravelerSpeaker } from '../../../shared/traveler';
import type { VersionSummary, SourceSummary, Chapter, Quest, DialogueLine, BrowseKey, PdfRequest } from '../../../shared/models';
import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { highlightSurface, tokenizeClickable } from '../lib/text';
import { localImage } from '../lib/assets';
import { errorMessage, localDate } from '../lib/format';

const pageSize = 40;

/** Keep a source focal point centered after CSS object-fit:cover crops to 4:1. */
function positionChapterCover(image: HTMLImageElement, chapter: Chapter | undefined): void {
  if (chapter?.type !== 'voice') return;
  const position = coverObjectPosition(image.naturalWidth, image.naturalHeight, chapter.cover_focus || { x: .5, y: .35 });
  image.style.objectPosition = position.x * 100 + '% ' + position.y * 100 + '%';
}

export default function Browse() {
  const traveler = useTraveler();
  const [params] = useSearchParams();
  const sourceLineId = Number(params.get('lineId')) || null;
  const sourceLink = !!(sourceLineId || params.get('chapterId') || params.get('questId'));
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [version, setVersion] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterId, setChapterId] = useState<number | null>(Number(params.get('chapterId')) || null);
  const [quests, setQuests] = useState<Quest[]>([]);
  const [questId, setQuestId] = useState<number | null>(Number(params.get('questId')) || null);
  const [lines, setLines] = useState<DialogueLine[]>([]);
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const [cover, setCover] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [bookId, setBookId] = useState('');
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function notify(message: string) {
    setToast(message);
  }
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4e3);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [currentBook, vs, ss, savedVersion, savedType] = await Promise.all([
          window.api.getSetting('currentBook'),
          window.api.listVersions(),
          window.api.listSources(),
          window.api.getBrowseProgress('version'),
          window.api.getBrowseProgress('typeFilter'),
        ]);
        if (!active) return;
        setBookId(currentBook);
        setVersions(vs);
        setSources(ss);
        setVersion(
          sourceLink ? '' : vs.find((item) => item.version === savedVersion)?.version ?? '',
        );
        setTypeFilter(sourceLink ? '' : ss.some((item) => item.type === savedType) ? savedType : '');
        setReady(true);
      } catch (cause) {
        if (active) {
          setError(errorMessage(cause));
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void window.api
      .listChapters(version || void 0, typeFilter || void 0)
      .then(
        async (list) => {
          const linkedId = Number(params.get('chapterId'));
          if (sourceLink && linkedId && !list.some(item => item.id === linkedId)) {
            const linked = await window.api.getChapter(linkedId).catch(cause => { if (active) setError(errorMessage(cause)); return null; });
            if (linked) list = [...list, linked];
          }
          if (active) setChapters(list);
        },
        (cause) => {
          if (active) setError(errorMessage(cause));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [version, typeFilter, ready, retry]);
  useEffect(() => {
    if (chapterId == null) return;
    let active = true;
    const chapter2 = chapters.find((item) => item.id === chapterId);
    setCover(null);
    void Promise.all([
      window.api.listQuests(chapterId),
      localImage(chapter2?.cover_path).catch(() => null),
    ])
      .then(
        ([list, image]) => {
          if (active) {
            setQuests(list);
            setCover(image);
          }
        },
        (cause) => {
          if (active) setError(errorMessage(cause));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [chapterId, chapters]);
  useEffect(() => {
    if (questId == null) return;
    let active = true;
    void window.api
      .listDialog(questId)
      .then(
        (list) => {
          if (active) {
            setLines(list);
            if (sourceLineId) {
              const at = list.findIndex(line => line.id === sourceLineId);
              if (at >= 0) setPage(Math.floor(at / pageSize));
              else notify('当前资料中未找到原来源台词，收藏词表仍保留收录时的句子。');
            }
          }
        },
        (cause) => {
          if (active) setError(errorMessage(cause));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [questId]);
  const visibleLines = useMemo(
    () => lines.slice(page * pageSize, (page + 1) * pageSize),
    [lines, page],
  );
  useEffect(() => {
    let active = true;
    const paths = [
      ...new Set(visibleLines.map((line) => line.speaker_image).filter((path): path is string => !!path)),
    ];
    void Promise.all(
      paths.map(async (path) => [path, await localImage(path).catch(() => null)] as const),
    ).then((items) => {
      if (active) setAvatars(Object.fromEntries(items.filter((item): item is readonly [string, string] => !!item[1])));
    });
    return () => {
      active = false;
    };
  }, [visibleLines]);
  function selectFilter(kind: BrowseKey, value: string) {
    setLoading(true);
    setError('');
    setChapters([]);
    setChapterId(null);
    setQuests([]);
    setQuestId(null);
    setLines([]);
    setCover(null);
    if (kind === 'version') setVersion(value);
    else setTypeFilter(value);
    void window.api
      .setBrowseProgress(kind, value)
      .catch((cause) => notify(`浏览位置未保存：${errorMessage(cause)}`));
  }
  function selectChapter(id: number) {
    setLoading(true);
    setError('');
    setQuests([]);
    setQuestId(null);
    setLines([]);
    setCover(null);
    setChapterId(id);
  }
  function selectQuest(id: number) {
    setLoading(true);
    setError('');
    setLines([]);
    setAvatars({});
    setPage(0);
    setQuestId(id);
  }
  async function onWordClick(lineId: number, start: number, end: number) {
    try {
      const result = await window.api.collectWord({ lineId, start, end });
      const labels = { added: '已收录到收藏词表', existing: '已在收藏词表中，保留原收录句子', restored: '已恢复收藏', 'source-added': '已补齐收藏来源句' };
      notify((labels[result.status] || '已收录') + '：' + result.word.lemma);
    } catch (cause) {
      notify('收录失败：' + errorMessage(cause));
    }
  }
  async function downloadPdf(req: PdfRequest) {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await window.api.exportPdf({
        ...req,
        bookId: bookId || void 0,
      });
      notify(result.ok === true ? `已保存 PDF：${result.path}` : result.error || '导出失败');
    } catch (cause) {
      notify(`导出失败：${errorMessage(cause)}`);
    } finally {
      if (mounted.current) setExporting(false);
    }
  }
  const chapter = chapters.find((item) => item.id === chapterId);
  const quest = quests.find((item) => item.id === questId);
  const pages = Math.max(1, Math.ceil(lines.length / pageSize));
  return (
    <section>
      <div className="gw-eyebrow">提瓦特 · 旅途见闻</div>
      <h1 className="gw-hero-title">剧情浏览</h1>
      <p className="gw-hero-sub">
        按版本与来源阅读原文。点击英文单词可保存到独立收藏词表，也可以把整章故事导出为 PDF。
      </p>
      <p><Link to="/collection">查看收藏词表 →</Link></p>
      <div className="gw-panel gw-browse-filters">
        <div>
          <label className="gw-label" htmlFor="ver">
            游戏版本
          </label>
          <select
            id="ver"
            className="gw-select"
            value={version}
            onChange={(event) => selectFilter('version', event.target.value)}
          >
            <option value="">全部版本</option>
            {versions.map((item) => (
              <option key={item.version} value={item.version}>
                {item.version}（{item.chapter_count} 章）
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="gw-label" htmlFor="src">
            剧情来源
          </label>
          <select
            id="src"
            className="gw-select"
            value={typeFilter}
            onChange={(event) => selectFilter('typeFilter', event.target.value)}
          >
            <option value="">全部来源</option>
            {sources.map((item) => (
              <option key={item.type} value={item.type}>
                {item.label}（{item.chapter_count}）
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <div className="gw-error" role="alert">
          <p>{error}</p>
          <button
            className="gw-btn gw-btn-ghost"
            type="button"
            onClick={() => {
              setChapterId(null);
              setQuestId(null);
              setLoading(true);
              setError('');
              setRetry((value) => value + 1);
            }}
          >
            重新读取章节
          </button>
        </div>
      ) : null}
      {chapterId == null ? (
        <>
          {loading ? (
            <p className="gw-muted" role="status">
              正在读取本地章节…
            </p>
          ) : (
            chapters.map((item) => (
              <button key={item.id} type="button" className="gw-list-item" onClick={() => selectChapter(item.id)}>
                <div className="gw-speaker">
                  {item.source_label || item.type}
                  {item.chapter_num ? ` · ${item.chapter_num}` : ''}
                </div>
                <div>{item.title_chs || item.title_en}</div>
                {item.type !== 'voice' ? <div className="gw-muted">{item.title_en}</div> : null}
                {item.variant_label ? <div className="gw-chapter-variant">{item.variant_label}{item.duplicate_text_count && item.duplicate_text_count > 1 ? ` · 同文来源 ${item.duplicate_text_count} 份` : ''}</div> : null}
              </button>
            ))
          )}
          {!loading && chapters.length === 0 ? (
            <p className="gw-muted">此筛选条件下暂无章节。可选择其他版本或来源。</p>
          ) : null}
        </>
      ) : questId == null ? (
        <>
          <div className="gw-actions gw-browse-actions">
            <button
              type="button"
              className="gw-btn gw-btn-ghost"
              onClick={() => {
                setLoading(false);
                setChapterId(null);
              }}
            >
              ← 返回章节
            </button>
            <button
              type="button"
              className="gw-btn"
              disabled={exporting}
              onClick={() =>
                void downloadPdf({
                  scope: 'chapter',
                  chapterId,
                })
              }
            >
              {exporting ? '正在导出…' : '导出本章 PDF'}
            </button>
          </div>
          {cover ? (
            <img
              key={chapter?.id}
              src={cover}
              onLoad={event => positionChapterCover(event.currentTarget, chapter)}
              onError={() => setCover(null)}
              alt={chapter?.title_chs || chapter?.title_en || '章节主图'}
              className="gw-cover"
              style={{ objectPosition: `${(chapter?.cover_focus?.x ?? .5) * 100}% ${(chapter?.cover_focus?.y ?? .38) * 100}%` }}
            />
          ) : chapter?.type === 'voice' && !loading ? <p className="gw-muted">这位角色暂时没有本地立绘。</p> : null}
          <h2>{chapter?.title_chs || chapter?.title_en}</h2>
          {chapter?.variant_label ? <p className="gw-muted">{chapter.variant_label}</p> : null}
          {loading ? (
            <p className="gw-muted" role="status">
              正在读取任务…
            </p>
          ) : (
            quests.map((item) => (
              <button key={item.id} type="button" className="gw-list-item" onClick={() => selectQuest(item.id)}>
                <div>{item.title_chs || item.title_en}</div>
                <div className="gw-muted">{item.title_en}</div>
              </button>
            ))
          )}
          {!loading && quests.length === 0 ? (
            <p className="gw-muted">本章暂未收录任务文本。</p>
          ) : null}
        </>
      ) : (
        <>
          <div className="gw-actions gw-browse-actions">
            <button
              type="button"
              className="gw-btn gw-btn-ghost"
              onClick={() => {
                setLoading(false);
                setQuestId(null);
              }}
            >
              ← 返回任务
            </button>
            <button
              type="button"
              className="gw-btn"
              disabled={exporting}
              onClick={() =>
                void downloadPdf({
                  scope: 'quest',
                  questId,
                })
              }
            >
              {exporting ? '正在导出…' : '导出本任务 PDF'}
            </button>
          </div>
          <>{cover ? <img key={chapter?.id} src={cover} onLoad={event => positionChapterCover(event.currentTarget, chapter)} onError={() => setCover(null)} alt={chapter?.title_chs || chapter?.title_en || '章节主图'} className="gw-cover" style={{objectPosition:`${(chapter?.cover_focus?.x ?? .5)*100}% ${(chapter?.cover_focus?.y ?? .38)*100}%`}} /> : chapter?.type === 'voice' && !loading ? <p className="gw-muted">这位角色暂时没有本地立绘。</p> : null}</>
          <h2>{quest?.title_chs || quest?.title_en}</h2>
          <p className="gw-muted">
            {chapter?.source_label} · {lines.length} 句台词
          </p>
          <div className="gw-panel">
            {loading ? (
              <p className="gw-muted" role="status">
                正在读取任务文本…
              </p>
            ) : (
              visibleLines.map((line) => (
                <div key={line.id} className={line.id === sourceLineId ? 'gw-line gw-source-line' : 'gw-line'}>
                  <div className="gw-line-row">
                    {isTravelerSpeaker(line.speaker) ? (
                      <img src={traveler.avatar} alt="旅行者头像" className="gw-avatar" data-traveler-avatar={traveler.choice} />
                    ) : line.speaker_image && avatars[line.speaker_image] ? (
                      <img
                        src={avatars[line.speaker_image]}
                        alt=""
                        className="gw-avatar"
                        loading="lazy"
                        onError={() => setAvatars(previous => { const next = {...previous}; if (line.speaker_image) delete next[line.speaker_image]; return next; })}
                      />
                    ) : (
                      <div className="gw-avatar gw-avatar-placeholder" aria-hidden="true">
                        {speakerInitial(line.speaker)}
                      </div>
                    )}
                    <div className="gw-line-content">
                      <div className="gw-speaker">{line.speaker || '旁白'}</div>
                      <div className="gw-dialog-en">
                        {tokenizeClickable(line.text_en, (_word, start, end) => void onWordClick(line.id, start, end))}
                      </div>
                      <div className="gw-muted">{line.text_chs}</div>
                    </div>
                  </div>
                </div>
              ))
            )}
            {!loading && lines.length === 0 ? <p className="gw-muted">此任务暂无台词。</p> : null}
          </div>
          {pages > 1 ? (
            <div className="gw-pagination">
              <button
                type="button"
                className="gw-btn gw-btn-ghost"
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                上一页
              </button>
              <span className="gw-muted">
                {page + 1} / {pages} · {page * pageSize + 1}–
                {Math.min(lines.length, (page + 1) * pageSize)} 句
              </span>
              <button
                type="button"
                className="gw-btn gw-btn-ghost"
                disabled={page + 1 >= pages}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </button>
            </div>
          ) : null}
        </>
      )}
      {toast ? (
        <div className="gw-toast" role="status">
          {toast}
        </div>
      ) : null}
    </section>
  );
}
