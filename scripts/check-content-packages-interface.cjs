const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'genshinwords-content-packages-ui-'));
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw Error('--output requires a directory');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'genshinwords-content-packages-results-'));
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^GENSHINWORDS_(?:CONTENT|MEDIA)/i.test(name) || name === 'ELECTRON_RUN_AS_NODE') delete env[name];
}
env.GENSHINWORDS_USER_DATA = profile;
const phases = ['import', 'activate', 'upgrade', 'isolate', 'missing'];
let code = 1;
fs.mkdirSync(output, { recursive: true });
for (const file of ['report.json', 'failure.json', ...phases.map(phase => 'phase-' + phase + '.json')]) {
  const target = path.join(output, file);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}
try {
  for (const phase of phases) {
    process.stdout.write('[content-package-ui] Starting isolated Electron phase: ' + phase + '\n');
    const result = spawnSync(require('electron'), [
      path.resolve(__dirname, '../tests/fixtures/content-package-ui.cjs'), profile, output, phase,
    ], { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 600000, windowsHide: true });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fs.writeFileSync(path.join(output, 'phase-' + phase + '.log'), 'STDOUT\n' + (result.stdout || '') + '\nSTDERR\n' + (result.stderr || '') + '\n', 'utf8');
    if (result.error) console.error(result.error);
    code = result.status ?? 1;
    if (code !== 0) break;
  }
  if (code === 0) {
    const runs = phases.map(phase => JSON.parse(fs.readFileSync(path.join(output, 'phase-' + phase + '.json'), 'utf8')));
    const report = {
      ok: true, actualElectronProcesses: runs.length, isolatedProfile: true,
      backend: 'Actual main-process modules and IPC; compiled renderer and preload; OS file dialog stub only.',
      phases: runs, cases: runs.flatMap(run => run.cases), measurements: runs.flatMap(run => run.measurements),
      screenshots: runs.flatMap(run => run.screenshots), requests: runs.flatMap(run => run.requests),
      errors: runs.flatMap(run => run.errors), minContrast: Math.min(...runs.flatMap(run => run.measurements.map(item => item.minContrast))),
      consoleLogs: phases.map(phase => 'phase-' + phase + '.log'),
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.stdout.write(JSON.stringify({ ok: true, cases: report.cases.length, processes: runs.length,
      screenshots: report.screenshots.length, networkRequests: report.requests.length, output }) + '\n');
  } else if (!fs.existsSync(path.join(output, 'failure.json'))) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ ok: false, exitCode: code, output }, null, 2) + '\n', 'utf8');
  }
} finally {
  const target = path.resolve(profile);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('genshinwords-content-packages-ui-'))
    throw Error('Invalid isolated content package profile');
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
process.exit(code);
