import type { ReadingPaperDefinition, PaperPassageType } from './reading-paper-types';
import type { ReadingLevel, ReadingQuestion, ReadingGloss, ReadingAnalysis, ReadingExplanation } from '../shared/reading';

export interface BankQuestion extends ReadingQuestion {
  expected: string; accepted?: string[]; solution: ReadingExplanation;
}
export interface ReadingDefinition {
  practiceType?: PaperPassageType;
  paper?: ReadingPaperDefinition; kind?: 'single' | 'paper'; estimatedMinutes?: number;
  id: string; title: string; level: ReadingLevel; background: string; materialId: string;
  textSha256: string; chsTextSha256: string; bilingualAlignmentVerified: true;
  wordCount: number; paragraphCount: number; sourceTitle: string; sourceUrl: string;
  coverPath: string; coverFocus: { x: number; y: number }; glossary: ReadingGloss[];
  questions: BankQuestion[]; analysisGlossary?: ReadingGloss[];
  analysis: Omit<ReadingAnalysis, 'glossary' | 'questions' | 'bilingualParagraphs'>;
}
