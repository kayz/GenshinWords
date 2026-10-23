const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'genshinwords-reading-ui-'));
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.join(directory, 'screenshots');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let code = 1;
try {
  const result = spawnSync(require('electron'), [path.resolve(__dirname, '../tests/fixtures/reading-ui.cjs'), directory, output], {
    cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 480000, windowsHide: true,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error);
  code = result.status ?? 1;
} finally {
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('genshinwords-reading-ui-')) throw Error('Invalid temporary directory');
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(code);
