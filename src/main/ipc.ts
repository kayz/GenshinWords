import { getResourceDirectoryStatus, previewResourceDirectory, scanConfiguredResourceDirectory, loadResourceDirectory } from './resource-directories';
import { listManagedContentPackages, previewManagedContentPackage, importManagedContentPackage } from './content-management';
import { ipcMain, BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';
import type { IpcHandlers, IpcChannel } from '../shared/ipc';
import type { RatingKey } from '../shared/models';
import {
  contentAvailable,
  listBooks,
  listCoverage,
  listVersions,
  listSourceTypes,
  listChapters,
  getChapter,
  listQuests,
  listDialogLines,
  lookupWordByLemma,
  getWord,
  getWordExamples,
  getPronunciation,
} from './content-db';
import {
  getSetting,
  setSetting,
  getBrowseProgress,
  setBrowseProgress,
} from './progress-db';
import {
  buildSession,
  buildStudyBatch,
  reviewCard,
  getStats,
  getStudyOrder,
  normalizeStudyOrder,
} from './study';
import { buildExercise, submitExercise } from './exercise';
import { getRewards } from './rewards';
import { listReadingUnits, getReadingUnit, submitReadingPaper, saveReadingDraft, acknowledgeReadingReward, getReadingAnalysis } from './reading';
import { getReadingBanner } from './reading-artwork';
import { listReadingPackages, previewReadingPackageFile, importReadingPackage } from './reading-package-store';
import { resolveReadingLocation } from './reading-location';
import { exportReadingPdf } from './reading-pdf';
import { collectFromReading } from './reading-collection';
import { assetDataUrl } from './assets';
import { exportDialoguePdf } from './pdf';
import { Rating, type Grade } from 'ts-fsrs';
import { COLLECTION_ID } from '../shared/collection';
import { normalizeStudySize } from '../shared/study-settings';
import { normalizeTraveler } from '../shared/traveler';
import { collectFromDialogue, listCollection, removeCollectedWord, restoreCollectedWord, getCollectionReview } from './collections';


export const RATING_MAP: Record<RatingKey, Grade> = {
  again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy,
};

// 完整映射检查通道是否缺失、参数是否一致、处理函数是否返回正确结构。
export const handlers: IpcHandlers<IpcMainInvokeEvent> = {
  'resourceDirectories:get': () => getResourceDirectoryStatus(),
  'resourceDirectories:preview': async event => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { title: '选择资源目录', buttonLabel: '检查资源目录', properties: ['openDirectory'] as Array<'openDirectory'> };
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return selected.canceled || !selected.filePaths[0] ? null : previewResourceDirectory(selected.filePaths[0]);
  },
  'resourceDirectories:rescan': () => scanConfiguredResourceDirectory(),
  'resourceDirectories:load': (_event, token) => loadResourceDirectory(token),
  'content:available': () => contentAvailable(),
  'contentPackages:list': () => listManagedContentPackages(),
  'contentPackages:previewImport': async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { title: '导入内容包', buttonLabel: '检查内容包',
      filters: [{ name: 'GenshinWords 内容包', extensions: ['gwcontent', 'gwwords', 'gwreading'] }],
      properties: ['openFile'] as Array<'openFile'> };
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return selected.canceled || !selected.filePaths[0] ? null : previewManagedContentPackage(selected.filePaths[0]);
  },
  'contentPackages:import': (_e, token) => importManagedContentPackage(token),
  'books:list': () => listBooks(),
  'coverage:list': () => listCoverage(),
  'settings:get': (_e, key, fallback) => key === 'studyOrder' ? getStudyOrder() : key === 'studySize' ? normalizeStudySize(getSetting(key, '10')) : getSetting(key, fallback ?? ''),
  'settings:set': (_e, key, value) => {
    if (key === 'traveler' && !normalizeTraveler(value)) throw new Error('先选空或者荧，派蒙再帮你记下来。');
    if (key === 'studySize' && !['10','20','50','100','marathon'].includes(value)) throw new Error('请选择本轮学习数量。');
    setSetting(key, key === 'studyOrder' ? normalizeStudyOrder(value) : value);
    return true;
  },
  'stats:get': (_e, bookId) => getStats(bookId),
  'session:build': (_e, bookId, newLimit, dueLimit, order) =>
    buildSession(bookId, newLimit ?? 10, dueLimit ?? 40, order === undefined ? getStudyOrder() : normalizeStudyOrder(order)),
  'session:next': (_e, bookId, request) => buildStudyBatch(bookId, { ...request, order: request?.order ?? getStudyOrder() }),
  'word:get': (_e, wordId, scope) => {
    const word = getWord(wordId);
    if (!word) return null;
    return { word, examples: scope === COLLECTION_ID ? getCollectionReview(wordId) : getWordExamples(wordId, 5) };
  },
  'word:pronunciation': (_e, wordId) => getPronunciation(wordId),
  'exercise:build': (_e, bookId, wordId, mode) => buildExercise(bookId, wordId, mode),
  'exercise:submit': (_e, id, answers) => submitExercise(id, answers),
  'rewards:get': () => getRewards(),
  'reading:list': (_e, level) => listReadingUnits(level),
  'reading:get': (_e, unitId, startNew, attemptId) => getReadingUnit(unitId, startNew, attemptId),
  'reading:resolveLocation': (_e, unitId, location) => resolveReadingLocation(unitId, location),
  'reading:submit': (_e, attemptId, answers, requestId) => submitReadingPaper(attemptId, answers, requestId),
  'reading:draft': (_e, attemptId, answers) => saveReadingDraft(attemptId, answers),
  'reading:rewardAck': (_e, attemptId) => acknowledgeReadingReward(attemptId),
  'reading:collect': (_e, request) => collectFromReading(request),
  'reading:analysis': (_e, attemptId) => getReadingAnalysis(attemptId),
  'reading:banner': (_e, unitId, passageId, attemptId) => getReadingBanner(unitId, passageId, attemptId),
  'readingPackages:list': () => listReadingPackages(),
  'readingPackages:previewImport': async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: '导入阅读包', buttonLabel: '检查阅读包',
      filters: [{ name: 'GenshinWords 阅读包', extensions: ['gwreading'] }],
      properties: ['openFile'] as Array<'openFile'>,
    };
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    if (!selected.filePaths[0].toLowerCase().endsWith('.gwreading')) throw new Error('请选择 .gwreading 格式的阅读包。');
    return previewReadingPackageFile(selected.filePaths[0]);
  },
  'readingPackages:import': (_e, token) => importReadingPackage(token),
  'reading:pdf': async (event, unitId, attemptId) => {
    try { return await exportReadingPdf(BrowserWindow.fromWebContents(event.sender), unitId, attemptId); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : '导出失败' }; }
  },
  'review:rate': (_e, wordId, bookId, ratingKey, requestId) => {
    const rating = RATING_MAP[ratingKey];
    if (!rating) throw new Error('Invalid rating: ' + ratingKey);
    return reviewCard(wordId, bookId, rating, requestId);
  },
  'versions:list': () => listVersions(),
  'sources:list': () => listSourceTypes(),
  'chapters:list': (_e, version, typeFilter) => listChapters(version, typeFilter),
  'chapter:get': (_e, chapterId) => getChapter(chapterId) ?? null,
  'quests:list': (_e, chapterId) => listQuests(chapterId),
  'dialog:list': (_e, questId) => listDialogLines(questId),
  'pdf:export': async (event, request) => {
    try { return await exportDialoguePdf(BrowserWindow.fromWebContents(event.sender), request); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : '导出失败' }; }
  },
  'word:lookup': (_e, lemma) => lookupWordByLemma(lemma) ?? null,
  'collection:add': (_e, request) => collectFromDialogue(request),
  'collection:list': () => listCollection(),
  'collection:remove': (_e, wordId) => removeCollectedWord(wordId),
  'collection:restore': (_e, wordId) => restoreCollectedWord(wordId),
  'browse:getProgress': (_e, key) => getBrowseProgress(key),
  'browse:setProgress': (_e, key, value) => { setBrowseProgress(key, value); return true; },
  'image:dataUrl': (_e, relativePath) => assetDataUrl(relativePath),
  'audio:dataUrl': (_e, relativePath) => assetDataUrl(relativePath, true),
};
export function registerIpc() {
  for (const channel of Object.keys(handlers) as IpcChannel[]) ipcMain.handle(channel, handlers[channel]);
}
