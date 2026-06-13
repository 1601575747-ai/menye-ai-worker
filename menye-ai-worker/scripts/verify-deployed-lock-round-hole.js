'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const sampleId = 'single-lock-color-panel';
const e2eScript = process.env.E2E_SCRIPT || '/tmp/menye-e2e/run-parts-e2e.js';
const outDir = process.env.OUT_DIR || `/tmp/menye-e2e/results-post-deploy-lock-${Date.now()}`;
const inspectorScript = path.join(__dirname, 'inspect-lock-round-holes.js');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || path.join(__dirname, '..'),
    env: options.env || process.env,
    encoding: 'utf8'
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }

  return result;
}

function findLatestResultImage(sampleDir) {
  if (!fs.existsSync(sampleDir)) {
    throw new Error(`E2E sample output directory not found: ${sampleDir}`);
  }

  const candidates = fs.readdirSync(sampleDir)
    .filter((fileName) => fileName.endsWith('.png') && !fileName.includes('annotated'))
    .map((fileName) => {
      const filePath = path.join(sampleDir, fileName);
      return {
        filePath,
        mtimeMs: fs.statSync(filePath).mtimeMs
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!candidates.length) {
    throw new Error(`No result PNG found in ${sampleDir}`);
  }

  return candidates[0].filePath;
}

function main() {
  if (!fs.existsSync(e2eScript)) {
    throw new Error(`E2E script not found: ${e2eScript}`);
  }

  console.log('[verify] running deployed single-lock E2E', {
    e2eScript,
    outDir,
    sampleId
  });

  run(process.execPath, [e2eScript], {
    env: {
      ...process.env,
      OUT_DIR: outDir,
      SAMPLE_IDS: sampleId
    }
  });

  const sampleDir = path.join(outDir, sampleId);
  const resultPath = findLatestResultImage(sampleDir);
  const annotationPath = resultPath.replace(/\.png$/i, '-round-hole-annotated.png');

  console.log('[verify] inspecting deployed result image', {
    resultPath,
    annotationPath
  });

  run(process.execPath, [
    inspectorScript,
    resultPath,
    '--fail-on-extra',
    '--annotate',
    annotationPath
  ]);

  console.log(JSON.stringify({
    passed: true,
    sampleId,
    resultPath,
    annotationPath
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
