// Verifies the packaged EXE consumes a real NSIS selection in an isolated profile.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const stage = path.resolve(process.argv[2] || '');
const exe = path.resolve(process.argv[3] || '');
assert.equal(path.basename(stage), 'harness', 'Use a dedicated installer audit folder');
assert.equal(path.basename(path.dirname(stage)), 'installer-base-selection', 'Use an isolated task folder');
assert.equal(path.basename(exe), 'GenshinWords.exe');
const marker = path.join(stage, 'cache', 'installer-base-selection.ini');
assert.ok(fs.existsSync(marker), 'NSIS must provide a selection before the EXE starts');
const profile = path.join(stage, 'profile');
const fallback = path.join(stage, 'empty-app-content');
const cwd = path.join(stage, 'empty-cwd');
for (const directory of [profile, fallback, cwd]) fs.mkdirSync(directory, { recursive: true });

let processHandle, exit, socket, startupLog = '';
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function target(port) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    if (exit) throw Error('EXE exited before the learning UI: ' + JSON.stringify(exit));
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then(result => result.json());
      const page = pages.find(item => item.type === 'page' && item.url.startsWith('file:') && item.url.includes('index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* The browser may be validating the selected package. */ }
    await delay(200);
  }
  throw Error('Packaged app never opened the learning UI. Startup log: ' + startupLog.slice(-8000));
}
async function evaluate(url, expression) {
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('CDP response timeout')), 30000);
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.error || message.result?.exceptionDetails) reject(Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      else resolve(message.result.result.value);
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
async function main() {
  const port = await freePort();
  const env = { ...process.env, GENSHINWORDS_USER_DATA: profile,
    GENSHINWORDS_CONTENT_PACKAGES_DIR: path.join(stage, 'cache', 'content-packages'),
    GENSHINWORDS_CONTENT_DIR: fallback };
  for (const key of Object.keys(env)) if (key === 'ELECTRON_RUN_AS_NODE' || /^GENSHINWORDS_(?:MEDIA|READING_PACKAGES)/.test(key) || /^path$/i.test(key)) delete env[key];
  env.Path = `${process.env.SystemRoot || 'C:\\Windows'};${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')}`;
  processHandle = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1', '--no-proxy-server'],
    { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processHandle.stderr.on('data', value => { startupLog = (startupLog + value.toString()).slice(-16000); });
  processHandle.on('exit', (code, signal) => { exit = { code, signal }; });
  const page = await target(port);
  const state = await evaluate(page.webSocketDebuggerUrl, `(async()=>{const p=await window.api.listContentPackages();const b=await window.api.listBooks();return {base:p.find(x=>x.kind==='base'&&x.status==='active'),books:b.map(x=>x.id),title:document.title,body:document.body.innerText.slice(0,300)}})()`);
  assert.equal(state.base?.id, 'synthetic.installer.base');
  assert.ok(state.books.includes('test'));
  assert.equal(fs.existsSync(marker), false, 'The selected path is consumed only after successful activation');
  const report = { ok: true, actualPackagedExe: exe, version: require('../package.json').version, selectedBase: state.base.id,
    books: state.books, markerConsumed: true, testProfile: profile, noExternalContentDir: true };
  fs.writeFileSync(path.join(stage, 'packaged-startup-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 2, method: 'Page.close' }));
  for (let count = 0; count < 80 && processHandle && !exit; count++) await delay(100);
  socket?.close();
  if (processHandle && !exit) {
    spawnSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true });
  }
});
