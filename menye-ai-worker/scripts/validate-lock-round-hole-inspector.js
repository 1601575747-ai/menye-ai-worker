'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const inspectorPath = path.join(__dirname, 'inspect-lock-round-holes.js');

const samples = [
  {
    name: 'single baseline extra hole',
    imagePath: '/tmp/menye-e2e/results-test/single-lock-color-panel/ed693ef16a2d8924000a26eb3bc53c3b.png',
    region: 'left',
    expectedHasExtraRoundHole: true,
    expectedLockBody: { left: 297, top: 371, right: 342, bottom: 684 },
    expectedExtraHole: { left: 307, top: 691, right: 328, bottom: 712 }
  },
  {
    name: 'double baseline no extra hole',
    imagePath: '/tmp/menye-e2e/results-test/double-header-lock/831d07e26a2d8a4d000bb57253f9cf4d.png',
    region: 'left',
    expectedHasExtraRoundHole: false
  },
  {
    name: 'scene target lock custom region',
    imagePath: '/tmp/menye-e2e/results-test/scene-bg-lock-color/117e1a7d6a2d8b470006549d17f77e89.png',
    region: '0.605,0.43,0.665,0.68',
    expectedHasExtraRoundHole: false,
    expectedLockBody: { left: 620, top: 440, right: 680, bottom: 695 }
  }
];

function runInspector(sample) {
  const args = [inspectorPath, sample.imagePath, '--region', sample.region];
  const result = spawnSync(process.execPath, args, {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.strictEqual(
    result.status,
    0,
    `${sample.name} inspector failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );

  return JSON.parse(result.stdout);
}

function assertBox(actual, expected, label) {
  assert(actual, `missing ${label}`);
  for (const key of ['left', 'top', 'right', 'bottom']) {
    assert.strictEqual(actual[key], expected[key], `${label}.${key}`);
  }
}

let skipped = 0;
let checked = 0;

for (const sample of samples) {
  if (!fs.existsSync(sample.imagePath)) {
    console.warn(`[skip] ${sample.name}: missing ${sample.imagePath}`);
    skipped += 1;
    continue;
  }

  const result = runInspector(sample);
  assert.strictEqual(result.region.key, sample.region.includes(',') ? 'custom' : sample.region);
  assert.strictEqual(
    result.hasExtraRoundHole,
    sample.expectedHasExtraRoundHole,
    `${sample.name} hasExtraRoundHole`
  );

  if (sample.expectedLockBody) {
    assertBox(result.lockBody, sample.expectedLockBody, `${sample.name} lockBody`);
  }

  if (sample.expectedExtraHole) {
    assert(result.extraRoundHoleCandidates.length > 0, `${sample.name} missing extra hole candidate`);
    assertBox(result.extraRoundHoleCandidates[0], sample.expectedExtraHole, `${sample.name} extraHole`);
  }

  checked += 1;
}

if (!checked) {
  console.warn('lock round-hole inspector validation skipped: no local baseline images found');
} else {
  console.log(`lock round-hole inspector validation passed (${checked} checked, ${skipped} skipped)`);
}
