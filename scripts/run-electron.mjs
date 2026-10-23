/**
 * Wrapper around the electron-vite CLI.
 *
 * Why this exists
 * ---------------
 * Electron inspects the environment variable `ELECTRON_RUN_AS_NODE` at process
 * startup. When it is set to `1`, electron.exe boots as a plain Node.js runtime
 * instead of a GUI application. In that mode `require('electron')` resolves to
 * the npm shim (`node_modules/electron/index.js`) which merely exports the path
 * to the binary, so `electron.app` is `undefined` and every Electron API is
 * unavailable. The symptom is:
 *
 *   TypeError: Cannot read properties of undefined (reading 'isPackaged')
 *     at node_modules/@electron-toolkit/utils/dist/index.cjs:6
 *
 * Some Electron hosts (VS Code, WorkBuddy, other Electron-based apps) set this
 * variable when they spawn child processes, and it leaks into the whole child
 * process tree — including any terminal they embed. It is normally NOT present
 * in the machine or user environment scope.
 * Electron cannot recover from it once started, therefore the only reliable fix
 * is to remove the variable from the environment *before* electron.exe is
 * spawned. That is exactly what this wrapper does.
 *
 * Usage:  node scripts/run-electron.mjs <dev|preview|build> [...args]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/run-electron.mjs <dev|preview|build> [...args]');
  process.exit(1);
}

/**
 * Build a clean environment with every case-variant of ELECTRON_RUN_AS_NODE
 * removed. Windows environment blocks can hold duplicate keys that differ only
 * by casing, which is why we filter by uppercase comparison.
 */
function cleanEnv() {
  const env = { ...process.env };
  const removed = [];
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') {
      removed.push(`${key}=${env[key]}`);
      delete env[key];
    }
  }
  return { env, removed };
}

const { env, removed } = cleanEnv();
if (removed.length > 0) {
  console.warn(
    `[run-electron] 已从环境中移除 ${removed.join(', ')} —\n` +
      `[run-electron] 该变量会让 electron.exe 以纯 Node.js 模式启动，导致所有 Electron API 不可用。\n` +
      `[run-electron] 它通常来自拉起本终端的 Electron 宿主（如 WorkBuddy / VS Code 的内嵌终端），\n` +
      `[run-electron] 只影响本进程树，系统环境并未被修改。`,
  );
}

const cli = path.join(projectRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');

const child = spawn(process.execPath, [cli, ...args], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('[run-electron] 启动 electron-vite 失败:', err);
  process.exit(1);
});
