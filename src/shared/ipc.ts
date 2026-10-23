import type { ResourceDirectoryStatus, ResourceDirectoryPreview, ResourceDirectoryLoadResult } from './resource-directory';
import type { ContentPackageInfo, ContentPackagePreview, ContentPackageImportResult } from './content-package';
import type {
  BookSummary, Coverage, WordSummary, WordDetail, Pronunciation, StudyStats, RewardSummary, ReviewResult,
  VersionSummary, SourceSummary, Chapter, Quest, DialogueLine, StudyOrder, StudyBatchRequest, RatingKey, SettingKey, BrowseKey, PdfRequest, PdfResult,
} from './models';
import type { CollectRequest, CollectReadingRequest, CollectResult, CollectionEntry } from './collection';
import type { StudyExercise, ExerciseResult, SelfTestMode } from './practice';
import type { ReadingLevel, ReadingUnitSummary, ReadingUnit, ReadingPaperResult, ReadingAnalysis, ReadingLocation, ReadingLocationRequest } from './reading';
import type { ReadingPackageInfo, ReadingPackagePreview, ReadingPackageImportResult } from './reading-package-management';

type Call<Args extends unknown[], Result> = { args: Args; result: Result };
/** 主进程、preload 和页面端共用的通道、参数及返回值定义。 */
export interface IpcContract {
  'resourceDirectories:get': Call<[], ResourceDirectoryStatus>;
  'resourceDirectories:preview': Call<[], ResourceDirectoryPreview | null>;
  'resourceDirectories:rescan': Call<[], ResourceDirectoryPreview | null>;
  'resourceDirectories:load': Call<[token: string], ResourceDirectoryLoadResult>;
  'content:available': Call<[], boolean>;
  'contentPackages:list': Call<[], ContentPackageInfo[]>;
  'contentPackages:previewImport': Call<[], ContentPackagePreview | null>;
  'contentPackages:import': Call<[token: string], ContentPackageImportResult>;
  'books:list': Call<[], BookSummary[]>;
  'coverage:list': Call<[], Coverage[]>;
  'settings:get': Call<[key: SettingKey, fallback?: string], string>;
  'settings:set': Call<[key: SettingKey, value: string], boolean>;
  'stats:get': Call<[bookId: string], StudyStats>;
  'session:build': Call<[bookId: string, newLimit?: number, dueLimit?: number, order?: StudyOrder], number[]>;
  'session:next': Call<[bookId: string, request: StudyBatchRequest], number[]>;
  'word:get': Call<[wordId: number, scope?: string], WordDetail | null>;
  'word:pronunciation': Call<[wordId: number], Pronunciation>;
  'review:rate': Call<[wordId: number, bookId: string, rating: RatingKey, requestId?: string], ReviewResult>;
  'versions:list': Call<[], VersionSummary[]>;
  'sources:list': Call<[], SourceSummary[]>;
  'chapters:list': Call<[version?: string, typeFilter?: string], Chapter[]>;
  'chapter:get': Call<[chapterId: number], Chapter | null>;
  'quests:list': Call<[chapterId: number], Quest[]>;
  'dialog:list': Call<[questId: number], DialogueLine[]>;
  'pdf:export': Call<[request: PdfRequest], PdfResult>;
  'word:lookup': Call<[lemma: string], WordSummary | null>;
  'collection:add': Call<[request: CollectRequest], CollectResult>;
  'collection:list': Call<[], CollectionEntry[]>;
  'collection:remove': Call<[wordId: number], boolean>;
  'collection:restore': Call<[wordId: number], boolean>;
  'browse:getProgress': Call<[key: BrowseKey], string>;
  'browse:setProgress': Call<[key: BrowseKey, value: string], boolean>;
  'image:dataUrl': Call<[relativePath: string], string | null>;
  'audio:dataUrl': Call<[relativePath: string], string | null>;
  'exercise:build': Call<[bookId: string, wordId?: number, mode?: SelfTestMode], StudyExercise | null>;
  'exercise:submit': Call<[exerciseId: string, answers: Record<string, string>], ExerciseResult>;
  'rewards:get': Call<[], RewardSummary>;
  'reading:list': Call<[level?: ReadingLevel], ReadingUnitSummary[]>;
  'reading:get': Call<[unitId: string, startNew?: boolean, attemptId?: string], ReadingUnit>;
  'reading:resolveLocation': Call<[unitId: string, location?: ReadingLocationRequest], ReadingLocation>;
  'reading:submit': Call<[attemptId: string, answers: Record<string, string>, requestId: string], ReadingPaperResult>;
  'reading:draft': Call<[attemptId: string, answers: Record<string, string>], boolean>;
  'reading:rewardAck': Call<[attemptId: string], boolean>;
  'reading:collect': Call<[request: CollectReadingRequest], CollectResult>;
  'reading:analysis': Call<[attemptId: string], ReadingAnalysis>;
  'reading:banner': Call<[unitId: string, passageId?: string, attemptId?: string], string | null>;
  'reading:pdf': Call<[unitId: string, attemptId: string], PdfResult>;
  'readingPackages:list': Call<[], ReadingPackageInfo[]>;
  'readingPackages:previewImport': Call<[], ReadingPackagePreview | null>;
  'readingPackages:import': Call<[token: string], ReadingPackageImportResult>;
}
export type IpcChannel = keyof IpcContract;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args'];
export type IpcResult<C extends IpcChannel> = IpcContract[C]['result'];
export type IpcHandlers<Event> = { [C in IpcChannel]: (event: Event, ...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>> };
export type IpcInvoke = <C extends IpcChannel>(channel: C, ...args: IpcArgs<C>) => Promise<IpcResult<C>>;

export const apiChannels = {
  getResourceDirectories: 'resourceDirectories:get', previewResourceDirectory: 'resourceDirectories:preview',
  rescanResourceDirectory: 'resourceDirectories:rescan', loadResourceDirectory: 'resourceDirectories:load',
  listContentPackages: 'contentPackages:list', previewContentPackageImport: 'contentPackages:previewImport', importContentPackage: 'contentPackages:import',
  contentAvailable: 'content:available', listBooks: 'books:list', listCoverage: 'coverage:list',
  getSetting: 'settings:get', setSetting: 'settings:set', getStats: 'stats:get', buildSession: 'session:build', nextStudyBatch: 'session:next',
  getWord: 'word:get', getPronunciation: 'word:pronunciation', rateReview: 'review:rate',
  listVersions: 'versions:list', listSources: 'sources:list', listChapters: 'chapters:list',
  getChapter: 'chapter:get', listQuests: 'quests:list', listDialog: 'dialog:list', exportPdf: 'pdf:export',
  lookupWord: 'word:lookup', collectWord: 'collection:add', listCollection: 'collection:list',
  removeCollectedWord: 'collection:remove', restoreCollectedWord: 'collection:restore',
  getBrowseProgress: 'browse:getProgress', setBrowseProgress: 'browse:setProgress',
  imageDataUrl: 'image:dataUrl', audioDataUrl: 'audio:dataUrl', buildExercise: 'exercise:build',
  submitExercise: 'exercise:submit', getRewards: 'rewards:get',
  listReadingUnits: 'reading:list', getReadingUnit: 'reading:get', resolveReadingLocation: 'reading:resolveLocation', submitReadingPaper: 'reading:submit', saveReadingDraft: 'reading:draft',
  acknowledgeReadingReward: 'reading:rewardAck', collectReadingWord: 'reading:collect',
  getReadingAnalysis: 'reading:analysis', getReadingBanner: 'reading:banner', exportReadingPdf: 'reading:pdf',
  listReadingPackages: 'readingPackages:list', previewReadingPackageImport: 'readingPackages:previewImport',
  importReadingPackage: 'readingPackages:import',
} as const satisfies Record<string, IpcChannel>;
export type Api = { [Name in keyof typeof apiChannels]:
  (...args: IpcArgs<(typeof apiChannels)[Name]>) => Promise<IpcResult<(typeof apiChannels)[Name]>> };

/** 唯一的动态映射边界；每个方法只转发到上表指定的通道。 */
export function createApi(invoke: IpcInvoke): Api {
  const entries = Object.entries(apiChannels).map(([name, channel]) => [
    name, (...args: IpcArgs<typeof channel>) => invoke(channel, ...args),
  ]);
  return Object.fromEntries(entries) as Api;
}
