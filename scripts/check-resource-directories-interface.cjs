const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'genshinwords-resource-directories-ui-'));
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw Error('--output requires a directory');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'genshinwords-resource-directories-results-'));
const phases = ['selection', 'restart', 'disconnected', 'restored'];
const env = { ...process.env, GENSHINWORDS_USER_DATA: profile };
for (const key of Object.keys(env)) if (key === 'ELECTRON_RUN_AS_NODE' || /^GENSHINWORDS_(?:CONTENT|MEDIA|READING_PACKAGES)/i.test(key)) delete env[key];
fs.mkdirSync(output, { recursive: true });
for (const name of ['report.json', 'failure.json', ...phases.map(phase => 'phase-' + phase + '.json')]) {
  const file = path.join(output, name); if (fs.existsSync(file)) fs.unlinkSync(file);
}
let code = 1;
try {
  for (const phase of phases) {
    console.log('[resource-directory-ui] Starting isolated Electron: ' + phase);
    const result = spawnSync(require('electron'), [path.resolve(__dirname, '../tests/fixtures/resource-directory-ui.cjs'), profile, output, phase],
      { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', windowsHide: true, timeout: 600000 });
    fs.writeFileSync(path.join(output, 'phase-' + phase + '.log'), 'STDOUT\n' + (result.stdout || '') + '\nSTDERR\n' + (result.stderr || ''), 'utf8');
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    if (result.error) console.error(result.error);
    code = result.status ?? 1; if (code !== 0) break;
  }
  if (code === 0) {
    const runs = phases.map(phase => JSON.parse(fs.readFileSync(path.join(output, 'phase-' + phase + '.json'), 'utf8')));
    const report = { ok: true, profileIsolation: true, actualElectronProcesses: runs.length,
      backend: 'Actual IPC and main modules; compiled renderer/preload; native directory picker stub only; small synthetic RAW databases and self-contained example packages.',
      phases: runs, cases: runs.flatMap(run => run.cases), screenshots: runs.flatMap(run => run.screenshots), measurements: runs.flatMap(run => run.measurements),
      requests: runs.flatMap(run => run.requests), errors: runs.flatMap(run => run.errors),
      minContrast: Math.min(...runs.flatMap(run => run.measurements.map(item => item.minContrast))) };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ ok: true, cases: report.cases.length, measurements: report.measurements.length, screenshots: report.screenshots.length, requests: report.requests.length, output }));
  } else if (!fs.existsSync(path.join(output, 'failure.json'))) fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ ok: false, exitCode: code }, null, 2) + '\n', 'utf8');
} finally {
  if (path.dirname(path.resolve(profile)) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('genshinwords-resource-directories-ui-')) throw Error('Unsafe audit profile cleanup');
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
process.exit(code);
