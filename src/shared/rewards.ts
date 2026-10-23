export interface WordRewardEntry {
  id: string; source: 'word'; wordId: number; bookId: string; bookName: string;
  lemma: string; translation: string; earnedAt: string;
}
export interface ReadingRewardEntry {
  id: string; source: 'reading'; unitId: string; questionId: string; attemptId?: string;
  unitTitle: string; questionTitle: string; questionFormat?: string; questionNumber?: number; level: string; earnedAt: string;
}
export type RewardEntry = WordRewardEntry | ReadingRewardEntry;
export interface RewardSummary { total: number; wordTotal: number; readingTotal: number; history: RewardEntry[] }
