const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractFile } = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const packScript = path.join(root, 'scripts/pack-assets.mjs');
const samples = { 'audio/word.mp3': Buffer.from([1, 2, 3, 0, 255]), 'images/nested/portrait.png': Buffer.from('fixture image') };

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'genshinwords-blockers-'));
  t.after(() => {
    // 只允许递归清理本测试创建的绝对临时目录。
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('genshinwords-blockers-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return directory;
}
function contentFixture(t) {
  const directory = temporary(t);
  for (const [file, bytes] of Object.entries(samples)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), bytes);
  }
  return directory;
}
function pack(directory, args = [], preload) {
  return spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), packScript, ...args], {
    cwd: root,
    env: { ...process.env, GENSHINWORDS_CONTENT_DIR: directory },
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
}
function sourcesIntact(directory) {
  for (const [file, bytes] of Object.entries(samples)) assert.deepEqual(fs.readFileSync(path.join(directory, file)), bytes);
}
function archiveIntact(directory) {
  const archive = path.join(directory, 'assets.asar');
  for (const [file, bytes] of Object.entries(samples)) assert.deepEqual(extractFile(archive, file.split('/').join(path.sep)), bytes);
}

test('拒绝把归档放进待清理的素材目录，保留源文件', t => {
  const directory = contentFixture(t);
  const output = path.join(directory, 'audio/assets.asar');
  const result = pack(directory, ['--out', output, '--prune']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /不能位于/);
  sourcesIntact(directory);
  assert.equal(fs.existsSync(output), false);
});


test('即使指定 force，也拒绝覆盖素材目录内的源归档', t => {
  const directory = contentFixture(t);
  const output = path.join(directory, 'audio/source.asar');
  const original = Buffer.from('original source bytes');
  fs.writeFileSync(output, original);
  const result = pack(directory, ['--out', output, '--force']);
  assert.equal(result.status, 1, result.stderr);
  sourcesIntact(directory);
  assert.deepEqual(fs.readFileSync(output), original);
});

test('拒绝自定义输出与 prune 组合，避免清理后应用找不到归档', t => {
  const directory = contentFixture(t);
  const result = pack(directory, ['--out', path.join(directory, 'other.asar'), '--prune']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /默认/);
  sourcesIntact(directory);
});

test('解析 junction 后仍然拒绝位于素材目录内的输出', t => {
  const directory = contentFixture(t);
  const alias = path.join(directory, 'alias');
  try { fs.symlinkSync(path.join(directory, 'audio'), alias, 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('当前环境不能创建 junction'); return; }
    throw error;
  }
  const result = pack(directory, ['--out', path.join(alias, 'assets.asar'), '--prune']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /不能位于/);
  sourcesIntact(directory);
});

test('正常归档保持全部字节一致，默认不清理素材', t => {
  const directory = contentFixture(t);
  const result = pack(directory);
  assert.equal(result.status, 0, result.stderr);
  sourcesIntact(directory);
  archiveIntact(directory);
});

test('校验通过后可以清理源目录，完整归档仍然保留', t => {
  const directory = contentFixture(t);
  const result = pack(directory, ['--prune']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(directory, 'audio')), false);
  assert.equal(fs.existsSync(path.join(directory, 'images')), false);
  archiveIntact(directory);
});

test('新归档损坏时保留源文件和旧归档，不执行 force 覆盖或 prune', t => {
  const directory = contentFixture(t);
  assert.equal(pack(directory).status, 0);
  const archive = path.join(directory, 'assets.asar');
  const original = fs.readFileSync(archive);
  const preload = path.join(directory, 'corrupt.cjs');
  fs.writeFileSync(preload, [
    'const fs = require("node:fs");',
    'const asar = require(' + JSON.stringify(require.resolve('@electron/asar')) + ');',
    'const original = asar.createPackageFromFiles;',
    'asar.createPackageFromFiles = async (...args) => { const stream = await original(...args); await require("node:stream/promises").finished(stream); const bytes = fs.readFileSync(args[1]); bytes[bytes.length - 1] ^= 255; fs.writeFileSync(args[1], bytes); return stream; };',
  ].join('\n'), { encoding: 'utf8' });
  const result = pack(directory, ['--force', '--prune'], preload);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /归档内容校验失败/);
  sourcesIntact(directory);
  assert.deepEqual(fs.readFileSync(archive), original);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});

for (const mode of ['missing-directory', 'disk-full', 'source-error', 'render-error', 'success']) {
  test('PDF 导出：' + mode, t => {
    const directory = temporary(t);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/pdf-export.cjs'), mode, directory], {
      cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.kind, mode === 'success' ? 'resolved' : 'rejected');
    if (mode === 'missing-directory') assert.equal(report.code, 'ENOENT');
    if (mode === 'disk-full') assert.equal(report.code, 'ENOSPC');
    if (mode === 'source-error') assert.match(report.message, /simulated PDF source error/);
    if (mode === 'render-error') assert.match(report.message, /simulated image resolver failure/);
    assert.equal(report.destinationDestroyed, true);
    assert.equal(report.destinationClosed, true);
    assert.equal(report.validPdf, true);
    if (mode !== 'success') assert.equal(report.retry.ok, true);
  });
}
