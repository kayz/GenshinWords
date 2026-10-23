import type { FormEvent } from 'react';
import { READING_LEVELS, type ReadingUnit } from '../../../shared/reading';
import { annotateReadingParagraphs } from '../../../shared/reading-text';

const practiceLabels: Record<string, string> = {
  reading: '阅读理解', cloze: '完形填空', 'initial-fill': '首字母填空',
  'word-bank': '选词填空', 'sentence-gap': '选句填空', matching: '信息匹配', information: '信息提取',
};
export function readingPracticeLabel(type?: string): string {
  return practiceLabels[type || 'reading'] || '阅读理解';
}

interface Props {
  unit: ReadingUnit; banner: string | null; answers: Record<string, string>;
  locked: boolean; busy: boolean; submitting: boolean; draftStatus: string;
  highlightParagraph: number | null; onAnswer: (id: string, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/** A reading visit contains one passage and one independent answer form. */
export default function ReadingPaperBody({
  unit, banner, answers, locked, busy, submitting, draftStatus, highlightParagraph, onAnswer, onSubmit,
}: Props) {
  const passage = unit.sections?.[0];
  const paragraphIndices = passage?.paragraphIndices || unit.paragraphs.map((_, index) => index + 1);
  const practiceType = unit.practiceType || passage?.type || 'reading';
  const glossary = unit.level === 'entry' || unit.level === 'sh_zhongkao'
    ? (passage?.glossary || unit.glossary).filter(entry => entry.kind === 'word') : [];
  const annotated = annotateReadingParagraphs(paragraphIndices.map(number => unit.paragraphs[number - 1]), glossary);
  const masked = ['cloze', 'initial-fill', 'word-bank', 'sentence-gap'].includes(practiceType);

  function jumpQuestion(number: number) {
    const question = unit.questions[number - 1];
    if (!question) return;
    const target = document.getElementById('reading-q-' + question.id);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target?.querySelector<HTMLElement>('input,select')?.focus({ preventScroll: true });
  }
  function passageText(text: string) {
    if (!masked) return text;
    return text.split(/(\[\d+\])/g).map((part, index) => {
      const match = /^\[(\d+)\]$/.exec(part), number = match ? Number(match[1]) : 0;
      return number > 0 && number <= unit.questions.length
        ? <button key={index} type="button" className="rd-blank-link" aria-label={'填写第 ' + number + ' 题'} onClick={() => jumpQuestion(number)}>{part}</button>
        : part;
    });
  }

  return <>
    <article id="reading-passage" className="rd-paper" aria-labelledby="reading-unit-title">
      {banner ? <img className="rd-banner" src={banner} alt={unit.title + ' · 官方题图'} />
        : <div className="rd-banner rd-banner-empty" role="img" aria-label="故事题图"><span>提瓦特见闻</span></div>}
      <header className="rd-paper-heading">
        <div className="rd-paper-eyebrow rd-reading-meta">
          <span>{READING_LEVELS[unit.level]}</span><span>{readingPracticeLabel(practiceType)}</span>
          <span>{unit.wordCount} 词</span><span>{unit.questionCount} 题</span>
          {unit.estimatedMinutes ? <span>建议 {unit.estimatedMinutes} 分钟</span> : null}
        </div>
        <h2 id="reading-unit-title">{unit.title}</h2>
        {passage?.instructions ? <p className="rd-instructions">{passage.instructions}</p> : null}
      </header>
      {passage?.optionPool?.length ? <div className={'rd-shared-pool ' + (practiceType === 'word-bank' ? 'rd-word-pool' : '')} aria-label="本篇共用选项">
        {passage.optionPool.map(option => <p key={option.id} lang="en"><strong>{option.id}.</strong> {option.text}</p>)}
      </div> : null}
      <div className="rd-prose" lang="en">{paragraphIndices.map((paragraph, localIndex) => {
        const group = passage?.paragraphLabels?.find(item => item.paragraphs.includes(paragraph));
        const label = group ? group.paragraphs[0] === paragraph ? group.label : '' : 'P' + paragraph;
        return <div key={paragraph} id={'reading-p-' + unit.id + '-' + paragraph} tabIndex={-1}
          className={'rd-paragraph ' + (highlightParagraph === paragraph ? 'rd-paragraph-highlight' : '')}>
          <span className="rd-paragraph-number" aria-label={group ? label ? '段落 ' + label : undefined : '第 ' + paragraph + ' 段'}>{label}</span>
          <p>{annotated[localIndex].map((part, index) => <span key={index}>{passageText(part.text)}
            {part.note ? <span lang="zh-CN" className="rd-inline-note">（{part.note}）</span> : null}</span>)}</p>
        </div>;
      })}</div>
      <footer className="rd-paper-source">{passage?.sourceTitle || unit.sourceTitle}<br /><span>{passage?.sourceUrl || unit.sourceUrl}</span></footer>
    </article>
    <form id="reading-questions" className="rd-questions rd-exercise" aria-labelledby="reading-questions-title" onSubmit={onSubmit}>
      <h2 id="reading-questions-title">答题区</h2>
      {unit.questions.map((question, index) => {
        const matching = practiceType === 'matching' || !!question.pooled ||
          question.type === 'choice' && !!question.options?.length && question.options.every(option => /^P[1-9]\d*$/.test(option.id));
        const optionLabel = practiceType === 'matching' ? '请选择对应段落'
          : practiceType === 'word-bank' ? '请选择对应单词'
            : practiceType === 'sentence-gap' ? '请选择对应句子' : '请选择对应选项';
        return <section key={question.id} id={'reading-q-' + question.id} className="gw-panel rd-question">
          <div className="gw-eyebrow">第 {index + 1} 题</div>
          <fieldset disabled={locked || busy}>
            <legend lang="en">{question.prompt}</legend>
            {question.type === 'choice' && matching ? <div className="rd-match">
              <label className="gw-label" htmlFor={'reading-answer-' + question.id}>{optionLabel}</label>
              <select id={'reading-answer-' + question.id} className="gw-select" value={answers[question.id] || ''} onChange={event => onAnswer(question.id, event.target.value)}>
                <option value="">请选择</option>{question.options?.map(option => <option key={option.id} value={option.id}>
                  {practiceType === 'sentence-gap' || option.id === option.text ? option.id : option.id + '. ' + option.text}
                </option>)}
              </select>
            </div> : question.type === 'choice' ? <div className="rd-options">{question.options?.map(option =>
              <label key={option.id} className={'rd-option ' + (answers[question.id] === option.id ? 'rd-option-selected' : '')}>
                <input type="radio" name={question.id} value={option.id} checked={answers[question.id] === option.id} onChange={() => onAnswer(question.id, option.id)} />
                <span className="rd-option-letter">{option.id}.</span><span lang="en">{option.text}</span>
              </label>)}</div> : <div className="rd-fill">
              <label className="gw-label" htmlFor={'reading-answer-' + question.id}>请填写{practiceType === 'information' ? question.wordLimit ? '答案（不超过 ' + question.wordLimit + ' 个词）' : '答案' : question.wordLimit === 1 ? '一个完整单词' : question.wordLimit ? '不超过 ' + question.wordLimit + ' 个英文单词' : '英文答案'}</label>
              <input id={'reading-answer-' + question.id} className="gw-input" value={answers[question.id] || ''} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} maxLength={300} onChange={event => onAnswer(question.id, event.target.value)} />
            </div>}
          </fieldset>
        </section>;
      })}
      {!locked ? <div className="gw-panel rd-paper-submit">
        <button type="submit" className="gw-btn" disabled={busy}>{submitting ? '派蒙在看你的答卷…' : '交卷，看看答得怎么样'}</button>
        <span className="gw-muted" role="status">{draftStatus === 'saving' ? '派蒙在记下你的答案…' : draftStatus === 'saved' ? '答案先帮你记着啦。' : draftStatus === 'error' ? '派蒙还没记好，再试试吧。' : ''}</span>
      </div> : null}
    </form>
  </>;
}
