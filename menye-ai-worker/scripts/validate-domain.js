'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  TaskType,
  DimensionField,
  DimensionFieldMeta,
  DoorStructureShape,
  ValidationResultShape
} = require('../src/door/schema');
const {
  analyzeDoor,
  mockAnalyzer,
  normalizeDoorStructure,
  mergeAiStructureWithHeuristic
} = require('../src/door/analyzer');
const {
  doorTypeProfiles,
  normalizeDoorType,
  getDoorTypeProfile,
  getDimensionFields,
  isDimensionFieldAllowed
} = require('../src/door/profiles');
const { normalizeDimensionInputs } = require('../src/door/dimensions');
const { buildDimensionRules } = require('../src/door/ruleEngine');
const { buildDimensionRenderPlan } = require('../src/door/dimensionLayout');
const { renderDimensionAnnotation } = require('../src/renderers/dimensionRenderer');
const { validateDimensionAnnotation } = require('../src/door/validators');
const { runDimensionAnnotationPipeline } = require('../src/pipelines/dimensionAnnotation');
const { runPipeline } = require('../src/pipelines');
const {
  createJob,
  runJob,
  getJob
} = require('../src/jobs/jobController');
const {
  clearJobsForTest
} = require('../src/jobs/jobRepository');
const {
  listArtifactsForJob,
  clearArtifactsForTest
} = require('../src/jobs/artifactService');
const {
  buildDoorImageInstruction,
  getPromptDecisionSummary,
  normalizeTaskType
} = require('../src/server');
const { JobStatus } = require('../src/jobs/status');
const { ErrorCode } = require('../src/utils/errors');

let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  sharp = null;
}

const expectedTaskTypes = [
  'dimension-annotation',
  'parts-compose',
  'lock-replacement',
  'handle-replacement',
  'color-change',
  'background-replace',
  'cleanup'
];

const expectedJobStatuses = [
  'created',
  'uploaded',
  'normalized',
  'analyzing',
  'rules_ready',
  'rendering',
  'generating',
  'validating',
  'retrying',
  'succeeded',
  'failed',
  'needs_user_adjustment'
];

const expectedDimensionFields = [
  'openingWidth',
  'openingHeight',
  'visibleOpeningWidth',
  'visibleOpeningHeight',
  'withEdgeTrimWidth',
  'withEdgeTrimHeight',
  'wallThickness',
  'transomHeight',
  'headerWidth',
  'headerHeight'
];

const expectedErrorCodes = [
  'ANALYZER_LOW_CONFIDENCE',
  'MISSING_REQUIRED_BOUNDARY',
  'DIMENSION_RULE_INVALID',
  'RENDER_FAILED',
  'VALIDATION_FAILED',
  'LOCK_MISSING',
  'IMAGE_GENERATION_FAILED'
];

const expectedDoorTypes = [
  'single',
  'double',
  'motherChild',
  'fourMotherChild',
  'fourEqual',
  'sixPanel'
];

const forbiddenDimensionText = [
  '门套线宽',
  '门套厚度',
  '把手中心离地',
  '锁体中心离地',
  '上合页离门顶',
  '中合页离门顶',
  '下合页离门顶',
  '玻璃透光窗高',
  '玻璃透光窗宽',
  '净通行宽',
  '正面把手中心离地',
  '正面锁体中心离地',
  '背面把手中心离地',
  '背面锁体中心离地',
  '门扇高',
  '门扇宽',
  '包边宽',
  '含气窗宽'
];

async function main() {
assert.deepStrictEqual(Object.values(TaskType).sort(), expectedTaskTypes.slice().sort());
assert.deepStrictEqual(Object.values(JobStatus).sort(), expectedJobStatuses.slice().sort());
assert.deepStrictEqual(Object.values(DimensionField).sort(), expectedDimensionFields.slice().sort());
assert.deepStrictEqual(Object.values(ErrorCode).sort(), expectedErrorCodes.slice().sort());

for (const fieldKey of expectedDimensionFields) {
  const meta = DimensionFieldMeta[fieldKey];
  assert(meta, `missing DimensionFieldMeta.${fieldKey}`);
  assert.strictEqual(meta.key, fieldKey);
  assert.strictEqual(meta.unit, 'mm');
  assert.strictEqual(meta.type, 'number');
  assert.strictEqual(typeof meta.label, 'string');
  assert(meta.label.length > 0);
}

assert.strictEqual(DimensionFieldMeta.wallThickness.textOnly, true);
for (const fieldKey of expectedDimensionFields.filter((key) => key !== 'wallThickness')) {
  assert.strictEqual(DimensionFieldMeta[fieldKey].textOnly, false);
}

assert.strictEqual(DoorStructureShape.viewSide, 'front');
assert(DoorStructureShape.boxes);
assert(Array.isArray(DoorStructureShape.boxes.shadowRegions));
assert(DoorStructureShape.keypoints);
assert(DoorStructureShape.modes);

assert.strictEqual(ValidationResultShape.passed, false);
assert(Array.isArray(ValidationResultShape.issues));
assert.strictEqual(ValidationResultShape.retryable, false);
assert.strictEqual(ValidationResultShape.needsUserAdjustment, false);

assert.deepStrictEqual(Object.keys(doorTypeProfiles).sort(), expectedDoorTypes.slice().sort());

assert.strictEqual(normalizeDoorType('single'), 'single');
assert.strictEqual(normalizeDoorType('单开门'), 'single');
assert.strictEqual(normalizeDoorType('双开门'), 'double');
assert.strictEqual(normalizeDoorType('子母门'), 'motherChild');
assert.strictEqual(normalizeDoorType('四开子母门'), 'fourMotherChild');
assert.strictEqual(normalizeDoorType('四开平分门'), 'fourEqual');
assert.strictEqual(normalizeDoorType('六开门'), 'sixPanel');
assert.strictEqual(normalizeDoorType('unknown'), 'single');

for (const doorType of expectedDoorTypes) {
  const profile = getDoorTypeProfile(doorType);
  assert(profile, `missing profile ${doorType}`);
  assert.strictEqual(profile.key, doorType);
  assert.strictEqual(typeof profile.label, 'string');
  assert(profile.label.length > 0);
  assert(Array.isArray(profile.supportedViewSides));
  assert(profile.supportedViewSides.includes('front'));
  assert(profile.supportedViewSides.includes('back'));
  assert(Array.isArray(profile.dimensionFields));
  assert(profile.dimensionFields.length > 0);
  assert(profile.dimensionRules);
  assert(Array.isArray(profile.allowedPipelines));
  assert(profile.allowedPipelines.includes(TaskType.DIMENSION_ANNOTATION));
  assert(Array.isArray(profile.requiredSlots));
  assert(Array.isArray(profile.optionalSlots));

  for (const fieldKey of profile.dimensionFields) {
    assert(expectedDimensionFields.includes(fieldKey), `profile ${doorType} uses unknown dimension field ${fieldKey}`);
    assert(DimensionFieldMeta[fieldKey], `profile ${doorType} field ${fieldKey} missing meta`);
    assert.strictEqual(DimensionFieldMeta[fieldKey].unit, 'mm');
    assert(profile.dimensionRules[fieldKey], `profile ${doorType} field ${fieldKey} missing dimension rule`);
  }

  const profileText = JSON.stringify(profile);
  for (const forbiddenText of forbiddenDimensionText) {
    assert(!profileText.includes(forbiddenText), `profile ${doorType} contains forbidden old field text ${forbiddenText}`);
  }

  const fields = getDimensionFields({
    doorType,
    viewSide: 'front',
    taskType: TaskType.DIMENSION_ANNOTATION
  });
  assert.strictEqual(fields.length, profile.dimensionFields.length);
  for (const fieldMeta of fields) {
    assert.strictEqual(fieldMeta.unit, 'mm');
    assert.strictEqual(isDimensionFieldAllowed({
      doorType,
      viewSide: 'front',
      field: fieldMeta.key
    }), true);
  }
  assert.deepStrictEqual(getDimensionFields({
    doorType,
    viewSide: 'front',
    taskType: TaskType.PARTS_COMPOSE
  }), []);
  assert.strictEqual(isDimensionFieldAllowed({
    doorType,
    viewSide: 'front',
    field: 'leafWidth'
  }), false);
}

const multiPartPromptJob = Object.freeze({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '双开门',
  requirement: '门体和包边跟颜色参考图统一，背景改成白板，门头门柱按参考图，气窗按参考图，把手按参考图',
  referenceImages: Object.freeze([
    Object.freeze({ slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' }),
    Object.freeze({ slotId: 'header-column-detail', originalImageFileID: 'cloud://mock/header.png' }),
    Object.freeze({ slotId: 'edge-trim-detail', originalImageFileID: 'cloud://mock/edge.png' }),
    Object.freeze({ slotId: 'glass-grille-detail', originalImageFileID: 'cloud://mock/glass.png' }),
    Object.freeze({ slotId: 'handle-detail', originalImageFileID: 'cloud://mock/handle.png' }),
    Object.freeze({ slotId: 'color-sample', originalImageFileID: 'cloud://mock/color.png' })
  ])
});
assert.strictEqual(normalizeTaskType(multiPartPromptJob), 'parts-compose');
const multiPartDecision = getPromptDecisionSummary(multiPartPromptJob);
assert.strictEqual(multiPartDecision.hasColorSample, true);
assert.strictEqual(multiPartDecision.colorSampleAppliesToEdgeTrim, true);
const multiPartPrompt = buildDoorImageInstruction(multiPartPromptJob, null, null, [
  { slotId: 'header-column-detail', label: '门头/门柱', color: '深灰色', applyDescription: '迁移门头门柱结构' },
  { slotId: 'edge-trim-detail', label: '包边', color: '红棕色', applyDescription: '迁移包边结构' },
  { slotId: 'glass-grille-detail', label: '气窗', color: '灰玻', applyDescription: '迁移气窗格栅' },
  { slotId: 'color-sample', label: '门体颜色', color: '浅木色', colorFamily: '木色', applyDescription: '统一浅木色' }
], null);
assert(multiPartPrompt.includes('结构化强制任务清单'));
assert(multiPartPrompt.includes('门头/门柱覆盖包边规则'));
assert(multiPartPrompt.includes('把手'));
assert(multiPartPrompt.includes('气窗'));
assert(multiPartPrompt.includes('门头/门柱'));
assert(multiPartPrompt.includes('整门颜色'));
assert(multiPartPrompt.includes('门部件拼接效果图默认白板背景'));
assert(multiPartPrompt.includes('最终颜色覆盖自检'));
assert(multiPartPrompt.includes('门头/门柱/外框装饰必须先按门头/门柱参考图处理结构，再被颜色参考图统一校色'));
assert(!multiPartPrompt.includes('系统识别到包边参考图特征'));
assert(!multiPartPrompt.includes('包边：必须识别包边参考图'));

const backgroundPrompt = buildDoorImageInstruction({
  taskType: 'background-replace',
  templateType: '场景效果图',
  doorType: '双开门',
  requirement: '把门安装到背景参考图的门位里',
  targetParts: ['background'],
  referenceImages: [
    { slotId: 'background-reference', originalImageFileID: 'cloud://mock/background.jpg' },
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' }
  ]
}, {
  source: 'background-doorway-test',
  left: 120,
  top: 80,
  right: 860,
  bottom: 980
}, null, [
  { slotId: 'background-reference', label: '背景', applyDescription: '以背景门位为最终画布' }
], null);
assert(backgroundPrompt.includes('输入图1是背景参考图'));
assert(backgroundPrompt.includes('输入图2是整门上下文图'));
assert(backgroundPrompt.includes('旧门、门洞或预留门位只用于定位'));
assert(backgroundPrompt.includes('背景参考图不能作为门款'));
assert(backgroundPrompt.includes('最终结果应等于：输入图1背景底图 + 输入图2整门抠图贴入输入图1的 mask 门位区域'));

const handleReferencePrompt = buildDoorImageInstruction({
  taskType: 'handle-replacement',
  templateType: '门把手替换',
  doorType: '双开门',
  requirement: '只换把手，其他不变',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'handle-detail', originalImageFileID: 'cloud://mock/handle.png' }
  ]
}, null, {
  color: '金色',
  material: '金属',
  finish: '亮面',
  shape: '长拉手',
  containsSmartLock: true,
  smartLockInterference: '参考图中拍到了黑色智能锁面板'
}, [], null);
assert(handleReferencePrompt.includes('把手图含锁防污染规则'));
assert(handleReferencePrompt.includes('这些都必须视为非把手干扰信息，不能被复制'));
assert(handleReferencePrompt.includes('整门照中原本存在的智能锁/锁体/锁芯/猫眼/门铃位置'));

const mockDoorStructure = Object.freeze({
  doorType: 'single',
  viewSide: 'front',
  boxes: Object.freeze({
    outerTrim: Object.freeze({ left: 80, top: 70, right: 920, bottom: 960 }),
    opening: Object.freeze({ left: 120, top: 110, right: 880, bottom: 950 }),
    visibleOpening: Object.freeze({ left: 160, top: 150, right: 840, bottom: 940 }),
    doorLeaf: Object.freeze({ left: 200, top: 190, right: 800, bottom: 950 }),
    handle: null,
    lock: null,
    transom: Object.freeze({ left: 120, top: 60, right: 880, bottom: 150 }),
    header: Object.freeze({ left: 60, top: 30, right: 940, bottom: 960 }),
    shadowRegions: Object.freeze([
      Object.freeze({ left: 70, top: 960, right: 930, bottom: 990 })
    ])
  }),
  keypoints: Object.freeze({
    doorBottomY: 950
  }),
  modes: Object.freeze({
    heightBottomMode: 'shared'
  }),
  confidence: Object.freeze({
    opening: 'high',
    visibleOpening: 'medium',
    outerTrim: 'high'
  }),
  notes: ''
});

const normalizedInputs = normalizeDimensionInputs({
  openingWidth: '900mm',
  openingHeight: '',
  visibleOpeningWidth: null,
  withEdgeTrimWidth: undefined,
  wallThickness: '280',
  leafWidth: '500',
  headerWidth: 'abc'
}, {
  doorType: 'single',
  viewSide: 'front'
});
assert.strictEqual(normalizedInputs.values.openingWidth.value, 900);
assert.strictEqual(normalizedInputs.values.openingWidth.unit, 'mm');
assert.strictEqual(normalizedInputs.values.wallThickness.value, 280);
assert.strictEqual(normalizedInputs.values.wallThickness.textOnly, true);
assert.strictEqual(Object.prototype.hasOwnProperty.call(normalizedInputs.values, 'leafWidth'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(normalizedInputs.values, 'openingHeight'), false);
assert(normalizedInputs.errors.some((issue) => issue.field === 'headerWidth'));

const openingWidthOnly = buildDimensionRules({
  doorType: '单开门',
  viewSide: 'front',
  inputs: {
    openingWidth: '900',
    openingHeight: '',
    visibleOpeningHeight: null
  },
  doorStructure: mockDoorStructure
});
assert.strictEqual(openingWidthOnly.status, JobStatus.RULES_READY);
assert.deepStrictEqual(openingWidthOnly.rules.map((rule) => rule.field), ['openingWidth']);
assert.strictEqual(openingWidthOnly.rules[0].label, DimensionFieldMeta.openingWidth.label);
assert.strictEqual(openingWidthOnly.rules[0].unit, 'mm');
assert.strictEqual(openingWidthOnly.rules[0].type, 'line');
assert.strictEqual(openingWidthOnly.rules[0].orientation, 'horizontal');
assert.strictEqual(openingWidthOnly.rules[0].sourceBoundary.box, 'visibleOpening');
assert.strictEqual(openingWidthOnly.rules[0].sourceBoundary.boundaryMode, 'doorTrimConnection');
assert.strictEqual(openingWidthOnly.rules[0].sourceBoundary.from.value, mockDoorStructure.boxes.visibleOpening.left);
assert.strictEqual(openingWidthOnly.rules[0].sourceBoundary.to.value, mockDoorStructure.boxes.visibleOpening.right);

const openingWithVisibleWidth = buildDimensionRules({
  doorType: '单开门',
  viewSide: 'front',
  inputs: {
    openingWidth: '900',
    visibleOpeningWidth: '800'
  },
  doorStructure: mockDoorStructure
});
const openingWithVisibleOpeningRule = openingWithVisibleWidth.rules.find((rule) => rule.field === 'openingWidth');
const openingWithVisibleVisibleRule = openingWithVisibleWidth.rules.find((rule) => rule.field === 'visibleOpeningWidth');
assert(openingWithVisibleOpeningRule);
assert(openingWithVisibleVisibleRule);
assert.strictEqual(openingWithVisibleOpeningRule.sourceBoundary.box, 'openingEdgeTrimMidline');
assert.strictEqual(openingWithVisibleOpeningRule.sourceBoundary.boundaryMode, 'edgeTrimMidline');
assert.deepStrictEqual(openingWithVisibleOpeningRule.sourceBoundary.sourceBoxes, ['outerTrim', 'visibleOpening']);
assert.strictEqual(openingWithVisibleOpeningRule.sourceBoundary.from.value, 120);
assert.strictEqual(openingWithVisibleOpeningRule.sourceBoundary.to.value, 880);
assert.strictEqual(openingWithVisibleVisibleRule.sourceBoundary.box, 'visibleOpening');
assert.strictEqual(openingWithVisibleVisibleRule.sourceBoundary.from.value, 160);
assert.strictEqual(openingWithVisibleVisibleRule.sourceBoundary.to.value, 840);

const wallOnly = buildDimensionRules({
  doorType: 'single',
  viewSide: 'front',
  inputs: {
    wallThickness: '280'
  },
  doorStructure: mockDoorStructure
});
assert.deepStrictEqual(wallOnly.rules.map((rule) => rule.field), ['wallThickness']);
assert.strictEqual(wallOnly.rules[0].type, 'textOnly');
assert.strictEqual(wallOnly.rules[0].orientation, null);
assert.strictEqual(wallOnly.rules[0].sourceBoundary, null);

const sharedHeightRules = buildDimensionRules({
  doorType: 'single',
  viewSide: 'front',
  inputs: {
    openingHeight: '2100',
    visibleOpeningHeight: '2050',
    withEdgeTrimHeight: '2200'
  },
  doorStructure: mockDoorStructure
});
assert.strictEqual(sharedHeightRules.status, JobStatus.RULES_READY);
assert.strictEqual(sharedHeightRules.rules.length, 3);
assert.deepStrictEqual(sharedHeightRules.rules.map((rule) => rule.field).sort(), [
  'openingHeight',
  'visibleOpeningHeight',
  'withEdgeTrimHeight'
].sort());
for (const rule of sharedHeightRules.rules) {
  assert.strictEqual(rule.type, 'line');
  assert.strictEqual(rule.orientation, 'vertical');
  assert.strictEqual(rule.sourceBoundary.to.key, 'doorBottomY');
  assert.strictEqual(rule.sourceBoundary.to.value, 950);
  assert.strictEqual(rule.constraints.sharedBottomY, 950);
}
const sharedOpeningHeightRule = sharedHeightRules.rules.find((rule) => rule.field === 'openingHeight');
const sharedVisibleHeightRule = sharedHeightRules.rules.find((rule) => rule.field === 'visibleOpeningHeight');
assert(sharedOpeningHeightRule);
assert(sharedVisibleHeightRule);
assert.strictEqual(sharedOpeningHeightRule.sourceBoundary.from.value, 110);
assert.strictEqual(sharedVisibleHeightRule.sourceBoundary.from.value, 150);

const headerHeightRule = buildDimensionRules({
  doorType: 'single',
  viewSide: 'front',
  inputs: {
    headerHeight: '2600'
  },
  doorStructure: mockDoorStructure
});
assert.strictEqual(headerHeightRule.status, JobStatus.RULES_READY);
assert.strictEqual(headerHeightRule.rules[0].field, 'headerHeight');
assert.strictEqual(headerHeightRule.rules[0].sourceBoundary.box, 'header');
assert.strictEqual(headerHeightRule.rules[0].sourceBoundary.to.key, 'doorBottomY');
assert.strictEqual(headerHeightRule.rules[0].sourceBoundary.to.value, 950);

const transomLikeStructure = normalizeDoorStructure({
  doorType: 'double',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 100, top: 20, right: 900, bottom: 980 },
    opening: { left: 160, top: 300, right: 840, bottom: 970 },
    visibleOpening: { left: 190, top: 340, right: 810, bottom: 970 },
    doorLeaf: { left: 190, top: 340, right: 810, bottom: 970 },
    handle: null,
    lock: null,
    transom: { left: 160, top: 20, right: 840, bottom: 300 },
    header: { left: 100, top: 20, right: 900, bottom: 980 },
    shadowRegions: []
  },
  keypoints: { doorBottomY: 970 },
  modes: { heightBottomMode: 'shared' },
  confidence: { overall: 'test' },
  needsUserAdjustment: false,
  notes: 'transom-like local top regression'
});
const transomLikeRules = buildDimensionRules({
  doorType: 'double',
  viewSide: 'front',
  inputs: {
    openingHeight: '2400',
    visibleOpeningHeight: '2300'
  },
  doorStructure: transomLikeStructure
});
const transomLikeOpeningHeight = transomLikeRules.rules.find((rule) => rule.field === 'openingHeight');
const transomLikeVisibleHeight = transomLikeRules.rules.find((rule) => rule.field === 'visibleOpeningHeight');
assert(transomLikeOpeningHeight);
assert(transomLikeVisibleHeight);
assert.strictEqual(transomLikeOpeningHeight.sourceBoundary.from.value, 320);
assert.strictEqual(transomLikeVisibleHeight.sourceBoundary.from.value, 340);
assert.notStrictEqual(transomLikeOpeningHeight.sourceBoundary.from.value, 180);

const shadowCheck = buildDimensionRules({
  doorType: 'single',
  viewSide: 'front',
  inputs: {
    withEdgeTrimWidth: '1000'
  },
  doorStructure: mockDoorStructure
});
assert.strictEqual(shadowCheck.rules[0].sourceBoundary.box, 'outerTrim');
assert.notStrictEqual(shadowCheck.rules[0].sourceBoundary.box, 'shadowRegions');
assert.strictEqual(shadowCheck.rules[0].constraints.ignoreShadowRegions, true);

const missingBoundary = buildDimensionRules({
  doorType: 'single',
  viewSide: 'front',
  inputs: {
    openingWidth: '900'
  },
  doorStructure: {
    ...mockDoorStructure,
    boxes: {
      ...mockDoorStructure.boxes,
      opening: null,
      visibleOpening: null
    }
  }
});
assert.strictEqual(missingBoundary.status, JobStatus.NEEDS_USER_ADJUSTMENT);
assert.strictEqual(missingBoundary.needsUserAdjustment, true);
assert.strictEqual(missingBoundary.rules.length, 0);
assert(missingBoundary.issues.some((issue) => issue.code === ErrorCode.MISSING_REQUIRED_BOUNDARY));

const analyzedDoor = await analyzeDoor({
  imageUrl: 'mock://door.png',
  doorType: '单开门',
  viewSide: 'front',
  taskType: TaskType.DIMENSION_ANNOTATION
});
assert.strictEqual(analyzedDoor.doorType, 'single');
assert.strictEqual(analyzedDoor.viewSide, 'front');
assert(analyzedDoor.boxes.outerTrim);
assert(analyzedDoor.boxes.opening);
assert(analyzedDoor.boxes.visibleOpening);
assert(analyzedDoor.boxes.doorLeaf);
assert(Array.isArray(analyzedDoor.boxes.shadowRegions));
assert.strictEqual(analyzedDoor.keypoints.doorBottomY, 950);
assert.strictEqual(analyzedDoor.modes.heightBottomMode, 'shared');
assert.strictEqual(analyzedDoor.needsUserAdjustment, false);
assert(analyzedDoor.confidence);
assert.strictEqual(typeof analyzedDoor.notes, 'string');

const hybridAnalyzerImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#fff"/><rect x="20" y="10" width="80" height="145" fill="#555"/><rect x="30" y="25" width="60" height="125" fill="#777"/></svg>');
const validAiClient = {
  responses: {
    create: async () => ({
      output_text: JSON.stringify({
        doorType: 'single',
        viewSide: 'front',
        boxes: {
          outerTrim: { left: 18, top: 8, right: 102, bottom: 156 },
          opening: { left: 27, top: 22, right: 93, bottom: 154 },
          visibleOpening: { left: 32, top: 30, right: 88, bottom: 154 },
          doorLeaf: { left: 35, top: 34, right: 85, bottom: 154 },
          handle: null,
          lock: null,
          transom: null,
          header: { left: 18, top: 8, right: 102, bottom: 156 },
          shadowRegions: []
        },
        keypoints: { doorBottomY: 154 },
        modes: { heightBottomMode: 'shared' },
        confidence: { overall: 'high' },
        needsUserAdjustment: false,
        notes: 'valid ai structure'
      })
    })
  }
};
const hybridAnalyzedDoor = await analyzeDoor({
  image: hybridAnalyzerImage,
  imageSize: { width: 120, height: 160 },
  doorType: 'single',
  viewSide: 'front',
  taskType: TaskType.DIMENSION_ANNOTATION,
  mode: 'hybrid',
  client: validAiClient
});
assert.strictEqual(hybridAnalyzedDoor.boxes.opening.top, 22);
assert.strictEqual(hybridAnalyzedDoor.boxes.visibleOpening.left, 32);
assert(hybridAnalyzedDoor.notes.includes('ai-assisted'));

const nonBlockingAdjustmentAiClient = {
  responses: {
    create: async () => ({
      output_text: JSON.stringify({
        doorType: 'single',
        viewSide: 'front',
        boxes: {
          outerTrim: { left: 18, top: 8, right: 102, bottom: 156 },
          opening: { left: 27, top: 22, right: 93, bottom: 154 },
          visibleOpening: { left: 32, top: 30, right: 88, bottom: 154 },
          doorLeaf: { left: 35, top: 34, right: 85, bottom: 154 },
          handle: null,
          lock: null,
          transom: null,
          header: { left: 18, top: 8, right: 102, bottom: 156 },
          shadowRegions: []
        },
        keypoints: { doorBottomY: 154 },
        modes: { heightBottomMode: 'separate' },
        confidence: { overall: 'high', opening: 'high', visibleOpening: 'high', outerTrim: 'high', doorLeaf: 'high' },
        needsUserAdjustment: true,
        notes: 'non-critical adjustment requested'
      })
    })
  }
};
const nonBlockingAdjustmentDoor = await analyzeDoor({
  image: hybridAnalyzerImage,
  imageSize: { width: 120, height: 160 },
  doorType: 'single',
  viewSide: 'front',
  taskType: TaskType.DIMENSION_ANNOTATION,
  mode: 'hybrid',
  client: nonBlockingAdjustmentAiClient
});
assert.strictEqual(nonBlockingAdjustmentDoor.needsUserAdjustment, false);
assert.strictEqual(nonBlockingAdjustmentDoor.modes.heightBottomMode, 'shared');
assert(nonBlockingAdjustmentDoor.notes.includes('non-blocking analyzer adjustment cleared'));

const invalidAiClient = {
  responses: {
    create: async () => ({
      output_text: JSON.stringify({
        doorType: 'single',
        viewSide: 'front',
        boxes: {
          outerTrim: { left: -999, top: -999, right: -1, bottom: -1 },
          opening: null,
          visibleOpening: null,
          doorLeaf: null,
          handle: null,
          lock: null,
          transom: null,
          header: null,
          shadowRegions: []
        },
        keypoints: { doorBottomY: null },
        modes: { heightBottomMode: 'shared' },
        confidence: { overall: 'low' },
        needsUserAdjustment: false,
        notes: 'invalid ai structure'
      })
    })
  }
};
const fallbackAnalyzedDoor = await analyzeDoor({
  image: hybridAnalyzerImage,
  imageSize: { width: 120, height: 160 },
  doorType: 'single',
  viewSide: 'front',
  taskType: TaskType.DIMENSION_ANNOTATION,
  mode: 'hybrid',
  client: invalidAiClient
});
assert.notStrictEqual(fallbackAnalyzedDoor.boxes.outerTrim.left, -999);
assert.strictEqual(fallbackAnalyzedDoor.needsUserAdjustment, false);
assert(fallbackAnalyzedDoor.notes.includes('AI analyzer fallback'));

const heuristicWideStructure = normalizeDoorStructure({
  doorType: 'double',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 100, top: 20, right: 900, bottom: 980 },
    opening: { left: 160, top: 240, right: 840, bottom: 970 },
    visibleOpening: { left: 190, top: 280, right: 810, bottom: 970 },
    doorLeaf: { left: 230, top: 300, right: 770, bottom: 970 },
    handle: null,
    lock: null,
    transom: null,
    header: { left: 100, top: 20, right: 900, bottom: 980 },
    shadowRegions: []
  },
  keypoints: { doorBottomY: 970 },
  modes: { heightBottomMode: 'shared' },
  confidence: { overall: 'heuristic' },
  needsUserAdjustment: false,
  notes: 'heuristic wide structure'
});
const narrowAiStructure = normalizeDoorStructure({
  doorType: 'double',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 100, top: 20, right: 900, bottom: 980 },
    opening: { left: 360, top: 245, right: 640, bottom: 970 },
    visibleOpening: { left: 390, top: 285, right: 610, bottom: 970 },
    doorLeaf: { left: 230, top: 300, right: 770, bottom: 970 },
    handle: null,
    lock: null,
    transom: null,
    header: { left: 100, top: 20, right: 900, bottom: 980 },
    shadowRegions: []
  },
  keypoints: { doorBottomY: 970 },
  modes: { heightBottomMode: 'shared' },
  confidence: { overall: 'high' },
  needsUserAdjustment: false,
  notes: 'narrow ai structure'
});
const guardedStructure = mergeAiStructureWithHeuristic(narrowAiStructure, heuristicWideStructure, {
  imageSize: { width: 1000, height: 1000 }
});
assert.strictEqual(guardedStructure.boxes.opening.left, heuristicWideStructure.boxes.opening.left);
assert.strictEqual(guardedStructure.boxes.opening.right, heuristicWideStructure.boxes.opening.right);
assert.strictEqual(guardedStructure.boxes.visibleOpening.left, heuristicWideStructure.boxes.visibleOpening.left);
assert.strictEqual(guardedStructure.boxes.visibleOpening.right, heuristicWideStructure.boxes.visibleOpening.right);
assert(guardedStructure.notes.includes('restored from heuristic guard'));

const mockDoor = mockAnalyzer({
  doorType: '双开门',
  viewSide: 'back'
});
assert.strictEqual(mockDoor.doorType, 'double');
assert.strictEqual(mockDoor.viewSide, 'back');

const syntheticDoubleDoorImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><rect width="240" height="320" fill="#fff"/><rect x="40" y="20" width="160" height="285" fill="#4b4b4b"/><rect x="54" y="48" width="132" height="245" fill="#6d6d6d"/><rect x="62" y="64" width="58" height="220" fill="#777"/><rect x="120" y="64" width="58" height="220" fill="#777"/><line x1="120" y1="64" x2="120" y2="284" stroke="#333" stroke-width="3"/></svg>');
const syntheticDoubleDoor = await analyzeDoor({
  image: syntheticDoubleDoorImage,
  imageSize: { width: 240, height: 320 },
  doorType: 'double',
  viewSide: 'front',
  taskType: TaskType.DIMENSION_ANNOTATION,
  mode: 'heuristic'
});
const syntheticOpeningWidth = syntheticDoubleDoor.boxes.opening.right - syntheticDoubleDoor.boxes.opening.left;
const syntheticVisibleWidth = syntheticDoubleDoor.boxes.visibleOpening.right - syntheticDoubleDoor.boxes.visibleOpening.left;
assert(syntheticVisibleWidth >= syntheticOpeningWidth * 0.95);
assert(Math.abs(syntheticDoubleDoor.boxes.visibleOpening.left - syntheticDoubleDoor.boxes.opening.left) <= 3);
assert(Math.abs(syntheticDoubleDoor.boxes.visibleOpening.right - syntheticDoubleDoor.boxes.opening.right) <= 3);

const localSingleDoorRegressionPath = path.join(
  process.env.HOME || '',
  'Downloads',
  '3zhk7ivH1mu-0770afb1f40e2998f623f8c34f2a7602.png'
);
if (sharp && fs.existsSync(localSingleDoorRegressionPath)) {
  const localSingleDoorImage = await sharp(localSingleDoorRegressionPath).rotate().png().toBuffer();
  const localSingleDoorMetadata = await sharp(localSingleDoorImage).metadata();
  const localSingleDoor = await analyzeDoor({
    image: localSingleDoorImage,
    imageSize: {
      width: localSingleDoorMetadata.width,
      height: localSingleDoorMetadata.height
    },
    doorType: 'single',
    viewSide: 'front',
    taskType: TaskType.DIMENSION_ANNOTATION,
    mode: 'heuristic'
  });
  assert(localSingleDoor.boxes.visibleOpening.top < 100);
  assert(localSingleDoor.boxes.visibleOpening.top - localSingleDoor.boxes.opening.top <= 32);
}

const analyzerRules = buildDimensionRules({
  doorType: mockDoor.doorType,
  viewSide: mockDoor.viewSide,
  inputs: {
    openingWidth: '900',
    wallThickness: '280'
  },
  doorStructure: mockDoor
});
assert.strictEqual(analyzerRules.status, JobStatus.RULES_READY);
assert.deepStrictEqual(analyzerRules.rules.map((rule) => rule.field).sort(), ['openingWidth', 'wallThickness'].sort());
assert(analyzerRules.rules.some((rule) => rule.type === 'line'));
assert(analyzerRules.rules.some((rule) => rule.type === 'textOnly'));

const invalidStructure = normalizeDoorStructure({
  doorType: 'single',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 80, top: 70, right: 920, bottom: 960 },
    opening: null,
    visibleOpening: { left: 160, top: 150, right: 840, bottom: 940 },
    doorLeaf: { left: 200, top: 190, right: 800, bottom: 950 },
    shadowRegions: []
  },
  keypoints: {
    doorBottomY: null
  },
  modes: {
    heightBottomMode: 'shared'
  },
  confidence: {
    opening: 'low',
    overall: 'low'
  },
  notes: 'missing boundary test'
});
assert.strictEqual(invalidStructure.needsUserAdjustment, true);
assert(invalidStructure.issues.some((issue) => issue.boundary === 'boxes.opening'));
assert(invalidStructure.issues.some((issue) => issue.boundary === 'keypoints.doorBottomY'));

const imageSize = { width: 1024, height: 1024 };
const openingWidthPlanRules = buildDimensionRules({
  doorType: 'single',
  viewSide: 'front',
  inputs: {
    openingWidth: '980'
  },
  doorStructure: analyzedDoor
});
const openingWidthPlan = buildDimensionRenderPlan({
  rules: openingWidthPlanRules.rules,
  doorStructure: analyzedDoor,
  imageSize
});
assert.strictEqual(openingWidthPlan.lines.length, 1);
assert.strictEqual(openingWidthPlan.texts.length, 1);
assert.strictEqual(openingWidthPlan.lines[0].field, 'openingWidth');
assert.strictEqual(openingWidthPlan.lines[0].orientation, 'horizontal');
assert(openingWidthPlan.lines[0].from.y < analyzedDoor.boxes.outerTrim.top);
assert.strictEqual(openingWidthPlan.extensionLines.length, 2);
assert(openingWidthPlan.texts[0].text.includes('980mm'));

const twoWidthRules = buildDimensionRules({
  doorType: 'single',
  viewSide: 'front',
  inputs: {
    openingWidth: '980',
    visibleOpeningWidth: '900'
  },
  doorStructure: analyzedDoor
});
const twoWidthPlan = buildDimensionRenderPlan({
  rules: twoWidthRules.rules,
  doorStructure: analyzedDoor,
  imageSize
});
assert.strictEqual(twoWidthPlan.lines.length, 2);
assert.notDeepStrictEqual(twoWidthPlan.lines[0].from, twoWidthPlan.lines[1].from);
assert.notStrictEqual(twoWidthPlan.lines[0].from.y, twoWidthPlan.lines[1].from.y);
assert.strictEqual(twoWidthPlan.extensionLines.length, 4);
assert(twoWidthPlan.lines.every((line) => line.from.y < analyzedDoor.boxes.outerTrim.top));

const wallPlan = buildDimensionRenderPlan({
  rules: wallOnly.rules,
  doorStructure: analyzedDoor,
  imageSize
});
assert.strictEqual(wallPlan.lines.length, 0);
assert.strictEqual(wallPlan.texts.length, 0);
assert.strictEqual(wallPlan.textOnlyAnnotations.length, 1);
assert.strictEqual(wallPlan.textOnlyAnnotations[0].positionKey, 'bottomRight');
assert.strictEqual(wallPlan.textOnlyAnnotations[0].text, '墙体厚度：\n280mm');

const sharedHeightPlan = buildDimensionRenderPlan({
  rules: sharedHeightRules.rules,
  doorStructure: analyzedDoor,
  imageSize
});
assert.strictEqual(sharedHeightPlan.lines.length, 3);
const sharedBottomYValues = new Set(sharedHeightPlan.lines.map((line) => line.to.y));
assert.strictEqual(sharedBottomYValues.size, 1);
assert.strictEqual([...sharedBottomYValues][0], analyzedDoor.keypoints.doorBottomY);
assert.strictEqual(new Set(sharedHeightPlan.lines.map((line) => line.from.x)).size, 3);
assert.strictEqual(sharedHeightPlan.extensionLines.length, 6);
assert(sharedHeightPlan.texts.every((text) => text.rotation === -90));

for (const text of openingWidthPlan.texts.concat(twoWidthPlan.texts).concat(sharedHeightPlan.texts)) {
  assert(text.text.includes('mm'), `render text missing mm: ${text.text}`);
}
for (const annotation of wallPlan.textOnlyAnnotations) {
  assert(annotation.text.includes('mm'), `text-only annotation missing mm: ${annotation.text}`);
}

assert(twoWidthPlan.debug.boundaries.some((boundary) => (
  boundary.box === 'openingEdgeTrimMidline' &&
  boundary.boundaryMode === 'edgeTrimMidline' &&
  boundary.from.value === 120 &&
  boundary.to.value === 880
)));
assert(twoWidthPlan.debug.boundaries.some((boundary) => (
  boundary.box === 'visibleOpening' &&
  boundary.from.value === 160 &&
  boundary.to.value === 840
)));
assert(!twoWidthPlan.debug.boundaries.some((boundary) => boundary.box === 'shadowRegions'));
assert.strictEqual(twoWidthPlan.debug.shadowRegionsIgnored, true);

const rendererInputRules = buildDimensionRules({
  doorType: 'single',
  viewSide: 'front',
  inputs: {
    openingWidth: '980',
    visibleOpeningWidth: '900',
    wallThickness: '280'
  },
  doorStructure: analyzedDoor
});
const rendererPlan = buildDimensionRenderPlan({
  rules: rendererInputRules.rules,
  doorStructure: analyzedDoor,
  imageSize
});
const fallbackRenderResult = await renderDimensionAnnotation({
  imageUrl: 'mock://door.png',
  renderPlan: rendererPlan,
  whiteBackground: false
});
assert.strictEqual(fallbackRenderResult.rendererType, 'frontend-render-plan');
assert.strictEqual(fallbackRenderResult.metadata.whiteBackground, false);
assert.strictEqual(fallbackRenderResult.metadata.lineCount, 2);
assert.strictEqual(fallbackRenderResult.metadata.textCount, 2);
assert.strictEqual(fallbackRenderResult.metadata.textOnlyCount, 1);
assert.strictEqual(rendererPlan.lines.length, 2);
assert.strictEqual(rendererPlan.texts.length, 2);
assert.strictEqual(rendererPlan.textOnlyAnnotations.length, 1);
for (const text of rendererPlan.texts) {
  assert(text.text.includes('mm'), `renderer plan text missing mm: ${text.text}`);
}
assert(rendererPlan.textOnlyAnnotations[0].text.includes('mm'));
assert(fallbackRenderResult.svgOverlay.includes('980mm'));
assert(fallbackRenderResult.svgOverlay.includes('900mm'));
assert(fallbackRenderResult.svgOverlay.includes('墙体厚度：'));

const whiteBackgroundRenderResult = await renderDimensionAnnotation({
  renderPlan: rendererPlan,
  whiteBackground: true
});
assert.strictEqual(whiteBackgroundRenderResult.metadata.whiteBackground, true);
assert(['frontend-render-plan', 'sharp-svg-overlay'].includes(whiteBackgroundRenderResult.rendererType));
if (whiteBackgroundRenderResult.resultBuffer) {
  assert(Buffer.isBuffer(whiteBackgroundRenderResult.resultBuffer));
  assert(whiteBackgroundRenderResult.resultBuffer.length > 0);
}

const validValidation = validateDimensionAnnotation({
  inputs: {
    openingWidth: '980',
    visibleOpeningWidth: '900',
    wallThickness: '280'
  },
  rules: rendererInputRules.rules,
  renderPlan: rendererPlan,
  resultImageUrl: '',
  metadata: {
    doorType: 'single',
    viewSide: 'front',
    whiteBackground: false,
    heightBottomMode: 'shared'
  }
});
assert.strictEqual(validValidation.passed, true);
assert.strictEqual(validValidation.metadata.renderPlanChecked, true);

const missingMmRenderPlan = {
  ...openingWidthPlan,
  texts: [
    {
      ...openingWidthPlan.texts[0],
      text: '门洞宽：980'
    }
  ]
};
const missingMmValidation = validateDimensionAnnotation({
  inputs: { openingWidth: '980' },
  rules: openingWidthPlanRules.rules,
  renderPlan: missingMmRenderPlan,
  metadata: {
    doorType: 'single',
    viewSide: 'front',
    whiteBackground: false,
    heightBottomMode: 'shared'
  }
});
assert.strictEqual(missingMmValidation.passed, false);
assert(missingMmValidation.issues.some((issue) => /missing mm/i.test(issue.message)));

const extraFieldRenderPlan = {
  ...openingWidthPlan,
  texts: openingWidthPlan.texts.concat({
    id: 'text-extra',
    field: 'visibleOpeningWidth',
    text: '见光宽：900mm',
    position: { x: 500, y: 990 },
    align: 'center',
    baseline: 'bottom'
  })
};
const extraFieldValidation = validateDimensionAnnotation({
  inputs: { openingWidth: '980' },
  rules: openingWidthPlanRules.rules,
  renderPlan: extraFieldRenderPlan,
  metadata: {
    doorType: 'single',
    viewSide: 'front',
    whiteBackground: false,
    heightBottomMode: 'shared'
  }
});
assert.strictEqual(extraFieldValidation.passed, false);
assert(extraFieldValidation.issues.some((issue) => issue.field === 'visibleOpeningWidth'));

const wallLineValidation = validateDimensionAnnotation({
  inputs: { wallThickness: '280' },
  rules: wallOnly.rules,
  renderPlan: {
    lines: [{
      id: 'line-wallThickness',
      field: 'wallThickness',
      from: { x: 1, y: 1 },
      to: { x: 2, y: 2 },
      orientation: 'horizontal',
      label: '墙体厚度',
      value: 280,
      unit: 'mm',
      textId: 'text-wallThickness',
      arrowIds: []
    }],
    texts: [],
    arrows: [],
    textOnlyAnnotations: wallPlan.textOnlyAnnotations,
    debug: { boundaries: [] }
  },
  metadata: {
    doorType: 'single',
    viewSide: 'front',
    whiteBackground: false,
    heightBottomMode: 'shared'
  }
});
assert.strictEqual(wallLineValidation.passed, false);
assert(wallLineValidation.issues.some((issue) => issue.field === 'wallThickness'));

const brokenSharedHeightPlan = {
  ...sharedHeightPlan,
  lines: sharedHeightPlan.lines.map((line, index) => index === 1
    ? {
        ...line,
        to: {
          ...line.to,
          y: line.to.y + 10
        }
      }
    : line)
};
const brokenSharedHeightValidation = validateDimensionAnnotation({
  inputs: {
    openingHeight: '2100',
    visibleOpeningHeight: '2050',
    withEdgeTrimHeight: '2200'
  },
  rules: sharedHeightRules.rules,
  renderPlan: brokenSharedHeightPlan,
  metadata: {
    doorType: 'single',
    viewSide: 'front',
    whiteBackground: false,
    heightBottomMode: 'shared'
  }
});
assert.strictEqual(brokenSharedHeightValidation.passed, false);
assert(brokenSharedHeightValidation.issues.some((issue) => /bottomY/.test(issue.message)));

const pipelineResult = await runDimensionAnnotationPipeline({
  taskType: TaskType.DIMENSION_ANNOTATION,
  doorType: '单开门',
  dimensionViewSide: 'front',
  dimensionValues: {
    openingWidth: '980',
    wallThickness: '280'
  },
  imageSize,
  dimensionWhiteBackground: true
});
assert.strictEqual(pipelineResult.status, JobStatus.SUCCEEDED);
assert.strictEqual(pipelineResult.succeeded, true);
assert.strictEqual(pipelineResult.validation.passed, true);
assert.strictEqual(pipelineResult.metadata.whiteBackground, true);
assert(pipelineResult.metadata.doorStructure);
assert(pipelineResult.metadata.doorStructure.boxes.opening);
assert(Array.isArray(pipelineResult.metadata.rules));
assert(pipelineResult.metadata.rules.some((rule) => rule.field === 'openingWidth'));
assert.strictEqual(pipelineResult.renderPlan.lines.length, 1);
assert.strictEqual(pipelineResult.renderPlan.textOnlyAnnotations.length, 1);
assert(['frontend-render-plan', 'sharp-svg-overlay'].includes(pipelineResult.rendererType));

clearJobsForTest();
clearArtifactsForTest();

const whiteBackgroundCompatJob = createJob({
  taskType: TaskType.DIMENSION_ANNOTATION,
  doorType: '单开门',
  viewSide: 'front',
  inputs: {
    openingWidth: '980'
  },
  imageUrl: 'mock://door.png',
  imageSize,
  backgroundInfo: '背景改为白板'
});
assert.strictEqual(whiteBackgroundCompatJob.whiteBackground, true);

const createdJob = createJob({
  taskType: TaskType.DIMENSION_ANNOTATION,
  doorType: '单开门',
  viewSide: 'front',
  inputs: {
    openingWidth: '980',
    wallThickness: '280'
  },
  imageUrl: 'mock://door.png',
  imageSize,
  whiteBackground: true
});
assert(createdJob.jobId);
assert.strictEqual(createdJob.status, JobStatus.CREATED);
assert.strictEqual(createdJob.retryCount, 0);

const completedJob = await runJob(createdJob.jobId);
assert.strictEqual(completedJob.jobId, createdJob.jobId);
assert.strictEqual(completedJob.status, JobStatus.SUCCEEDED);
assert.strictEqual(completedJob.progress, 100);
assert.strictEqual(completedJob.retryCount, 0);
assert.strictEqual(completedJob.error, null);
assert.strictEqual(completedJob.result.succeeded, true);
assert.strictEqual(completedJob.metadata.whiteBackground, true);
assert(completedJob.result.artifacts.some((artifact) => artifact.type === 'renderPlan'));
assert(completedJob.metadata.events.some((event) => event.status === JobStatus.ANALYZING));

const artifactCountAfterFirstRun = listArtifactsForJob(createdJob.jobId).length;
const completedJobAgain = await runJob(createdJob.jobId);
assert.strictEqual(completedJobAgain.status, JobStatus.SUCCEEDED);
assert.strictEqual(completedJobAgain.metadata.idempotent, true);
assert.strictEqual(listArtifactsForJob(createdJob.jobId).length, artifactCountAfterFirstRun);

const queriedJob = getJob(createdJob.jobId);
assert.strictEqual(queriedJob.jobId, createdJob.jobId);
assert.strictEqual(queriedJob.status, JobStatus.SUCCEEDED);
assert(Array.isArray(queriedJob.metadata.artifacts));

const unsupportedJob = createJob({
  taskType: 'unknown-task',
  inputs: {}
});
const failedJob = await runJob(unsupportedJob.jobId);
assert.strictEqual(failedJob.status, JobStatus.FAILED);
assert.strictEqual(failedJob.error.errorCode, ErrorCode.VALIDATION_FAILED);
assert.strictEqual(failedJob.error.stage, 'dispatch');

const legacyPipelineResult = await runPipeline({
  jobId: 'legacy_job',
  taskType: TaskType.PARTS_COMPOSE
});
assert.strictEqual(legacyPipelineResult.status, JobStatus.SUCCEEDED);
assert.strictEqual(legacyPipelineResult.legacy, true);
assert.strictEqual(legacyPipelineResult.metadata.legacyAdapter, true);

const legacyJob = createJob({
  taskType: TaskType.PARTS_COMPOSE,
  doorType: '双开门'
});
const completedLegacyJob = await runJob(legacyJob.jobId);
assert.strictEqual(completedLegacyJob.status, JobStatus.SUCCEEDED);
assert.strictEqual(completedLegacyJob.result.legacy, true);
assert.strictEqual(completedLegacyJob.metadata.legacyAdapter, true);

console.log('domain schema validation passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
