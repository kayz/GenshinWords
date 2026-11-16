'use strict';
// Read-only release audit. Content itself is never copied into the report.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadReadingPackageCore } = require('./reading-package-loader.cjs');
const core = loadReadingPackageCore();
const root = path.resolve(__dirname, '..');
const appVersion = require('../package.json').version;
const names = ['base', ...['entry','sh_zhongkao','gaokao','sh_gaokao','cet4','cet6','ielts','toefl'].map(x => 'level-' + x)];
const questions = new Map(), units = new Map(), ids = new Set();
const packages = names.map(name => {
  const file = path.join(root, 'content/reading', name + '.gwreading');
  const bytes = fs.readFileSync(file);
  const valid = core.decodeReadingPackage(bytes, { appVersion });
  assert.ok(!ids.has(valid.data.manifest.id), 'Duplicate package ID'); ids.add(valid.data.manifest.id);
  for (const [id, fingerprint] of Object.entries(valid.questionFingerprints)) {
    assert.ok(!questions.has(id) || questions.get(id) === fingerprint, 'Conflicting question ID: ' + id);
    questions.set(id, fingerprint);
  }
  for (const [id, fingerprint] of Object.entries(valid.unitFingerprints)) {
    assert.ok(!units.has(id) || units.get(id) === fingerprint, 'Conflicting unit ID: ' + id);
    units.set(id, fingerprint);
  }
  const levels = {};
  for (const unit of valid.units) levels[unit.level] = (levels[unit.level] || 0) + 1;
  return { file: path.basename(file), ...valid.data.manifest, units: valid.units.length,
    questions: valid.units.reduce((n,u) => n + u.questions.length, 0), levels,
    sources: valid.data.sources.length, images: valid.data.images.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
});
console.log(JSON.stringify({ appVersion, packages, totals: { units: packages.reduce((n,p)=>n+p.units,0), questions: packages.reduce((n,p)=>n+p.questions,0), uniqueQuestions: questions.size }, conflicts: 0 }, null, 2));
