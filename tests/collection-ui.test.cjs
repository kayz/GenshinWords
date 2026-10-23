const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('Electron UI: collect, review, source-only test, undo and return to source', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'genshinwords-ui-'));
  const env={...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result=spawnSync(require('electron'),[path.join(__dirname,'fixtures/collection-ui.cjs'),directory],{
      cwd:path.resolve(__dirname,'..'),env,encoding:'utf8',timeout:45000,windowsHide:true,
    });
    assert.equal(result.status,0,result.stdout+'\n'+result.stderr+'\n'+(result.error||''));
    assert.match(result.stdout,/"ok":true/);
  } finally {
    const target=path.resolve(directory);
    assert.equal(path.dirname(target),path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('genshinwords-ui-'));
    fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
});
