import type { Api, IpcArgs, IpcChannel, IpcContract, IpcHandlers, IpcInvoke, IpcResult } from '../../src/shared/ipc';
import { apiChannels } from '../../src/shared/ipc';
import type { BookSummary, StudyStats } from '../../src/shared/models';

type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type ContainsAny<T> = IsAny<T> extends true ? true
  : T extends (...args: infer A) => infer R ? true extends ContainsAny<A> | ContainsAny<Awaited<R>> ? true : false
  : T extends readonly unknown[] ? ContainsAny<T[number]>
  : T extends object ? true extends { [K in keyof T]-?: ContainsAny<T[K]> }[keyof T] ? true : false
  : false;
type NoApiAny = Assert<true extends ContainsAny<Api> ? false : true>;
type NoWindowAny = Assert<true extends ContainsAny<Window['api']> ? false : true>;
type NoContractAny = Assert<true extends ContainsAny<IpcContract> ? false : true>;
type AllChannelsExposed = Assert<Exclude<IpcChannel, (typeof apiChannels)[keyof typeof apiChannels]> extends never ? true : false>;

declare const invoke: IpcInvoke;
declare const event: unknown;
declare const main: IpcHandlers<unknown>;

// 这些语句仅参与编译、不执行；错误消失时 @ts-expect-error 自身会导致检查失败。
async function checkRenderer() {
  const books: BookSummary[] = await window.api.listBooks();
  const stats: StudyStats = await window.api.getStats(books[0].id);
  stats.due.toFixed(0);
  window.api.buildSession('book', 10, 40, 'by_chapter');
  window.api.exportPdf({ scope: 'chapter', chapterId: 1 });
  window.api.collectWord({ lineId: 1, start: 0, end: 5 });
  // @ts-expect-error 方法名不能拼错。
  window.api.listBook();
  // @ts-expect-error 必须传词书 ID。
  window.api.getStats();
  // @ts-expect-error 词书 ID 是字符串。
  window.api.getStats(123);
  // @ts-expect-error 单词 ID 是数字。
  window.api.getWord('1');
  // @ts-expect-error 学习顺序必须是允许的值。
  window.api.buildSession('book', 10, 40, 'random');
  // @ts-expect-error 评分名称必须是允许的值。
  window.api.rateReview(1, 'book', 'great');
  // @ts-expect-error chapter 导出必须包含 chapterId。
  window.api.exportPdf({ scope: 'chapter', questId: 1 });
  // @ts-expect-error 收藏必须携带来源范围。
  window.api.collectWord({ lineId: 1 });
  // @ts-expect-error 答案是文本。
  window.api.submitExercise('exercise', { blank: 42 });
  // @ts-expect-error 设置名称不能拼错。
  window.api.getSetting('currntBook');
  // @ts-expect-error 返回字段不能拼错。
  stats.duee;
  // @ts-expect-error 返回字段不能当作另一种类型。
  const due: string = stats.due;
  const word = await window.api.getWord(1);
  // @ts-expect-error 找不到单词时必须处理 null。
  word.word.lemma;
  const result = await window.api.exportPdf({ scope: 'quest', questId: 1 });
  // @ts-expect-error 失败结果不能直接读取成功路径。
  result.path;
  if (result.ok) result.path.toUpperCase();
  else result.error.toUpperCase();
}
// @ts-expect-error 未注册的通道不允许调用。
invoke('books:lis');
// @ts-expect-error IPC 传输参数同样受约束。
invoke('word:get', '1');
// @ts-expect-error 主进程的调用参数同样受约束。
main['word:get'](event, '1');
// @ts-expect-error 主进程处理函数必须返回正确结构。
const wrongResult: IpcHandlers<unknown>['stats:get'] = () => ({ due: 'later' });
// @ts-expect-error 主进程处理函数不能接受错误类型的参数。
const wrongParameter: IpcHandlers<unknown>['word:get'] = (_e, id: string) => null;
// @ts-expect-error 主进程不能遗漏通道。
const incomplete: IpcHandlers<unknown> = {};
// @ts-expect-error 参数元组不能放宽为任意值。
const badArgs: IpcArgs<'word:get'> = ['1'];
// @ts-expect-error 返回值定义不能放宽为 any。
const badResult: IpcResult<'word:lookup'> = 1;

// 阅读与全局奖励同样保留精确参数和返回结构。
window.api.getRewards().then(summary => summary.wordTotal.toFixed());
window.api.listReadingUnits('sh_zhongkao');
window.api.buildExercise('book', 1, 'meaning');
// @ts-expect-error 新奖励接口不再按词书计算总数。
window.api.getRewards('book');
// @ts-expect-error 训练级别必须来自枚举。
window.api.listReadingUnits('ielts');
// @ts-expect-error 阅读提交必须携带请求编号。
window.api.submitReadingPaper('attempt', { question: 'A' });
// @ts-expect-error 自测方式必须是已支持的模式。
window.api.buildExercise('book', 1, 'random');

window.api.setSetting('traveler', 'aether');
window.api.submitReadingPaper('attempt', { question: 'A' }, 'request');
window.api.saveReadingDraft('attempt', { question: 'A' });
window.api.collectReadingWord({ attemptId: 'attempt', paragraph: 1, start: 0, end: 5 });
// @ts-expect-error 已撤出逐题判分接口。
window.api.submitReadingAnswer('attempt', 'question', 'A', 'request');
// @ts-expect-error 阅读收藏必须携带轮次与原文范围。
window.api.collectReadingWord({ unitId: 'unit', word: 'free' });
// @ts-expect-error 阅读答案必须是文本。
window.api.submitReadingPaper('attempt', { question: 1 }, 'request');

window.api.nextStudyBatch('book', {limit:20,repeatDue:true,excludeNewIds:[1,2]});
// @ts-expect-error 学习批次不接受字符串数量
window.api.nextStudyBatch('book', {limit:'20'});
// @ts-expect-error 批次返回单词ID，不能作为字符串列表
const badStudyBatch: Promise<string[]> = window.api.nextStudyBatch('book', {limit:10});

window.api.resolveReadingLocation('old-unit', {questionId: 'question', paragraph: 1}).then(location => location.unitId.toUpperCase());
// @ts-expect-error 来源段号必须是数字。
window.api.resolveReadingLocation('old-unit', {paragraph: '1'});
// @ts-expect-error 定位返回的单元ID不是数字。
const invalidReadingLocation: Promise<number> = window.api.resolveReadingLocation('unit');

// 阅读包入口保持精确参数、预览可取消和导入动作枚举。
window.api.listReadingPackages().then(packages => packages.forEach(item => item.version.toUpperCase()));
window.api.previewReadingPackageImport().then(preview => { if (preview) preview.package.unitCount.toFixed(); });
window.api.importReadingPackage('preview-token').then(result => result.package.name.toUpperCase());
// @ts-expect-error 导入只接受主进程预览令牌。
window.api.importReadingPackage(42);
// @ts-expect-error 选择文件由主进程对话框完成，不接收渲染进程路径。
window.api.previewReadingPackageImport('C:/fake.gwreading');
// @ts-expect-error 导入结果不是任意对象。
window.api.importReadingPackage('token').then(result => result.unknownField);
// @ts-expect-error 预览可能取消，必须检查null。
window.api.previewReadingPackageImport().then(preview => preview.package.name);

window.api.getReadingUnit('unit', false, 'historical-attempt');
window.api.resolveReadingLocation('unit', {attemptId:'historical-attempt',paragraph:1});
// @ts-expect-error 历史来源轮次必须是字符串。
window.api.getReadingUnit('unit',false,{attemptId:42});

window.api.listContentPackages().then(packages => packages.forEach(item => item.version.toUpperCase()));
window.api.previewContentPackageImport().then(preview => { if (preview) preview.warnings.forEach(warning => warning.toUpperCase()); });
window.api.importContentPackage('preview-token').then(result => { const pending: boolean = result.restartRequired; return pending; });
// @ts-expect-error 内容包同样只接受预览令牌。
window.api.importContentPackage({ file: 'C:/untrusted.gwcontent' });
// @ts-expect-error 文件路径不向renderer开放。
window.api.previewContentPackageImport('C:/untrusted.gwwords');

// Resource directories are selected in the main process; renderer only submits a token.
void window.api.getResourceDirectories();
void window.api.previewResourceDirectory();
void window.api.rescanResourceDirectory();
void window.api.loadResourceDirectory('checked-directory-token');
// @ts-expect-error No renderer-controlled directory path may be passed to the native picker.
void window.api.previewResourceDirectory('C:/untrusted');
// @ts-expect-error A checked token is a string, not an object carrying arbitrary paths.
void window.api.loadResourceDirectory({ path: 'C:/untrusted' });

window.api.getResourceDirectories().then(status => { if (status.raw) status.raw.wordCount.toFixed(); });
// @ts-expect-error Directory picker can be cancelled.
window.api.previewResourceDirectory().then(preview => preview.canLoad);
// @ts-expect-error Counts keep their numeric result type across IPC.
window.api.loadResourceDirectory('token').then(result => { const bad: string = result.loadedCount; return bad; });
