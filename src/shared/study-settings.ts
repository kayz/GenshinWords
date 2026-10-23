import type { StudyOrder, StudySize } from './models';

export function normalizeStudyOrder(order: string): StudyOrder {
  return order === 'shuffle' || order === 'by_chapter' ? order : 'default';
}

export function normalizeStudySize(value: unknown): StudySize {
  return value === '20' || value === '50' || value === '100' || value === 'marathon' ? value : '10';
}
export const STUDY_SIZES: StudySize[] = ['10', '20', '50', '100', 'marathon'];
