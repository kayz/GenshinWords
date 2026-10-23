import type { PracticeWord } from './practice';
import type { WordRewardEntry } from './rewards';
export type { RewardEntry, RewardSummary } from './rewards';

export type StudyOrder = 'default' | 'shuffle' | 'by_chapter';
export type RatingKey = 'again' | 'hard' | 'good' | 'easy';
export type SettingKey = 'currentBook' | 'studyOrder' | 'traveler' | 'studySize';
export type BrowseKey = 'version' | 'typeFilter';
export interface BookSummary {
  id: string; name: string; name_zh: string; description: string; word_count: number;
  covered?: number; uncovered?: number; coverage_pct?: number;
}
export interface Coverage {
  book_id: string; name_zh: string; total: number; covered: number; uncovered: number; coverage_pct: number;
}
export interface WordSummary extends PracticeWord { phonetic: string; pos: string }
export interface Pronunciation {
  phonetic_uk: string; phonetic_us: string; audio_uk: string | null; audio_us: string | null;
}
export type Word = WordSummary & Pronunciation;
export interface CharacterPortrait { name: string; imagePath: string; traveler?: boolean }
export interface WordExample {
  portrait: CharacterPortrait | null;
  text_en: string; text_chs: string; speaker: string; surface: string;
  image_path: string | null; image_kind: 'portrait' | 'landscape'; source_label: string;
  word_id?: number; line_id?: number; rank?: number; quest_id?: number; chapter_id?: number;
  source_type?: string; chapter_type?: string;
  chapter_variant_label?: string;
  chapter_title_en?: string; chapter_title_chs?: string; quest_title_en?: string; quest_title_chs?: string;
  version?: string; cover_path?: string | null; speaker_image?: string | null;
  speaker_kind?: string; quest_cover?: string | null;
}
export interface WordDetail { word: Word; examples: WordExample[] }
export interface VersionSummary { version: string; chapter_count: number }
export interface SourceSummary { type: string; label: string; chapter_count: number }
export interface Chapter {
  id: number; type: string; source_label: string; version: string; chapter_num: string;
  title_en: string; title_chs: string; cover_path: string | null; sort_order: number;
  original_type?:string; original_version?:string; variant_label?:string; variant_count?:number;
  duplicate_text_count?:number; dialogue_count?:number; cover_match?:string|null; cover_source_url?:string|null; cover_focus?:{x:number;y:number};
}
export interface Quest {
  id: number; chapter_id: number; title_en: string; title_chs: string; sort_order: number; cover_path: string | null;
}
export interface DialogueLine {
  id: number; quest_id: number; speaker: string; text_en: string; text_chs: string; sort_order: number; speaker_image: string | null;
}
export interface StudyStats {
  due: number; newCount: number; learning: number; total: number; pendingSource: number;
  covered: number; uncovered: number; coverage_pct: number;
}
export interface ReviewResult { due: string; state: number; earned: WordRewardEntry[]; duplicate: boolean }
export type PdfRequest = ({ scope: 'chapter'; chapterId: number } | { scope: 'quest'; questId: number }) & { bookId?: string };
export type PdfResult = { ok: true; path: string } | { ok: false; error: string };

export type StudySize = '10' | '20' | '50' | '100' | 'marathon';
export interface StudyBatchRequest { limit: number; order?: StudyOrder; excludeNewIds?: number[]; repeatDue?: boolean; dueOnly?: boolean }
