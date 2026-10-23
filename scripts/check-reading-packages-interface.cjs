const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'genshinwords-reading-packages-ui-'));
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw Error('--output requires a directory');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'genshinwords-reading-packages-results-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let code = 1;
try {
  const result = spawnSync(require('electron'), [
    path.resolve(__dirname, '../tests/fixtures/reading-package-ui.cjs'), directory, output,
  ], { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 360000, windowsHide: true });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error);
  code = result.status ?? 1;
} finally {
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('genshinwords-reading-packages-ui-'))
    throw Error('Invalid isolated reading package profile');
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(code);
