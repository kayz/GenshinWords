import type { ReadingLevel, ReadingGloss, ReadingAnalysis } from '../shared/reading';
import type { BankQuestion } from './reading-bank-types';

/** All paragraph numbers are ONE-BASED original texts.paragraphs_json order + 1. */
export interface PaperParagraphPair { en: number; chs: number[] }
export interface PaperMask {
  paragraph: number;
  /** UTF-16 offsets into that exact original EN paragraph: text.slice(start,end). */
  start: number; end: number; questionId: string;
  /** Required audit value; runtime checks it before hiding the original span. */
  expectedText: string;
}
export type PaperPassageType = 'reading' | 'cloze' | 'initial-fill' | 'word-bank' | 'sentence-gap' | 'matching' | 'information';
export interface PaperPassageDefinition {
  id: string; title: string; type: PaperPassageType; instructions: string;
  materialId: string; textSha256: string; chsTextSha256: string;
  bilingualAlignmentVerified: true;
  /** Select complete source rows in source order; one EN row may map to several CHS rows. */
  paragraphMap: PaperParagraphPair[];
  coverPath: string; coverFocus: { x: number; y: number };
  sourceTitle: string; sourceUrl: string;
  questions: BankQuestion[];
  glossary: ReadingGloss[]; analysisGlossary?: ReadingGloss[];
  analysis: Omit<ReadingAnalysis, 'questions' | 'glossary' | 'bilingualParagraphs'>;
  masks?: PaperMask[];
  /** Shared A-O words or A-F sentences. Choice questions inherit this pool when options omitted. */
  optionPool?: Array<{ id: string; text: string }>;
  /** Natural sections A-J. paragraphs uses original EN row numbers, not display indices. */
  paragraphLabels?: Array<{ label: string; paragraphs: number[] }>;
}
export interface ReadingPaperDefinition {
  id: string; title: string; level: ReadingLevel; background: string;
  estimatedMinutes: number; passages: PaperPassageDefinition[];
}

// Authors publish JSON units; legacy groups only preserve historical links.
// Stable question IDs are globally meaningful: reusing a question must reuse its ID.
// Question solution.evidence / analysis structure/sentences refer to ORIGINAL EN row numbers.
// For pool/matching: type:'choice', expected:'A', options may be inherited from optionPool.
// For initial-fill: type:'fill', expected:'word', firstLetter:'w', mask full original word.
// Sentence masks hide complete original sentences; pool includes exact originals plus distractors.
// Do not copy the unmasked text into prompts/instructions/options except the intended option pool.

/** A new reading is authored and published independently; no paper container is required. */
export interface IndependentReadingDefinition extends PaperPassageDefinition {
  level: ReadingLevel; estimatedMinutes?: number;
}
