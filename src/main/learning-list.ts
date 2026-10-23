import type { WordSummary, StudyOrder } from '../shared/models';
import { getBookWords, getWord, isBookWord, listBooks, shuffleIds } from './content-db';
import { listCollection } from './collections';
import { openProgressDb } from './progress-db';
import { COLLECTION_ID } from '../shared/collection';

/** 收藏词表与考试词书独立，绝不把收藏并入考试词书。 */
export function getLearningWords(bookId: string, order: StudyOrder = 'default'): WordSummary[] {
  if (bookId === COLLECTION_ID) {
    const words = listCollection().map(entry => entry.word);
    return order === 'shuffle' ? shuffleIds(words) : words;
  }
  return listBooks().some(book => book.id === bookId) ? getBookWords(bookId, order) : [];
}
export function isLearningWord(wordId: number, bookId: string) {
  if (!getWord(wordId)) return false;
  if (bookId === COLLECTION_ID) return Boolean(openProgressDb()
    .prepare('SELECT 1 FROM collected_words WHERE word_id=? AND active=1').get(wordId));
  return listBooks().some(book => book.id === bookId) && isBookWord(wordId, bookId);
}
