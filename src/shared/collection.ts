import type { PracticeSource } from './practice';
import type { Word, WordSummary } from './models';

export const COLLECTION_ID = '__collection__';
export type CollectRequest = { lineId: number; start: number; end: number };
export type CollectReadingRequest = { attemptId: string; paragraph: number; start: number; end: number };
export interface DialogueCollectedSource extends PracticeSource {
  origin?: 'dialogue';
  kind: 'collection';
  lineId: number;
  questId: number;
  chapterId: number;
  textChs: string;
  surface: string;
  collectedAt: string;
}
export interface ReadingCollectedSource extends PracticeSource {
  kind: 'collection'; origin: 'reading'; unitId: string; paragraph: number; attemptId?: string;
  textChs: string; surface: string; collectedAt: string;
}
export type CollectedSource = DialogueCollectedSource | ReadingCollectedSource;
export interface CollectionEntry {
  word: Word;
  createdAt: string;
  source: CollectedSource | null;
  reviewed: boolean;
  due: string | null;
}

export interface CollectResult { word: WordSummary; status: 'added' | 'existing' | 'restored' | 'source-added' }
