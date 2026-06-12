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
  buildDoorStructureRefinementPrompt
} = require('../src/door/prompts');
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
  normalizeTaskType,
  shouldUseDirectBackgroundComposite,
  inferLockMaskBox,
  getReferenceStylePrompt,
  normalizeDimensionBoxes,
  getImageModelCandidatesForInput,
  shouldUseGlobalEditForHandleReference
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
assert(DoorStructureShape.dimensionAnchors);
assert.strictEqual(Object.prototype.hasOwnProperty.call(DoorStructureShape.dimensionAnchors, 'doorTrimConnection'), true);
assert.strictEqual(Object.prototype.hasOwnProperty.call(DoorStructureShape.dimensionAnchors, 'openingMidline'), true);
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
    Object.freeze({ slotId: 'color-sample', originalImageFileID: 'cloud://mock/color.png' }),
    Object.freeze({ slotId: 'left-leaf-detail', originalImageFileID: 'cloud://mock/left.png' }),
    Object.freeze({ slotId: 'right-leaf-detail', originalImageFileID: 'cloud://mock/right.png' }),
    Object.freeze({ slotId: 'middle-join-detail', originalImageFileID: 'cloud://mock/join.png' })
  ])
});

assert.deepStrictEqual(getImageModelCandidatesForInput(['full-door'], {
  primaryModel: 'dall-e-2',
  fallbackModels: ['gpt-image-1']
}), ['dall-e-2', 'gpt-image-1']);
assert.deepStrictEqual(getImageModelCandidatesForInput(['full-door', 'handle-detail'], {
  primaryModel: 'dall-e-2',
  fallbackModels: ['gpt-image-1']
}), ['gpt-image-1']);
assert.deepStrictEqual(getImageModelCandidatesForInput(['full-door', 'handle-detail'], {
  primaryModel: 'dall-e-2',
  fallbackModels: []
}), []);
assert.strictEqual(shouldUseGlobalEditForHandleReference({
  detailReferences: [{ slotId: 'handle-detail' }],
  hasBackgroundReference: false
}), false);
assert.strictEqual(shouldUseGlobalEditForHandleReference({
  detailReferences: [{ slotId: 'handle-detail' }, { slotId: 'lock-detail' }],
  hasBackgroundReference: false
}), true);
assert.strictEqual(shouldUseGlobalEditForHandleReference({
  detailReferences: [{ slotId: 'handle-detail' }],
  hasBackgroundReference: true
}), true);

assert.strictEqual(normalizeTaskType(multiPartPromptJob), 'parts-compose');
const multiPartDecision = getPromptDecisionSummary(multiPartPromptJob);
assert.strictEqual(multiPartDecision.hasColorSample, true);
assert.strictEqual(multiPartDecision.colorSampleAppliesToEdgeTrim, true);
assert.strictEqual(multiPartDecision.hasUploadedEdgeTrimDetail, true);
assert.strictEqual(multiPartDecision.hasEffectiveEdgeTrimDetail, false);
assert.strictEqual(multiPartDecision.hasHeaderColumnDetail, true);
assert.strictEqual(multiPartDecision.hasGlassGrilleDetail, true);
assert.strictEqual(multiPartDecision.userWantsIndependentHeaderColumnColor, false);
assert.strictEqual(multiPartDecision.colorSampleAppliesToHeaderColumn, true);
assert.strictEqual(multiPartDecision.glassGrilleColorIsLocalOnly, true);
const multiPartPrompt = buildDoorImageInstruction(multiPartPromptJob, null, null, [
  { slotId: 'header-column-detail', label: '门头/门柱', color: '深灰色', applyDescription: '迁移门头门柱结构' },
  { slotId: 'edge-trim-detail', label: '包边', color: '红棕色', applyDescription: '迁移包边结构' },
  { slotId: 'glass-grille-detail', label: '气窗', color: '灰玻', applyDescription: '迁移气窗格栅' },
  { slotId: 'color-sample', label: '门体颜色', color: '浅木色', colorFamily: '木色', applyDescription: '统一浅木色' },
  { slotId: 'left-leaf-detail', label: '左门扇细节', structure: '左门扇竖向细压线', applyDescription: '融合左门扇竖向细压线' },
  { slotId: 'right-leaf-detail', label: '右门扇细节', structure: '右门扇玻璃格栅', applyDescription: '融合右门扇玻璃格栅' },
  { slotId: 'middle-join-detail', label: '中缝/拼接细节', structure: '窄中缝压条', applyDescription: '融合窄中缝压条' }
], null);
assert(multiPartPrompt.includes('结构化强制任务清单'));
assert(multiPartPrompt.includes('门头/门柱覆盖包边规则'));
assert(multiPartPrompt.includes('把手'));
assert(multiPartPrompt.includes('气窗'));
assert(multiPartPrompt.includes('门头/门柱'));
assert(multiPartPrompt.includes('整门颜色'));
assert(multiPartPrompt.includes('左门扇细节：必须'));
assert(multiPartPrompt.includes('右门扇细节：必须'));
assert(multiPartPrompt.includes('中缝/拼接细节：必须'));
assert(multiPartPrompt.includes('系统识别到左门扇细节'));
assert(multiPartPrompt.includes('系统识别到右门扇细节'));
assert(multiPartPrompt.includes('系统识别到中缝/拼接细节'));
assert(multiPartPrompt.includes('结构化需求确认：客户上传了左门扇细节图'));
assert(multiPartPrompt.includes('结构化需求确认：客户上传了右门扇细节图'));
assert(multiPartPrompt.includes('结构化需求确认：客户上传了中缝/拼接细节图'));
assert(multiPartPrompt.includes('左/右/小门扇细节层和中缝/拼接层仅在上传对应参考图时改对应区域'));
assert(multiPartPrompt.includes('门部件拼接效果图默认白板背景'));
assert(multiPartPrompt.includes('最终颜色覆盖自检'));
assert(multiPartPrompt.includes('门头/门柱/外框装饰必须先按门头/门柱参考图处理结构，再被颜色参考图统一校色'));
assert(!multiPartPrompt.includes('系统识别到包边参考图特征'));
assert(!multiPartPrompt.includes('包边：必须识别包边参考图'));

const headerOverridesIndependentEdgeTrimJob = Object.freeze({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '双开门',
  requirement: '门头门柱按参考图，包边按包边参考图颜色，门体按颜色参考图',
  referenceImages: Object.freeze([
    Object.freeze({ slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' }),
    Object.freeze({ slotId: 'header-column-detail', originalImageFileID: 'cloud://mock/header.png' }),
    Object.freeze({ slotId: 'edge-trim-detail', originalImageFileID: 'cloud://mock/edge.png', colorMode: 'reference' }),
    Object.freeze({ slotId: 'color-sample', originalImageFileID: 'cloud://mock/color.png' })
  ])
});
const headerOverridesIndependentEdgeTrimDecision = getPromptDecisionSummary(headerOverridesIndependentEdgeTrimJob);
assert.strictEqual(headerOverridesIndependentEdgeTrimDecision.hasUploadedEdgeTrimDetail, true);
assert.strictEqual(headerOverridesIndependentEdgeTrimDecision.hasEffectiveEdgeTrimDetail, false);
assert.strictEqual(headerOverridesIndependentEdgeTrimDecision.ignoredEdgeTrimBecauseHeaderColumn, true);
assert.strictEqual(headerOverridesIndependentEdgeTrimDecision.userWantsIndependentEdgeTrimColor, true);
assert.strictEqual(headerOverridesIndependentEdgeTrimDecision.edgeTrimColorProtectedFromColorSample, false);
assert.strictEqual(headerOverridesIndependentEdgeTrimDecision.colorSampleAppliesToEdgeTrim, true);
const headerOverridesIndependentEdgeTrimPrompt = buildDoorImageInstruction(headerOverridesIndependentEdgeTrimJob, null, null, [
  { slotId: 'header-column-detail', label: '门头/门柱', color: '深灰色', applyDescription: '迁移门头门柱结构' },
  { slotId: 'edge-trim-detail', label: '包边', color: '红棕色', applyDescription: '迁移包边结构' },
  { slotId: 'color-sample', label: '门体颜色', color: '浅木色', colorFamily: '木色', applyDescription: '统一浅木色' }
], null);
assert(headerOverridesIndependentEdgeTrimPrompt.includes('门头/门柱覆盖包边规则'));
assert(!headerOverridesIndependentEdgeTrimPrompt.includes('包边颜色独立意图解释'));
assert(!headerOverridesIndependentEdgeTrimPrompt.includes('包边：必须识别包边参考图'));

const independentHeaderColorJob = Object.freeze({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '双开门',
  requirement: '门头门柱按参考图颜色，门体按颜色参考图',
  referenceImages: Object.freeze([
    Object.freeze({ slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' }),
    Object.freeze({ slotId: 'header-column-detail', originalImageFileID: 'cloud://mock/header.png' }),
    Object.freeze({ slotId: 'color-sample', originalImageFileID: 'cloud://mock/color.png' })
  ])
});
const independentHeaderDecision = getPromptDecisionSummary(independentHeaderColorJob);
assert.strictEqual(independentHeaderDecision.hasHeaderColumnDetail, true);
assert.strictEqual(independentHeaderDecision.hasColorSample, true);
assert.strictEqual(independentHeaderDecision.userWantsIndependentHeaderColumnColor, true);
assert.strictEqual(independentHeaderDecision.headerColumnColorProtectedFromColorSample, true);
assert.strictEqual(independentHeaderDecision.colorSampleAppliesToHeaderColumn, false);
const independentHeaderPrompt = buildDoorImageInstruction(independentHeaderColorJob, null, null, [
  { slotId: 'header-column-detail', label: '门头/门柱', color: '深灰色', applyDescription: '迁移门头门柱结构和参考色' },
  { slotId: 'color-sample', label: '门体颜色', color: '浅木色', colorFamily: '木色', applyDescription: '统一门体浅木色' }
], null);
assert(!independentHeaderPrompt.includes('最高优先级门头/门柱同色规则'));
assert(independentHeaderPrompt.includes('门头/门柱参考图中的颜色只允许作用到门头/门柱/外框装饰自身'));
assert(independentHeaderPrompt.includes('颜色参考图是最终颜色层来源'));

const motherChildPrompt = buildDoorImageInstruction({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '子母门',
  requirement: '小门扇按参考图，中缝按参考图',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'child-leaf-detail', originalImageFileID: 'cloud://mock/child.png' },
    { slotId: 'middle-join-detail', originalImageFileID: 'cloud://mock/join.png' }
  ]
}, null, null, [
  { slotId: 'child-leaf-detail', label: '小门扇细节', structure: '小门扇窄框压线', applyDescription: '融合小门扇窄框压线' },
  { slotId: 'middle-join-detail', label: '中缝/拼接细节', structure: '子母门止口中缝', applyDescription: '融合子母门止口中缝' }
], null);
assert(motherChildPrompt.includes('小门扇细节：必须'));
assert(motherChildPrompt.includes('中缝/拼接细节：必须'));
assert(motherChildPrompt.includes('系统识别到小门扇细节'));
assert(motherChildPrompt.includes('结构化需求确认：客户上传了小门扇细节图'));
assert(motherChildPrompt.includes('不能把子母比例改成平分门'));

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
assert.strictEqual(shouldUseDirectBackgroundComposite({
  taskType: 'scene-effect',
  requirement: '',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'background-reference', originalImageFileID: 'cloud://mock/background.jpg' }
  ]
}), true);
assert.strictEqual(shouldUseDirectBackgroundComposite({
  taskType: 'parts-compose',
  requirement: '',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'background-reference', originalImageFileID: 'cloud://mock/background.jpg' }
  ]
}), false);
assert.strictEqual(shouldUseDirectBackgroundComposite({
  taskType: 'scene-effect',
  targetParts: ['background', 'lock'],
  requirement: '',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'background-reference', originalImageFileID: 'cloud://mock/background.jpg' }
  ]
}), false);
assert.strictEqual(shouldUseDirectBackgroundComposite({
  taskType: 'scene-effect',
  requirement: '',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'background-reference', originalImageFileID: 'cloud://mock/background.jpg' },
    { slotId: 'lock-detail', originalImageFileID: 'cloud://mock/lock.png' }
  ]
}), false);
assert.strictEqual(shouldUseDirectBackgroundComposite({
  taskType: 'scene-effect',
  requirement: '背景按参考图，门体颜色改成浅木色，智能锁也换掉',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'background-reference', originalImageFileID: 'cloud://mock/background.jpg' }
  ]
}), false);

const backgroundLockColorJob = {
  taskType: 'scene-effect',
  templateType: '场景效果图',
  doorType: '双开门',
  targetParts: ['background', 'lock', 'door-color'],
  requirement: '背景按参考图，门体颜色按色卡，智能锁也换掉',
  referenceImages: [
    { slotId: 'background-reference', originalImageFileID: 'cloud://mock/background.jpg' },
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'lock-detail', originalImageFileID: 'cloud://mock/lock.png' },
    { slotId: 'color-sample', originalImageFileID: 'cloud://mock/color.png' }
  ]
};
assert.strictEqual(shouldUseDirectBackgroundComposite(backgroundLockColorJob), false);
const backgroundLockColorDecision = getPromptDecisionSummary(backgroundLockColorJob);
assert.strictEqual(backgroundLockColorDecision.hasBackgroundReference, true);
assert.strictEqual(backgroundLockColorDecision.hasColorSample, true);
assert.strictEqual(backgroundLockColorDecision.allowDoorSurfaceColorChange, true);
const backgroundLockColorPrompt = buildDoorImageInstruction(backgroundLockColorJob, {
  source: 'background-doorway-test',
  left: 120,
  top: 80,
  right: 860,
  bottom: 980
}, null, [
  { slotId: 'background-reference', label: '背景', applyDescription: '以背景门位为最终画布' },
  { slotId: 'lock-detail', label: '锁体/智能锁', lockIntegrationType: 'standalone', hasSmartLockPanel: true, applyDescription: '替换智能锁' },
  { slotId: 'color-sample', label: '颜色', color: '浅木色', colorFamily: '木色', applyDescription: '统一浅木色' }
], null);
assert(backgroundLockColorPrompt.includes('输入图1是背景参考图'));
assert(backgroundLockColorPrompt.includes('输入图2是整门上下文图'));
assert(backgroundLockColorPrompt.includes('最终结果应等于：输入图1背景底图 + 输入图2整门抠图贴入输入图1的 mask 门位区域'));
assert(backgroundLockColorPrompt.includes('锁体/智能锁：必须'));
assert(backgroundLockColorPrompt.includes('结构化需求确认：客户上传了锁体/智能锁细节图'));
assert(backgroundLockColorPrompt.includes('结构化需求确认：客户上传了颜色参考图'));
assert(backgroundLockColorPrompt.includes('锁体/智能锁按 lock-detail 参考图执行替换/融合'));
assert(backgroundLockColorPrompt.includes('不能因为背景、颜色、白底、把手或其他局部任务而跳过智能锁'));
assert(backgroundLockColorPrompt.includes('只贴门不换锁'));
assert(backgroundLockColorPrompt.includes('智能锁验收标准'));
assert(!backgroundLockColorPrompt.includes('也是唯一门体/门型/门色/五金来源'));

const backgroundLockOnlyPrompt = buildDoorImageInstruction({
  taskType: 'scene-effect',
  templateType: '场景效果图',
  doorType: '双开门',
  targetParts: ['background', 'lock'],
  requirement: '背景按参考图，智能锁换成参考图',
  referenceImages: [
    { slotId: 'background-reference', originalImageFileID: 'cloud://mock/background.jpg' },
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'lock-detail', originalImageFileID: 'cloud://mock/lock.png' }
  ]
}, {
  source: 'background-doorway-test',
  left: 120,
  top: 80,
  right: 860,
  bottom: 980
}, null, [
  { slotId: 'background-reference', label: '背景', applyDescription: '以背景门位为最终画布' },
  { slotId: 'lock-detail', label: '锁体/智能锁', lockIntegrationType: 'standalone', hasSmartLockPanel: true, hasRoundHole: true, applyDescription: '替换智能锁面板' }
], null);
assert(backgroundLockOnlyPrompt.includes('锁体/智能锁按 lock-detail 参考图执行替换/融合'));
assert(backgroundLockOnlyPrompt.includes('成图中锁体/智能锁安装区必须有清晰可见的新锁具核心特征'));
assert(backgroundLockOnlyPrompt.includes('背景已替换、颜色已改变或包边/把手已处理，但智能锁仍是原图旧锁'));
assert(!backgroundLockOnlyPrompt.includes('必须保留第一张图的门型、颜色、包边、把手、锁体、玻璃和材质'));

const backgroundStylePromptWithLock = getReferenceStylePrompt('background-reference', {
  hasLockDetail: true
});
assert(backgroundStylePromptWithLock.includes('锁体/智能锁由 lock-detail 参考图执行替换'));
assert(backgroundStylePromptWithLock.includes('不能在背景任务里要求保留原锁不变'));
assert(!backgroundStylePromptWithLock.includes('保持第一张整门图的门体、包边、把手、锁体、玻璃'));

const backgroundEdgeColorJob = {
  taskType: 'scene-effect',
  templateType: '场景效果图',
  doorType: '双开门',
  targetParts: ['background', 'edge-trim', 'door-color'],
  requirement: '背景按参考图，包边按包边参考图结构，门体和包边颜色按色卡统一',
  referenceImages: [
    { slotId: 'background-reference', originalImageFileID: 'cloud://mock/background.jpg' },
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'edge-trim-detail', originalImageFileID: 'cloud://mock/edge.png' },
    { slotId: 'color-sample', originalImageFileID: 'cloud://mock/color.png' }
  ]
};
assert.strictEqual(shouldUseDirectBackgroundComposite(backgroundEdgeColorJob), false);
const backgroundEdgeColorDecision = getPromptDecisionSummary(backgroundEdgeColorJob);
assert.strictEqual(backgroundEdgeColorDecision.hasBackgroundReference, true);
assert.strictEqual(backgroundEdgeColorDecision.hasEffectiveEdgeTrimDetail, true);
assert.strictEqual(backgroundEdgeColorDecision.colorSampleAppliesToEdgeTrim, true);
const backgroundEdgeColorPrompt = buildDoorImageInstruction(backgroundEdgeColorJob, {
  source: 'background-doorway-test',
  left: 120,
  top: 80,
  right: 860,
  bottom: 980
}, null, [
  { slotId: 'background-reference', label: '背景', applyDescription: '以背景门位为最终画布' },
  { slotId: 'edge-trim-detail', label: '包边', structure: '三层窄边压线', applyDescription: '迁移包边结构' },
  { slotId: 'color-sample', label: '颜色', color: '浅木色', colorFamily: '木色', applyDescription: '统一浅木色' }
], null);
assert(backgroundEdgeColorPrompt.includes('输入图1是背景参考图'));
assert(backgroundEdgeColorPrompt.includes('输入图2是整门上下文图'));
assert(backgroundEdgeColorPrompt.includes('包边：必须'));
assert(backgroundEdgeColorPrompt.includes('包边验收标准'));
assert(backgroundEdgeColorPrompt.includes('背景参考图只提供背景底图、目标门位、透视、接地和光影参考'));
assert(backgroundEdgeColorPrompt.includes('包边层只改包边结构'));
assert(backgroundEdgeColorPrompt.includes('颜色层默认统一整门可见门面颜色'));
assert(backgroundEdgeColorPrompt.includes('背景层只改背景'));
assert(backgroundEdgeColorPrompt.includes('最终结果应等于：输入图1背景底图 + 输入图2整门抠图贴入输入图1的 mask 门位区域'));

const backgroundHeaderIndependentPrompt = buildDoorImageInstruction({
  taskType: 'scene-effect',
  templateType: '场景效果图',
  doorType: '双开门',
  targetParts: ['background', 'header-column', 'door-color'],
  requirement: '背景按参考图，门体按色卡，门头门柱按参考图颜色',
  referenceImages: [
    { slotId: 'background-reference', originalImageFileID: 'cloud://mock/background.jpg' },
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'header-column-detail', originalImageFileID: 'cloud://mock/header.png' },
    { slotId: 'color-sample', originalImageFileID: 'cloud://mock/color.png' }
  ]
}, {
  source: 'background-doorway-test',
  left: 120,
  top: 80,
  right: 860,
  bottom: 980
}, null, [
  { slotId: 'background-reference', label: '背景', applyDescription: '以背景门位为最终画布' },
  { slotId: 'header-column-detail', label: '门头/门柱', color: '深灰色', applyDescription: '迁移门头结构' },
  { slotId: 'color-sample', label: '颜色', color: '浅木色', colorFamily: '木色', applyDescription: '统一浅木色' }
], null);
assert(backgroundHeaderIndependentPrompt.includes('背景参考图只提供背景底图、目标门位、透视、接地和光影参考'));
assert(backgroundHeaderIndependentPrompt.includes('门头/门柱：必须'));
assert(backgroundHeaderIndependentPrompt.includes('门头/门柱参考图中的颜色只允许作用到门头/门柱/外框装饰自身'));
assert(!backgroundHeaderIndependentPrompt.includes('最高优先级门头/门柱同色规则'));

const backgroundPanelGlassTextureColorJob = {
  taskType: 'scene-effect',
  templateType: '场景效果图',
  doorType: '单开门',
  targetParts: ['background'],
  requirement: '背景按参考图，门板造型、气窗、材质纹理和颜色都按参考图',
  referenceImages: [
    { slotId: 'background-reference', originalImageFileID: 'cloud://mock/background.jpg' },
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'panel-style-detail', originalImageFileID: 'cloud://mock/panel.png' },
    { slotId: 'glass-grille-detail', originalImageFileID: 'cloud://mock/glass.png' },
    { slotId: 'texture-reference', originalImageFileID: 'cloud://mock/texture.png' },
    { slotId: 'color-sample', originalImageFileID: 'cloud://mock/color.png' }
  ]
};
assert.strictEqual(shouldUseDirectBackgroundComposite(backgroundPanelGlassTextureColorJob), false);
const backgroundPanelGlassTextureColorPrompt = buildDoorImageInstruction(backgroundPanelGlassTextureColorJob, {
  source: 'background-doorway-test',
  left: 120,
  top: 80,
  right: 860,
  bottom: 980
}, null, [
  { slotId: 'background-reference', label: '背景', applyDescription: '以背景门位为最终画布' },
  { slotId: 'panel-style-detail', label: '门板线条/造型', structure: '窄边框压线', applyDescription: '迁移门板压线造型' },
  { slotId: 'glass-grille-detail', label: '气窗', structure: '上方格栅玻璃', applyDescription: '迁移气窗格栅' },
  { slotId: 'texture-reference', label: '材质纹理', material: '细木纹', applyDescription: '迁移细木纹质感' },
  { slotId: 'color-sample', label: '颜色', color: '浅木色', colorFamily: '木色', applyDescription: '统一浅木色' }
], null);
assert(backgroundPanelGlassTextureColorPrompt.includes('输入图1是背景参考图'));
assert(backgroundPanelGlassTextureColorPrompt.includes('输入图2是整门上下文图'));
assert(backgroundPanelGlassTextureColorPrompt.includes('门板线条/造型：必须'));
assert(backgroundPanelGlassTextureColorPrompt.includes('气窗：必须'));
assert(backgroundPanelGlassTextureColorPrompt.includes('材质纹理：必须'));
assert(backgroundPanelGlassTextureColorPrompt.includes('结构化需求确认：客户上传了门板线条/造型细节图'));
assert(backgroundPanelGlassTextureColorPrompt.includes('结构化需求确认：客户上传了气窗细节图'));
assert(backgroundPanelGlassTextureColorPrompt.includes('结构化需求确认：客户上传了材质纹理参考图'));
assert(backgroundPanelGlassTextureColorPrompt.includes('结构化需求确认：客户上传了颜色参考图'));
assert(backgroundPanelGlassTextureColorPrompt.includes('以上任务是并列关系，不是互斥关系'));
assert(backgroundPanelGlassTextureColorPrompt.includes('不要只执行其中一个参考图任务后忽略其他已上传参考图'));
assert(backgroundPanelGlassTextureColorPrompt.includes('背景层只改背景'));
assert(backgroundPanelGlassTextureColorPrompt.includes('材质纹理参考图只控制纹理、木纹方向'));
assert(backgroundPanelGlassTextureColorPrompt.includes('颜色参考图仍是颜色层唯一来源'));

const textureOnlyNoColorDecision = getPromptDecisionSummary({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '单开门',
  targetParts: ['material-texture'],
  requirement: '只参考材质纹理，不改变门体颜色',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'texture-reference', originalImageFileID: 'cloud://mock/texture.png' }
  ]
});
assert.strictEqual(textureOnlyNoColorDecision.allowDoorSurfaceColorChange, false);
const textureOnlyNoColorPrompt = buildDoorImageInstruction({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '单开门',
  targetParts: ['material-texture'],
  requirement: '只参考材质纹理，不改变门体颜色',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'texture-reference', originalImageFileID: 'cloud://mock/texture.png' }
  ]
}, null, null, [
  { slotId: 'texture-reference', label: '材质纹理', color: '深棕色', material: '木纹', structure: '竖向细木纹', applyDescription: '迁移竖向细木纹' }
], null);
assert(textureOnlyNoColorPrompt.includes('材质纹理：必须'));
assert(textureOnlyNoColorPrompt.includes('材质纹理参考图默认不是颜色参考'));
assert(textureOnlyNoColorPrompt.includes('门体可见颜色仍按原整门图保持'));
assert(textureOnlyNoColorPrompt.includes('最高优先级门体颜色冻结'));

const textureWithColorSamplePrompt = buildDoorImageInstruction({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '单开门',
  targetParts: ['door-color', 'material-texture'],
  requirement: '颜色按色卡，纹理按材质参考图',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'color-sample', originalImageFileID: 'cloud://mock/color.png' },
    { slotId: 'texture-reference', originalImageFileID: 'cloud://mock/texture.png' }
  ]
}, null, null, [
  { slotId: 'color-sample', label: '门体颜色', color: '浅木色', colorFamily: '木色', applyDescription: '统一浅木色' },
  { slotId: 'texture-reference', label: '材质纹理', color: '深棕色', material: '木纹', structure: '竖向细木纹', applyDescription: '迁移竖向细木纹' }
], null);
assert(textureWithColorSamplePrompt.includes('整门颜色：默认必须按颜色参考图统一调整整门可见门面颜色'));
assert(textureWithColorSamplePrompt.includes('材质纹理：必须按材质纹理参考图处理门体表面的木纹'));
assert(textureWithColorSamplePrompt.includes('最终门体颜色必须以 color-sample 颜色参考图为准'));
assert(textureWithColorSamplePrompt.includes('颜色参考图仍是颜色层唯一来源'));
assert(textureWithColorSamplePrompt.includes('材质纹理参考图只控制纹理、木纹方向'));
assert(textureWithColorSamplePrompt.includes('不得覆盖或替代颜色参考图的主色'));

const structureOnlyNoColorDecision = getPromptDecisionSummary({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '单开门',
  targetParts: ['panel-style', 'glass-grille', 'material-texture'],
  requirement: '门板造型、气窗和材质纹理都按参考图',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'panel-style-detail', originalImageFileID: 'cloud://mock/panel.png' },
    { slotId: 'glass-grille-detail', originalImageFileID: 'cloud://mock/glass.png' },
    { slotId: 'texture-reference', originalImageFileID: 'cloud://mock/texture.png' }
  ]
});
assert.strictEqual(structureOnlyNoColorDecision.allowDoorSurfaceColorChange, false);

const localGlassColorNoDoorColorDecision = getPromptDecisionSummary({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '单开门',
  targetParts: ['glass-grille'],
  requirement: '气窗颜色按参考图，门体颜色不变',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'glass-grille-detail', originalImageFileID: 'cloud://mock/glass.png' }
  ]
});
assert.strictEqual(localGlassColorNoDoorColorDecision.allowDoorSurfaceColorChange, false);

const localPanelStyleColorNoDoorColorDecision = getPromptDecisionSummary({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '单开门',
  targetParts: ['panel-style'],
  requirement: '门板造型颜色按参考图，整门颜色不变',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'panel-style-detail', originalImageFileID: 'cloud://mock/panel.png' }
  ]
});
assert.strictEqual(localPanelStyleColorNoDoorColorDecision.allowDoorSurfaceColorChange, false);

const localEdgeTrimColorNoDoorColorDecision = getPromptDecisionSummary({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '单开门',
  targetParts: ['edge-trim'],
  requirement: '包边按包边参考图颜色，门体颜色不变',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'edge-trim-detail', originalImageFileID: 'cloud://mock/edge.png' }
  ]
});
assert.strictEqual(localEdgeTrimColorNoDoorColorDecision.userWantsIndependentEdgeTrimColor, true);
assert.strictEqual(localEdgeTrimColorNoDoorColorDecision.allowDoorSurfaceColorChange, false);

assert.strictEqual(getPromptDecisionSummary({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '单开门',
  targetParts: ['door-color'],
  requirement: '门体颜色改成浅木色',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' }
  ]
}).allowDoorSurfaceColorChange, true);

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

const handleWithIntegratedLockPrompt = buildDoorImageInstruction({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '双开门',
  requirement: '智能锁和把手都按参考图处理',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'handle-detail', originalImageFileID: 'cloud://mock/handle.png' },
    { slotId: 'lock-detail', originalImageFileID: 'cloud://mock/lock.png' }
  ]
}, null, {
  color: '金色',
  material: '金属',
  finish: '亮面',
  shape: '普通长拉手'
}, [
  { slotId: 'handle-detail', label: '门把手', color: '金色', material: '金属', shape: '普通长拉手', applyDescription: '替换普通把手' },
  {
    slotId: 'lock-detail',
    label: '锁体/智能锁',
    lockIntegrationType: 'handle-integrated',
    referenceContainsHandle: true,
    hasSmartLockPanel: true,
    handleCount: 1,
    applyDescription: '一体式智能锁把手整体替换'
  }
], null);
assert(handleWithIntegratedLockPrompt.includes('同一安装区域以 lock-detail 一体式把手锁为准'));
assert(handleWithIntegratedLockPrompt.includes('handle-detail 只可作用于未被智能锁占用的另一侧/非冲突把手'));
assert(handleWithIntegratedLockPrompt.includes('不得覆盖、拆散或弱化一体式智能锁'));
assert(handleWithIntegratedLockPrompt.includes('不得用 handle-detail 把一体式智能锁改回普通门把手'));
assert(!handleWithIntegratedLockPrompt.includes('门把手：必须按门把手细节图融合/替换'));

const handleWithStandaloneLockPrompt = buildDoorImageInstruction({
  taskType: 'parts-compose',
  templateType: '门部件拼接效果图',
  doorType: '双开门',
  requirement: '智能锁和把手都按参考图处理',
  referenceImages: [
    { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
    { slotId: 'handle-detail', originalImageFileID: 'cloud://mock/handle.png' },
    { slotId: 'lock-detail', originalImageFileID: 'cloud://mock/lock.png' }
  ]
}, null, {
  color: '金色',
  material: '金属',
  finish: '亮面',
  shape: '普通长拉手'
}, [
  { slotId: 'handle-detail', label: '门把手', color: '金色', material: '金属', shape: '普通长拉手', applyDescription: '替换普通把手' },
  {
    slotId: 'lock-detail',
    label: '锁体/智能锁',
    lockIntegrationType: 'standalone',
    hasSmartLockPanel: true,
    applyDescription: '替换独立智能锁面板'
  }
], null);
assert(handleWithStandaloneLockPrompt.includes('门把手：必须按门把手细节图融合/替换'));
assert(handleWithStandaloneLockPrompt.includes('锁体/智能锁：必须按锁体/智能锁细节图处理锁具'));
assert(!handleWithStandaloneLockPrompt.includes('不得用 handle-detail 把一体式智能锁改回普通门把手'));

const doubleDoorSingleLockFallback = inferLockMaskBox(
  { width: 1000, height: 1000 },
  Buffer.from('mock-lock'),
  { doorType: '双开门', requirement: '安装一个智能锁' }
);
assert(doubleDoorSingleLockFallback);
assert.strictEqual(doubleDoorSingleLockFallback.source, 'lock-right-leaf-heuristic');
assert(doubleDoorSingleLockFallback.left >= 500, 'single smart lock fallback must stay on one leaf near seam');
assert(doubleDoorSingleLockFallback.right <= 700, 'single smart lock fallback should not cover both handles');

const doubleDoorLeftLockFallback = inferLockMaskBox(
  { width: 1000, height: 1000 },
  Buffer.from('mock-lock'),
  { doorType: '双开门', requirement: '智能锁装到左门扇靠中缝' }
);
assert(doubleDoorLeftLockFallback);
assert.strictEqual(doubleDoorLeftLockFallback.source, 'lock-left-leaf-heuristic');
assert(doubleDoorLeftLockFallback.right <= 500, 'left smart lock fallback must stay on left leaf');

const doubleDoorBothSideLockFallback = inferLockMaskBox(
  { width: 1000, height: 1000 },
  Buffer.from('mock-lock'),
  { doorType: '双开门', requirement: '左右两侧都换双把手智能锁' }
);
assert(doubleDoorBothSideLockFallback);
assert.strictEqual(doubleDoorBothSideLockFallback.source, 'lock-center-heuristic-explicit-both-sides');
assert(doubleDoorBothSideLockFallback.left < 500 && doubleDoorBothSideLockFallback.right > 500);

const singleDoorIntegratedLockFallback = inferLockMaskBox(
  { width: 1000, height: 1000 },
  Buffer.from('mock-lock'),
  { doorType: '单开门', requirement: '安装智能锁' },
  {
    slotId: 'lock-detail',
    lockIntegrationType: 'handle-integrated',
    hasSmartLockPanel: true,
    handleCount: 1,
    applyDescription: '一体式智能锁把手'
  }
);
assert(singleDoorIntegratedLockFallback);
assert.strictEqual(singleDoorIntegratedLockFallback.source, 'lock-side-heuristic-handle-integrated');
assert(singleDoorIntegratedLockFallback.height > doubleDoorSingleLockFallback.height, 'integrated lock fallback should cover taller handle-lock area');

const doubleDoorReferenceDoubleHandleFallback = inferLockMaskBox(
  { width: 1000, height: 1000 },
  Buffer.from('mock-lock'),
  { doorType: '双开门', requirement: '安装参考图智能锁' },
  {
    slotId: 'lock-detail',
    lockIntegrationType: 'handle-integrated',
    hasSmartLockPanel: true,
    handleCount: 2,
    isDoubleHandle: true,
    applyDescription: '参考图是双把手智能锁'
  }
);
assert(doubleDoorReferenceDoubleHandleFallback);
assert.strictEqual(doubleDoorReferenceDoubleHandleFallback.source, 'lock-center-heuristic-reference-double-handle');
assert(doubleDoorReferenceDoubleHandleFallback.left < 500 && doubleDoorReferenceDoubleHandleFallback.right > 500);

const partPromptSlotChecks = Object.freeze({
  'handle-detail': Object.freeze(['门把手：必须', '结构化需求确认：客户上传了门把手细节图']),
  'edge-trim-detail': Object.freeze(['包边：必须', '结构化需求确认：客户上传了包边参考图']),
  'color-sample': Object.freeze(['结构化需求确认：客户上传了颜色参考图', '颜色参考图是']),
  'lock-detail': Object.freeze(['锁体/智能锁：必须', '结构化需求确认：客户上传了锁体/智能锁细节图']),
  'panel-style-detail': Object.freeze(['门板线条/造型：必须', '结构化需求确认：客户上传了门板线条/造型细节图']),
  'glass-grille-detail': Object.freeze(['气窗：必须', '结构化需求确认：客户上传了气窗细节图']),
  'header-column-detail': Object.freeze(['门头/门柱：必须', '结构化需求确认：客户上传了门头/门柱细节图', '门头/门柱覆盖包边规则']),
  'texture-reference': Object.freeze(['材质纹理：必须', '结构化需求确认：客户上传了材质纹理参考图']),
  'left-leaf-detail': Object.freeze(['左门扇细节：必须', '结构化需求确认：客户上传了左门扇细节图']),
  'right-leaf-detail': Object.freeze(['右门扇细节：必须', '结构化需求确认：客户上传了右门扇细节图']),
  'child-leaf-detail': Object.freeze(['小门扇细节：必须', '结构化需求确认：客户上传了小门扇细节图']),
  'middle-join-detail': Object.freeze(['中缝/拼接细节：必须', '结构化需求确认：客户上传了中缝/拼接细节图']),
  'background-reference': Object.freeze(['背景：必须', '结构化需求确认：客户上传了背景参考图'])
});

const frontendPartUploadSlots = Object.freeze({
  '单开门': Object.freeze([
    'handle-detail',
    'edge-trim-detail',
    'color-sample',
    'lock-detail',
    'panel-style-detail',
    'glass-grille-detail',
    'texture-reference'
  ]),
  '双开门': Object.freeze([
    'handle-detail',
    'edge-trim-detail',
    'color-sample',
    'lock-detail',
    'panel-style-detail',
    'glass-grille-detail',
    'header-column-detail',
    'texture-reference',
    'left-leaf-detail',
    'right-leaf-detail',
    'middle-join-detail'
  ]),
  '子母门': Object.freeze([
    'handle-detail',
    'edge-trim-detail',
    'color-sample',
    'lock-detail',
    'panel-style-detail',
    'glass-grille-detail',
    'texture-reference',
    'child-leaf-detail',
    'middle-join-detail'
  ]),
  '四开子母门': Object.freeze([
    'handle-detail',
    'edge-trim-detail',
    'color-sample',
    'lock-detail',
    'panel-style-detail',
    'glass-grille-detail',
    'texture-reference',
    'child-leaf-detail',
    'left-leaf-detail',
    'right-leaf-detail',
    'middle-join-detail'
  ]),
  '四开平分门': Object.freeze([
    'handle-detail',
    'edge-trim-detail',
    'color-sample',
    'lock-detail',
    'panel-style-detail',
    'glass-grille-detail',
    'texture-reference',
    'left-leaf-detail',
    'right-leaf-detail',
    'middle-join-detail'
  ]),
  '六开门': Object.freeze([
    'handle-detail',
    'edge-trim-detail',
    'color-sample',
    'lock-detail',
    'panel-style-detail',
    'glass-grille-detail',
    'texture-reference',
    'left-leaf-detail',
    'right-leaf-detail',
    'middle-join-detail'
  ])
});

function makeMockReferenceStyle(slotId) {
  return {
    slotId,
    label: slotId,
    sourceType: 'mock',
    color: 'mock-color',
    colorFamily: 'mock-family',
    material: 'mock-material',
    finish: 'mock-finish',
    shape: 'mock-shape',
    structure: 'mock-structure',
    profile: 'mock-profile',
    edge: 'mock-edge',
    details: 'mock-details',
    applyDescription: `apply ${slotId}`,
    lockIntegrationType: slotId === 'lock-detail' ? 'standalone' : undefined,
    hasSmartLockPanel: slotId === 'lock-detail' ? true : undefined,
    hasRoundHole: slotId === 'lock-detail' ? true : undefined
  };
}

function buildPartPromptForSlots({ doorType, slotIds, taskType = 'parts-compose' }) {
  const isSceneEffect = taskType === 'scene-effect';
  return buildDoorImageInstruction({
    taskType,
    sceneId: isSceneEffect ? 'scene-effect' : 'home-effect',
    templateType: isSceneEffect ? '场景效果图' : '门部件拼接效果图',
    doorType,
    requirement: 'slot coverage regression',
    referenceImages: [
      { slotId: 'full-door', originalImageFileID: 'cloud://mock/full-door.png' },
      ...slotIds.map((slotId) => ({ slotId, originalImageFileID: `cloud://mock/${slotId}.png` }))
    ]
  }, slotIds.includes('background-reference')
    ? { source: 'background-doorway-test', left: 100, top: 100, right: 900, bottom: 980 }
    : null, null, slotIds.map(makeMockReferenceStyle), null);
}

for (const [doorType, slotIds] of Object.entries(frontendPartUploadSlots)) {
  for (const slotId of slotIds) {
    const prompt = buildPartPromptForSlots({ doorType, slotIds: [slotId] });
    for (const expectedText of partPromptSlotChecks[slotId] || []) {
      assert(prompt.includes(expectedText), `${doorType} single slot ${slotId} missing prompt text: ${expectedText}`);
    }
  }

  const prompt = buildPartPromptForSlots({ doorType, slotIds });
  assert(prompt.includes('以上任务是并列关系，不是互斥关系'), `${doorType} missing parallel task instruction`);
  assert(prompt.includes('不要只执行其中一个参考图任务后忽略其他已上传参考图'), `${doorType} missing multi-reference no-ignore instruction`);
  for (const slotId of slotIds) {
    if (slotId === 'edge-trim-detail' && slotIds.includes('header-column-detail')) {
      assert(prompt.includes('门头/门柱覆盖包边规则'), `${doorType} missing header-column edge-trim override instruction`);
      assert(!prompt.includes('包边：必须'), `${doorType} should suppress separate edge-trim task when header-column is uploaded`);
      continue;
    }
    for (const expectedText of partPromptSlotChecks[slotId] || []) {
      assert(prompt.includes(expectedText), `${doorType} combo slot ${slotId} missing prompt text: ${expectedText}`);
    }
  }
}

const sceneEffectBackgroundPrompt = buildPartPromptForSlots({
  doorType: '单开门',
  slotIds: ['background-reference'],
  taskType: 'scene-effect'
});
for (const expectedText of partPromptSlotChecks['background-reference']) {
  assert(sceneEffectBackgroundPrompt.includes(expectedText), `scene-effect background prompt missing: ${expectedText}`);
}
assert(sceneEffectBackgroundPrompt.includes('输入顺序强约束'));
assert(sceneEffectBackgroundPrompt.includes('输入图1背景底图 + 输入图2整门抠图贴入输入图1的 mask 门位区域'));

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

const dimensionBoxTestSize = Object.freeze({ width: 1000, height: 1000 });
const legacyBothDimensionBoxes = normalizeDimensionBoxes({
  outerTrimBox: { left: 80, top: 70, right: 920, bottom: 960 },
  openingMidlineBox: { left: 300, top: 300, right: 700, bottom: 940 },
  visibleOpeningBox: { left: 160, top: 150, right: 840, bottom: 940 },
  doorBottomY: 950,
  heightBottomMode: 'shared'
}, dimensionBoxTestSize, {
  hasDoorOpeningRequest: true,
  hasVisibleOpeningRequest: true
});
assert.strictEqual(legacyBothDimensionBoxes.openingMidlineBox.left, 120);
assert.strictEqual(legacyBothDimensionBoxes.openingMidlineBox.top, 110);
assert.strictEqual(legacyBothDimensionBoxes.openingMidlineBox.right, 880);
assert.strictEqual(legacyBothDimensionBoxes.openingMidlineBox.source, 'dimension-opening-request-aware-midline');

const legacyOpeningOnlyDimensionBoxes = normalizeDimensionBoxes({
  outerTrimBox: { left: 80, top: 70, right: 920, bottom: 960 },
  openingMidlineBox: { left: 120, top: 110, right: 880, bottom: 940 },
  visibleOpeningBox: { left: 160, top: 150, right: 840, bottom: 940 },
  doorBottomY: 950,
  heightBottomMode: 'shared'
}, dimensionBoxTestSize, {
  hasDoorOpeningRequest: true,
  hasVisibleOpeningRequest: false
});
assert.strictEqual(legacyOpeningOnlyDimensionBoxes.openingMidlineBox.left, 160);
assert.strictEqual(legacyOpeningOnlyDimensionBoxes.openingMidlineBox.top, 150);
assert.strictEqual(legacyOpeningOnlyDimensionBoxes.openingMidlineBox.right, 840);
assert.strictEqual(legacyOpeningOnlyDimensionBoxes.openingMidlineBox.source, 'dimension-opening-door-trim-connection');

const legacyAiAnchoredDimensionBoxes = normalizeDimensionBoxes({
  outerTrimBox: { left: 80, top: 70, right: 920, bottom: 960 },
  doorTrimConnectionBox: { left: 158, top: 148, right: 842, bottom: 940 },
  openingMidlineBox: { left: 124, top: 108, right: 876, bottom: 940 },
  visibleOpeningBox: { left: 160, top: 150, right: 840, bottom: 940 },
  doorBottomY: 950,
  heightBottomMode: 'shared'
}, dimensionBoxTestSize, {
  hasDoorOpeningRequest: true,
  hasVisibleOpeningRequest: true
});
assert.strictEqual(legacyAiAnchoredDimensionBoxes.openingMidlineBox.left, 124);
assert.strictEqual(legacyAiAnchoredDimensionBoxes.openingMidlineBox.top, 108);
assert.strictEqual(legacyAiAnchoredDimensionBoxes.openingMidlineBox.right, 876);
assert.strictEqual(legacyAiAnchoredDimensionBoxes.openingMidlineBox.source, 'dimension-opening-ai-midline');

const legacyAiOpeningOnlyDimensionBoxes = normalizeDimensionBoxes({
  outerTrimBox: { left: 80, top: 70, right: 920, bottom: 960 },
  doorTrimConnectionBox: { left: 158, top: 148, right: 842, bottom: 940 },
  openingMidlineBox: { left: 124, top: 108, right: 876, bottom: 940 },
  visibleOpeningBox: { left: 160, top: 150, right: 840, bottom: 940 },
  doorBottomY: 950,
  heightBottomMode: 'shared'
}, dimensionBoxTestSize, {
  hasDoorOpeningRequest: true,
  hasVisibleOpeningRequest: false
});
assert.strictEqual(legacyAiOpeningOnlyDimensionBoxes.openingMidlineBox.left, 158);
assert.strictEqual(legacyAiOpeningOnlyDimensionBoxes.openingMidlineBox.top, 148);
assert.strictEqual(legacyAiOpeningOnlyDimensionBoxes.openingMidlineBox.source, 'dimension-opening-door-trim-connection-ai');

const legacyVisibleLikeMidlineDimensionBoxes = normalizeDimensionBoxes({
  outerTrimBox: { left: 80, top: 70, right: 920, bottom: 960 },
  openingMidlineBox: { left: 160, top: 150, right: 840, bottom: 940 },
  visibleOpeningBox: { left: 160, top: 150, right: 840, bottom: 940 },
  doorBottomY: 950,
  heightBottomMode: 'shared'
}, dimensionBoxTestSize, {
  hasDoorOpeningRequest: true,
  hasVisibleOpeningRequest: true
});
assert.strictEqual(legacyVisibleLikeMidlineDimensionBoxes.openingMidlineBox.left, 120);
assert.strictEqual(legacyVisibleLikeMidlineDimensionBoxes.openingMidlineBox.top, 110);
assert.strictEqual(legacyVisibleLikeMidlineDimensionBoxes.openingMidlineBox.right, 880);
assert.strictEqual(legacyVisibleLikeMidlineDimensionBoxes.openingMidlineBox.source, 'dimension-opening-request-aware-midline');

const legacyShadowBottomDimensionBoxes = normalizeDimensionBoxes({
  outerTrimBox: { left: 80, top: 70, right: 920, bottom: 960 },
  visibleOpeningBox: { left: 160, top: 150, right: 840, bottom: 940 },
  doorBottomY: 990,
  heightBottomMode: 'shared'
}, dimensionBoxTestSize, {
  hasDoorOpeningRequest: true,
  hasVisibleOpeningRequest: false
});
assert.strictEqual(legacyShadowBottomDimensionBoxes.doorBottomY, 960);

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

const aiAnchoredDoorStructure = normalizeDoorStructure({
  doorType: 'single',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 80, top: 70, right: 920, bottom: 960 },
    opening: { left: 120, top: 110, right: 880, bottom: 950 },
    visibleOpening: { left: 160, top: 150, right: 840, bottom: 940 },
    doorLeaf: { left: 200, top: 190, right: 800, bottom: 950 },
    handle: null,
    lock: null,
    transom: null,
    header: { left: 60, top: 30, right: 940, bottom: 960 },
    shadowRegions: [
      { left: 70, top: 960, right: 930, bottom: 990 }
    ]
  },
  dimensionAnchors: {
    doorTrimConnection: { left: 158, top: 148, right: 842, bottom: 940 },
    openingMidline: { left: 126, top: 112, right: 874, bottom: 940 }
  },
  keypoints: { doorBottomY: 950 },
  modes: { heightBottomMode: 'shared' },
  confidence: { overall: 'high' },
  needsUserAdjustment: false,
  notes: 'ai-assisted dimension anchors'
});
const aiAnchoredBothRules = buildDimensionRules({
  doorType: '单开门',
  viewSide: 'front',
  inputs: {
    openingWidth: '900',
    openingHeight: '2100',
    visibleOpeningWidth: '800'
  },
  doorStructure: aiAnchoredDoorStructure
});
const aiAnchoredOpeningWidth = aiAnchoredBothRules.rules.find((rule) => rule.field === 'openingWidth');
const aiAnchoredOpeningHeight = aiAnchoredBothRules.rules.find((rule) => rule.field === 'openingHeight');
assert(aiAnchoredOpeningWidth);
assert(aiAnchoredOpeningHeight);
assert.strictEqual(aiAnchoredOpeningWidth.sourceBoundary.anchorSource, 'dimensionAnchors.openingMidline');
assert.strictEqual(aiAnchoredOpeningWidth.sourceBoundary.from.value, 126);
assert.strictEqual(aiAnchoredOpeningWidth.sourceBoundary.to.value, 874);
assert.strictEqual(aiAnchoredOpeningHeight.sourceBoundary.anchorSource, 'dimensionAnchors.openingMidline');
assert.strictEqual(aiAnchoredOpeningHeight.sourceBoundary.from.value, 112);

const aiAnchoredOpeningOnlyRules = buildDimensionRules({
  doorType: '单开门',
  viewSide: 'front',
  inputs: {
    openingWidth: '900',
    openingHeight: '2100'
  },
  doorStructure: aiAnchoredDoorStructure
});
const aiAnchoredOpeningOnlyWidth = aiAnchoredOpeningOnlyRules.rules.find((rule) => rule.field === 'openingWidth');
const aiAnchoredOpeningOnlyHeight = aiAnchoredOpeningOnlyRules.rules.find((rule) => rule.field === 'openingHeight');
assert(aiAnchoredOpeningOnlyWidth);
assert(aiAnchoredOpeningOnlyHeight);
assert.strictEqual(aiAnchoredOpeningOnlyWidth.sourceBoundary.anchorSource, 'dimensionAnchors.doorTrimConnection');
assert.strictEqual(aiAnchoredOpeningOnlyWidth.sourceBoundary.from.value, 158);
assert.strictEqual(aiAnchoredOpeningOnlyWidth.sourceBoundary.to.value, 842);
assert.strictEqual(aiAnchoredOpeningOnlyHeight.sourceBoundary.from.value, 148);

const badAiMidlineDoorStructure = normalizeDoorStructure({
  doorType: 'single',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 80, top: 70, right: 920, bottom: 960 },
    opening: { left: 120, top: 110, right: 880, bottom: 950 },
    visibleOpening: { left: 160, top: 150, right: 840, bottom: 940 },
    doorLeaf: { left: 200, top: 190, right: 800, bottom: 950 },
    handle: null,
    lock: null,
    transom: null,
    header: { left: 60, top: 30, right: 940, bottom: 960 },
    shadowRegions: []
  },
  dimensionAnchors: {
    doorTrimConnection: { left: 160, top: 150, right: 840, bottom: 940 },
    openingMidline: { left: 160, top: 150, right: 840, bottom: 940 }
  },
  keypoints: { doorBottomY: 950 },
  modes: { heightBottomMode: 'shared' },
  confidence: { overall: 'high' },
  needsUserAdjustment: false,
  notes: 'bad ai midline equals visible opening'
});
const badAiMidlineRules = buildDimensionRules({
  doorType: 'single',
  viewSide: 'front',
  inputs: {
    openingWidth: '900',
    openingHeight: '2100',
    visibleOpeningWidth: '800'
  },
  doorStructure: badAiMidlineDoorStructure
});
const badAiMidlineOpeningWidth = badAiMidlineRules.rules.find((rule) => rule.field === 'openingWidth');
const badAiMidlineOpeningHeight = badAiMidlineRules.rules.find((rule) => rule.field === 'openingHeight');
assert(badAiMidlineOpeningWidth);
assert(badAiMidlineOpeningHeight);
assert.strictEqual(badAiMidlineOpeningWidth.sourceBoundary.anchorSource, null);
assert.strictEqual(badAiMidlineOpeningWidth.sourceBoundary.from.value, 120);
assert.strictEqual(badAiMidlineOpeningWidth.sourceBoundary.to.value, 880);
assert.strictEqual(badAiMidlineOpeningHeight.sourceBoundary.from.value, 110);

const openingHeightWithVisibleWidthOnly = buildDimensionRules({
  doorType: '单开门',
  viewSide: 'front',
  inputs: {
    openingHeight: '2100',
    visibleOpeningWidth: '800'
  },
  doorStructure: mockDoorStructure
});
const mixedAxisOpeningHeightRule = openingHeightWithVisibleWidthOnly.rules.find((rule) => rule.field === 'openingHeight');
assert(mixedAxisOpeningHeightRule);
assert.strictEqual(mixedAxisOpeningHeightRule.sourceBoundary.box, 'openingEdgeTrimMidline');
assert.strictEqual(mixedAxisOpeningHeightRule.sourceBoundary.boundaryMode, 'edgeTrimMidline');
assert.strictEqual(mixedAxisOpeningHeightRule.sourceBoundary.from.value, 110);

const openingWidthWithVisibleHeightOnly = buildDimensionRules({
  doorType: '单开门',
  viewSide: 'front',
  inputs: {
    openingWidth: '900',
    visibleOpeningHeight: '2000'
  },
  doorStructure: mockDoorStructure
});
const mixedAxisOpeningWidthRule = openingWidthWithVisibleHeightOnly.rules.find((rule) => rule.field === 'openingWidth');
assert(mixedAxisOpeningWidthRule);
assert.strictEqual(mixedAxisOpeningWidthRule.sourceBoundary.box, 'openingEdgeTrimMidline');
assert.strictEqual(mixedAxisOpeningWidthRule.sourceBoundary.boundaryMode, 'edgeTrimMidline');
assert.strictEqual(mixedAxisOpeningWidthRule.sourceBoundary.from.value, 120);

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
        dimensionAnchors: {
          doorTrimConnection: { left: 32, top: 30, right: 88, bottom: 154 },
          openingMidline: { left: 25, top: 19, right: 95, bottom: 154 }
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
assert.strictEqual(hybridAnalyzedDoor.dimensionAnchors.openingMidline.left, 25);
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

const aiPositioningPrompt = buildDoorStructureRefinementPrompt({
  doorType: 'single',
  viewSide: 'front',
  taskType: TaskType.DIMENSION_ANNOTATION,
  imageSize: { width: 1000, height: 1000 },
  dimensionInputs: {
    openingWidth: '900',
    openingHeight: '2400',
    visibleOpeningWidth: '800',
    visibleOpeningHeight: '2300'
  },
  heuristicStructure: mockDoorStructure
});
assert(aiPositioningPrompt.includes('openingWidth, openingHeight, visibleOpeningWidth, visibleOpeningHeight'));
assert(aiPositioningPrompt.includes('门洞尺寸和见光尺寸同时填写'));
assert(aiPositioningPrompt.includes('半包边/包边厚度中线位置'));
assert(aiPositioningPrompt.includes('dimensionAnchors'));
assert(aiPositioningPrompt.includes('doorTrimConnection'));
assert(aiPositioningPrompt.includes('openingMidline'));
assert(aiPositioningPrompt.includes('不得直接等同于 outerTrim 或 visibleOpening'));
assert(aiPositioningPrompt.includes('门外天空、栏杆、展厅地毯'));

let capturedAnalyzerPrompt = '';
const promptCaptureAiClient = {
  responses: {
    create: async (request) => {
      capturedAnalyzerPrompt = request.input[0].content[0].text;
      return {
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
          dimensionAnchors: {
            doorTrimConnection: { left: 32, top: 30, right: 88, bottom: 154 },
            openingMidline: { left: 25, top: 19, right: 95, bottom: 154 }
          },
          keypoints: { doorBottomY: 154 },
          modes: { heightBottomMode: 'shared' },
          confidence: { overall: 'high', opening: 'high', visibleOpening: 'high', outerTrim: 'high', doorLeaf: 'high' },
          needsUserAdjustment: false,
          notes: 'prompt capture ai structure'
        })
      };
    }
  }
};
await analyzeDoor({
  image: hybridAnalyzerImage,
  imageSize: { width: 120, height: 160 },
  doorType: 'single',
  viewSide: 'front',
  taskType: TaskType.DIMENSION_ANNOTATION,
  dimensionInputs: {
    openingWidth: '900',
    visibleOpeningWidth: '800'
  },
  mode: 'hybrid',
  client: promptCaptureAiClient
});
assert(capturedAnalyzerPrompt.includes('openingWidth, visibleOpeningWidth'));
assert(capturedAnalyzerPrompt.includes('门洞尺寸和见光尺寸同时填写'));

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

const heuristicWrongTopStructure = normalizeDoorStructure({
  doorType: 'single',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 100, top: 20, right: 900, bottom: 980 },
    opening: { left: 160, top: 360, right: 840, bottom: 970 },
    visibleOpening: { left: 190, top: 390, right: 810, bottom: 970 },
    doorLeaf: { left: 190, top: 390, right: 810, bottom: 970 },
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
  notes: 'heuristic confused by horizontal slats'
});
const aiCorrectedTopStructure = normalizeDoorStructure({
  doorType: 'single',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 100, top: 20, right: 900, bottom: 980 },
    opening: { left: 158, top: 78, right: 842, bottom: 970 },
    visibleOpening: { left: 190, top: 118, right: 810, bottom: 970 },
    doorLeaf: { left: 190, top: 118, right: 810, bottom: 970 },
    handle: null,
    lock: null,
    transom: null,
    header: { left: 100, top: 20, right: 900, bottom: 980 },
    shadowRegions: []
  },
  keypoints: { doorBottomY: 970 },
  modes: { heightBottomMode: 'shared' },
  confidence: { overall: 'high', opening: 'high', visibleOpening: 'high', outerTrim: 'high', doorLeaf: 'high' },
  needsUserAdjustment: false,
  notes: 'ai corrected top edge'
});
const aiCorrectionKeptStructure = mergeAiStructureWithHeuristic(aiCorrectedTopStructure, heuristicWrongTopStructure, {
  imageSize: { width: 1000, height: 1000 }
});
assert.strictEqual(aiCorrectionKeptStructure.boxes.opening.top, aiCorrectedTopStructure.boxes.opening.top);
assert.strictEqual(aiCorrectionKeptStructure.boxes.visibleOpening.top, aiCorrectedTopStructure.boxes.visibleOpening.top);

const heuristicTopGoodStructure = normalizeDoorStructure({
  doorType: 'single',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 100, top: 20, right: 900, bottom: 980 },
    opening: { left: 160, top: 78, right: 840, bottom: 970 },
    visibleOpening: { left: 190, top: 118, right: 810, bottom: 970 },
    doorLeaf: { left: 190, top: 118, right: 810, bottom: 970 },
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
  notes: 'heuristic top guard baseline'
});
const aiVisibleTopTooLowStructure = normalizeDoorStructure({
  doorType: 'single',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 100, top: 20, right: 900, bottom: 980 },
    opening: { left: 158, top: 80, right: 842, bottom: 970 },
    visibleOpening: { left: 190, top: 280, right: 810, bottom: 970 },
    doorLeaf: { left: 190, top: 280, right: 810, bottom: 970 },
    handle: null,
    lock: null,
    transom: null,
    header: { left: 100, top: 20, right: 900, bottom: 980 },
    shadowRegions: []
  },
  keypoints: { doorBottomY: 970 },
  modes: { heightBottomMode: 'shared' },
  confidence: { overall: 'high', opening: 'high', visibleOpening: 'high', outerTrim: 'high', doorLeaf: 'high' },
  needsUserAdjustment: false,
  notes: 'ai visible top confused by panel interior'
});
const aiVisibleTopGuardedStructure = mergeAiStructureWithHeuristic(aiVisibleTopTooLowStructure, heuristicTopGoodStructure, {
  imageSize: { width: 1000, height: 1000 }
});
assert.strictEqual(aiVisibleTopGuardedStructure.boxes.visibleOpening.top, heuristicTopGoodStructure.boxes.visibleOpening.top);
assert(aiVisibleTopGuardedStructure.notes.includes('visibleOpening top/bottom restored from heuristic guard'));

const heuristicBottomGoodStructure = normalizeDoorStructure({
  doorType: 'single',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 100, top: 20, right: 900, bottom: 960 },
    opening: { left: 160, top: 78, right: 840, bottom: 960 },
    visibleOpening: { left: 190, top: 118, right: 810, bottom: 960 },
    doorLeaf: { left: 190, top: 118, right: 810, bottom: 960 },
    handle: null,
    lock: null,
    transom: null,
    header: { left: 100, top: 20, right: 900, bottom: 960 },
    shadowRegions: []
  },
  keypoints: { doorBottomY: 960 },
  modes: { heightBottomMode: 'shared' },
  confidence: { overall: 'heuristic' },
  needsUserAdjustment: false,
  notes: 'heuristic bottom guard baseline'
});
const aiShadowBottomStructure = normalizeDoorStructure({
  doorType: 'single',
  viewSide: 'front',
  boxes: {
    outerTrim: { left: 100, top: 20, right: 900, bottom: 960 },
    opening: { left: 160, top: 78, right: 840, bottom: 960 },
    visibleOpening: { left: 190, top: 118, right: 810, bottom: 960 },
    doorLeaf: { left: 190, top: 118, right: 810, bottom: 960 },
    handle: null,
    lock: null,
    transom: null,
    header: { left: 100, top: 20, right: 900, bottom: 960 },
    shadowRegions: [
      { left: 90, top: 960, right: 910, bottom: 995 }
    ]
  },
  keypoints: { doorBottomY: 990 },
  modes: { heightBottomMode: 'shared' },
  confidence: { overall: 'high', opening: 'high', visibleOpening: 'high', outerTrim: 'high', doorLeaf: 'high' },
  needsUserAdjustment: false,
  notes: 'ai bottom fell into shadow'
});
const aiShadowBottomGuardedStructure = mergeAiStructureWithHeuristic(aiShadowBottomStructure, heuristicBottomGoodStructure, {
  imageSize: { width: 1000, height: 1000 }
});
assert.strictEqual(aiShadowBottomGuardedStructure.keypoints.doorBottomY, 960);
assert.strictEqual(aiShadowBottomGuardedStructure.modes.heightBottomMode, 'shared');
assert(aiShadowBottomGuardedStructure.notes.includes('doorBottomY restored from heuristic guard'));

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

const syntheticSlattedDoorImage = Buffer.from([
  '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="340">',
  '<rect width="260" height="340" fill="#f8f8f8"/>',
  '<rect x="58" y="18" width="144" height="305" fill="#9a5828"/>',
  '<rect x="70" y="42" width="120" height="268" fill="#b66a34"/>',
  '<rect x="78" y="60" width="104" height="242" fill="#bd733c"/>',
  '<line x1="70" y1="42" x2="190" y2="42" stroke="#40200f" stroke-width="3"/>',
  '<line x1="78" y1="60" x2="182" y2="60" stroke="#4a2512" stroke-width="3"/>',
  Array.from({ length: 9 }, (_, index) => {
    const y = 112 + index * 20;
    return `<line x1="80" y1="${y}" x2="180" y2="${y}" stroke="#4b2410" stroke-width="3"/>`;
  }).join(''),
  '<rect x="188" y="42" width="14" height="268" fill="#8f4b21"/>',
  '<ellipse cx="58" cy="330" rx="62" ry="12" fill="#d6d6d6" opacity="0.52"/>',
  '</svg>'
].join(''));
const syntheticSlattedDoor = await analyzeDoor({
  image: syntheticSlattedDoorImage,
  imageSize: { width: 260, height: 340 },
  doorType: 'single',
  viewSide: 'front',
  taskType: TaskType.DIMENSION_ANNOTATION,
  mode: 'heuristic'
});
const slattedOuterHeight = syntheticSlattedDoor.boxes.outerTrim.bottom - syntheticSlattedDoor.boxes.outerTrim.top;
assert(
  syntheticSlattedDoor.boxes.opening.top <= syntheticSlattedDoor.boxes.outerTrim.top + slattedOuterHeight * 0.16,
  'slatted door opening top should prefer the upper structural edge, not mid-door slat lines'
);
assert(
  syntheticSlattedDoor.boxes.visibleOpening.top <= syntheticSlattedDoor.boxes.outerTrim.top + slattedOuterHeight * 0.20,
  'slatted door visible opening top should stay near the top structural opening'
);

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

const localHeaderDoubleDoorRegressionPath = path.join(
  process.env.HOME || '',
  'Downloads',
  '2zHw2vpbH7-C63812a30781d36688d732a08f18d2b87.png'
);
if (sharp && fs.existsSync(localHeaderDoubleDoorRegressionPath)) {
  const localHeaderDoubleDoorImage = await sharp(localHeaderDoubleDoorRegressionPath).rotate().png().toBuffer();
  const localHeaderDoubleDoorMetadata = await sharp(localHeaderDoubleDoorImage).metadata();
  const localHeaderDoubleDoor = await analyzeDoor({
    image: localHeaderDoubleDoorImage,
    imageSize: {
      width: localHeaderDoubleDoorMetadata.width,
      height: localHeaderDoubleDoorMetadata.height
    },
    doorType: 'double',
    viewSide: 'front',
    taskType: TaskType.DIMENSION_ANNOTATION,
    mode: 'heuristic'
  });
  const headerOuterHeight = localHeaderDoubleDoor.boxes.outerTrim.bottom - localHeaderDoubleDoor.boxes.outerTrim.top;
  assert(
    localHeaderDoubleDoor.boxes.opening.top >= localHeaderDoubleDoor.boxes.outerTrim.top + headerOuterHeight * 0.20,
    'double door with prominent header should not use arch/header top as opening top'
  );
  assert(
    localHeaderDoubleDoor.boxes.visibleOpening.top >= localHeaderDoubleDoor.boxes.outerTrim.top + headerOuterHeight * 0.22,
    'double door with prominent header should not use arch/header top as visible opening top'
  );
  assert(
    localHeaderDoubleDoor.boxes.transom.bottom <= localHeaderDoubleDoor.boxes.opening.top,
    'prominent header/transom region should remain above the opening top'
  );
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
assert(pipelineResult.renderPlan.metadata.sourceImageSize);
assert(pipelineResult.renderPlan.metadata.sourceContentBox);
assert(pipelineResult.renderPlan.metadata.contentBox.left >= pipelineResult.renderPlan.metadata.imageOffset.x);

const inputsCompatPipelineResult = await runDimensionAnnotationPipeline({
  taskType: TaskType.DIMENSION_ANNOTATION,
  doorType: '单开门',
  dimensionViewSide: 'front',
  inputs: {
    openingWidth: '980',
    visibleOpeningWidth: '900'
  },
  imageSize,
  analyzerMode: 'mock'
});
assert.strictEqual(inputsCompatPipelineResult.status, JobStatus.SUCCEEDED);
assert.deepStrictEqual(
  inputsCompatPipelineResult.metadata.rules.map((rule) => rule.field).sort(),
  ['openingWidth', 'visibleOpeningWidth'].sort()
);
const compatOpeningWidthRule = inputsCompatPipelineResult.metadata.rules
  .find((rule) => rule.field === 'openingWidth');
assert.strictEqual(compatOpeningWidthRule.sourceBoundary.boundaryMode, 'edgeTrimMidline');
for (const line of inputsCompatPipelineResult.renderPlan.lines) {
  assert(line.from.x >= 0 && line.from.y >= 0 && line.to.x >= 0 && line.to.y >= 0);
}

const legacyDimensionPromptFromInputs = buildDoorImageInstruction({
  taskType: TaskType.DIMENSION_ANNOTATION,
  doorType: '单开门',
  dimensionViewSide: 'front',
  inputs: {
    openingWidth: '980',
    visibleOpeningWidth: '900'
  }
}, null, null, [], null);
assert(legacyDimensionPromptFromInputs.includes('客户已选择/填写的尺寸项'));
assert(legacyDimensionPromptFromInputs.includes('门洞宽：980mm'));
assert(legacyDimensionPromptFromInputs.includes('见光宽：900mm'));
assert(legacyDimensionPromptFromInputs.includes('门洞尺寸取包边厚度中线'));

const mixedVisibilityPipelineResult = await runDimensionAnnotationPipeline({
  taskType: TaskType.DIMENSION_ANNOTATION,
  doorType: '单开门',
  dimensionViewSide: 'front',
  dimensionValues: {
    openingHeight: '2200',
    visibleOpeningWidth: '800'
  },
  imageSize,
  dimensionWhiteBackground: false,
  analyzerMode: 'mock'
});
assert.strictEqual(mixedVisibilityPipelineResult.status, JobStatus.SUCCEEDED);
const mixedPipelineOpeningHeightRule = mixedVisibilityPipelineResult.metadata.rules
  .find((rule) => rule.field === 'openingHeight');
assert(mixedPipelineOpeningHeightRule);
assert.strictEqual(mixedPipelineOpeningHeightRule.sourceBoundary.box, 'openingEdgeTrimMidline');
assert.strictEqual(mixedPipelineOpeningHeightRule.sourceBoundary.boundaryMode, 'edgeTrimMidline');
assert.strictEqual(mixedPipelineOpeningHeightRule.sourceBoundary.from.value, 110);

clearJobsForTest();
clearArtifactsForTest();

const whiteBackgroundCompatJob = createJob({
  taskType: TaskType.DIMENSION_ANNOTATION,
  doorType: '单开门',
  viewSide: 'front',
  inputs: {},
  dimensionInputs: {
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
