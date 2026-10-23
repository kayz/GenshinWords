const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const tsc = require.resolve('typescript/bin/tsc');
for (const config of ['tsconfig.json', 'tsconfig.renderer.json', 'tsconfig.tools.json', 'tsconfig.contracts.json']) {
  console.log('Typecheck: ' + config);
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', config], { cwd: root, stdio: 'inherit' });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
