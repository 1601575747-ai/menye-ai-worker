'use strict';

const artifacts = new Map();
let artifactCounter = 0;

function nowIso() {
  return new Date().toISOString();
}

function cloneValue(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((result, key) => {
      result[key] = cloneValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function createArtifactId(type) {
  artifactCounter += 1;
  return `artifact_${type || 'generic'}_${Date.now()}_${artifactCounter}`;
}

function summarizeValue(value) {
  if (Buffer.isBuffer(value)) {
    return {
      kind: 'buffer',
      bytes: value.length
    };
  }
  if (typeof value === 'string') {
    return {
      kind: 'string',
      length: value.length
    };
  }
  if (value && typeof value === 'object') {
    return {
      kind: 'object',
      keys: Object.keys(value)
    };
  }
  return {
    kind: typeof value
  };
}

function saveArtifact({ jobId, type, value, metadata = {} }) {
  const artifactId = createArtifactId(type);
  const createdAt = nowIso();
  const artifact = {
    artifactId,
    jobId,
    type,
    value: cloneValue(value),
    metadata: {
      ...cloneValue(metadata),
      summary: summarizeValue(value)
    },
    createdAt
  };

  artifacts.set(artifactId, artifact);

  return {
    artifactId,
    jobId,
    type,
    metadata: cloneValue(artifact.metadata),
    createdAt
  };
}

function getArtifact(artifactId) {
  const artifact = artifacts.get(artifactId);
  return artifact ? cloneValue(artifact) : null;
}

function listArtifactsForJob(jobId) {
  return Array.from(artifacts.values())
    .filter((artifact) => artifact.jobId === jobId)
    .map((artifact) => ({
      artifactId: artifact.artifactId,
      jobId: artifact.jobId,
      type: artifact.type,
      metadata: cloneValue(artifact.metadata),
      createdAt: artifact.createdAt
    }));
}

function clearArtifactsForTest() {
  artifacts.clear();
  artifactCounter = 0;
}

module.exports = {
  saveArtifact,
  getArtifact,
  listArtifactsForJob,
  clearArtifactsForTest
};
