'use strict';

const { TaskType } = require('./schema');
const { normalizeDoorType } = require('./profiles');
const { buildDoorStructurePrompt } = require('./prompts');
const {
  createOpenAIClient,
  getDefaultVisionModel
} = require('../ai/openaiClient');
const {
  parseStructuredJson,
  unwrapOpenAIResponseText
} = require('../ai/structuredOutput');
const { ErrorCode } = require('../utils/errors');

const BOX_KEYS = Object.freeze([
  'outerTrim',
  'opening',
  'visibleOpening',
  'doorLeaf',
  'handle',
  'lock',
  'transom',
  'header'
]);

function normalizeViewSide(viewSide) {
  return viewSide === 'back' ? 'back' : 'front';
}

function normalizeBox(box) {
  if (!box || typeof box !== 'object') {
    return null;
  }
  const left = Number(box.left);
  const top = Number(box.top);
  const right = Number(box.right);
  const bottom = Number(box.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) {
    return null;
  }
  return Object.freeze({ left, top, right, bottom });
}

function normalizeShadowRegions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Object.freeze(value.map(normalizeBox).filter(Boolean));
}

function makeEmptyBoxes() {
  return {
    outerTrim: null,
    opening: null,
    visibleOpening: null,
    doorLeaf: null,
    handle: null,
    lock: null,
    transom: null,
    header: null,
    shadowRegions: []
  };
}

function getMissingCriticalBoundaries(boxes, doorBottomY) {
  const missing = [];
  for (const key of ['outerTrim', 'opening', 'visibleOpening', 'doorLeaf']) {
    if (!boxes[key]) {
      missing.push(`boxes.${key}`);
    }
  }
  if (!Number.isFinite(doorBottomY)) {
    missing.push('keypoints.doorBottomY');
  }
  return missing;
}

function normalizeDoorStructure(raw, context = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const boxes = makeEmptyBoxes();
  const sourceBoxes = source.boxes && typeof source.boxes === 'object' ? source.boxes : {};
  for (const key of BOX_KEYS) {
    boxes[key] = normalizeBox(sourceBoxes[key]);
  }
  boxes.shadowRegions = normalizeShadowRegions(sourceBoxes.shadowRegions);

  const rawDoorBottomY = source.keypoints && source.keypoints.doorBottomY;
  const hasDoorBottomY = rawDoorBottomY !== null && rawDoorBottomY !== undefined && rawDoorBottomY !== '';
  const doorBottomY = hasDoorBottomY ? Number(rawDoorBottomY) : NaN;
  const normalizedDoorBottomY = Number.isFinite(doorBottomY) ? doorBottomY : null;
  const missingCriticalBoundaries = getMissingCriticalBoundaries(boxes, normalizedDoorBottomY);
  const needsUserAdjustment = !!source.needsUserAdjustment || missingCriticalBoundaries.length > 0;

  return Object.freeze({
    doorType: normalizeDoorType(source.doorType || context.doorType),
    viewSide: normalizeViewSide(source.viewSide || context.viewSide),
    boxes: Object.freeze(boxes),
    keypoints: Object.freeze({
      doorBottomY: normalizedDoorBottomY
    }),
    modes: Object.freeze({
      heightBottomMode: source.modes && source.modes.heightBottomMode === 'separate' ? 'separate' : 'shared'
    }),
    confidence: Object.freeze(source.confidence && typeof source.confidence === 'object' ? { ...source.confidence } : {}),
    needsUserAdjustment,
    issues: Object.freeze(missingCriticalBoundaries.map((boundary) => Object.freeze({
      code: ErrorCode.MISSING_REQUIRED_BOUNDARY,
      boundary,
      message: 'Missing critical door structure boundary'
    }))),
    notes: typeof source.notes === 'string' ? source.notes : ''
  });
}

function mockAnalyzer({ doorType, viewSide } = {}) {
  return normalizeDoorStructure({
    doorType,
    viewSide,
    boxes: {
      outerTrim: { left: 80, top: 70, right: 920, bottom: 960 },
      opening: { left: 120, top: 110, right: 880, bottom: 950 },
      visibleOpening: { left: 160, top: 150, right: 840, bottom: 940 },
      doorLeaf: { left: 200, top: 190, right: 800, bottom: 950 },
      handle: { left: 380, top: 560, right: 450, bottom: 640 },
      lock: null,
      transom: { left: 120, top: 60, right: 880, bottom: 150 },
      header: { left: 60, top: 30, right: 940, bottom: 960 },
      shadowRegions: [
        { left: 70, top: 960, right: 930, bottom: 990 }
      ]
    },
    keypoints: {
      doorBottomY: 950
    },
    modes: {
      heightBottomMode: 'shared'
    },
    confidence: {
      overall: 'mock',
      outerTrim: 'high',
      opening: 'high',
      visibleOpening: 'medium',
      doorLeaf: 'high'
    },
    needsUserAdjustment: false,
    notes: 'mock door structure'
  }, { doorType, viewSide });
}

async function openAIDoorAnalyzer({ imageUrl, doorType, viewSide, taskType, client } = {}) {
  const openai = client || createOpenAIClient();
  if (!openai || !imageUrl) {
    return normalizeDoorStructure({
      doorType,
      viewSide,
      boxes: {},
      keypoints: { doorBottomY: null },
      needsUserAdjustment: true,
      confidence: { overall: 'low' },
      notes: 'TODO: real analyzer adapter not configured; use mockAnalyzer in local tests.'
    }, { doorType, viewSide });
  }

  const response = await openai.responses.create({
    model: getDefaultVisionModel(),
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildDoorStructurePrompt({ doorType, viewSide, taskType })
          },
          {
            type: 'input_image',
            image_url: imageUrl
          }
        ]
      }
    ]
  });
  const parsed = parseStructuredJson(unwrapOpenAIResponseText(response));
  if (!parsed.ok) {
    return normalizeDoorStructure({
      doorType,
      viewSide,
      boxes: {},
      keypoints: { doorBottomY: null },
      needsUserAdjustment: true,
      confidence: { overall: 'low' },
      notes: parsed.error.message
    }, { doorType, viewSide });
  }
  return normalizeDoorStructure(parsed.value, { doorType, viewSide });
}

async function analyzeDoor({ imageUrl, doorType, viewSide, taskType, mode, client } = {}) {
  const normalizedTaskType = taskType || TaskType.DIMENSION_ANNOTATION;
  if (mode === 'openai') {
    try {
      return await openAIDoorAnalyzer({
        imageUrl,
        doorType,
        viewSide,
        taskType: normalizedTaskType,
        client
      });
    } catch (error) {
      return normalizeDoorStructure({
        doorType,
        viewSide,
        boxes: {},
        keypoints: { doorBottomY: null },
        needsUserAdjustment: true,
        confidence: { overall: 'low' },
        notes: error && error.message ? error.message : 'Door analyzer failed'
      }, { doorType, viewSide });
    }
  }
  return mockAnalyzer({
    imageUrl,
    doorType,
    viewSide,
    taskType: normalizedTaskType
  });
}

module.exports = {
  analyzeDoor,
  mockAnalyzer,
  openAIDoorAnalyzer,
  normalizeDoorStructure
};
