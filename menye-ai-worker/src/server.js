const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const cloudbase = require('@cloudbase/node-sdk');
const openaiModule = require('openai');
const { createJob: createStructuredJob, runJob: runStructuredJob } = require('./jobs/jobController');
const { getArtifact } = require('./jobs/artifactService');
const { TaskType } = require('./door/schema');
let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  sharp = null;
}

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const SECRET_ID = process.env.CLOUDBASE_SECRET_ID;
const SECRET_KEY = process.env.CLOUDBASE_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_IMAGE_FALLBACK_MODELS = parseCommaList(
  process.env.OPENAI_IMAGE_FALLBACK_MODELS
  || process.env.OPENAI_IMAGE_FALLBACK_MODEL
  || (OPENAI_IMAGE_MODEL === 'gpt-image-1' ? '' : 'gpt-image-1')
).filter((model) => model !== OPENAI_IMAGE_MODEL && !isLegacySingleImageEditModel(model));
const OPENAI_IMAGE_FALLBACK_MODEL = OPENAI_IMAGE_FALLBACK_MODELS[0] || '';
const RAW_OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-5.5';
const OPENAI_VISION_MODEL = normalizeVisionModelName(RAW_OPENAI_VISION_MODEL);
const OPENAI_VISION_REASONING_EFFORT = process.env.OPENAI_VISION_REASONING_EFFORT || 'high';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || '';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 180000);
const OPENAI_IMAGE_TIMEOUT_MS = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS || OPENAI_TIMEOUT_MS);
const CLOUDBASE_TIMEOUT_MS = Number(process.env.CLOUDBASE_TIMEOUT_MS || 60000);
const CLOUDBASE_UPLOAD_TIMEOUT_MS = Number(process.env.CLOUDBASE_UPLOAD_TIMEOUT_MS || 90000);
const ENABLE_DIRECT_BACKGROUND_COMPOSITE = process.env.ENABLE_DIRECT_BACKGROUND_COMPOSITE === 'true';
const ENABLE_DIRECT_HANDLE_COMPOSITE_FALLBACK = process.env.ENABLE_DIRECT_HANDLE_COMPOSITE_FALLBACK === 'true';
const USE_NEW_DIMENSION_PIPELINE = process.env.USE_NEW_DIMENSION_PIPELINE === 'true';
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET;
const PORT = Number(process.env.PORT || 3000);

const requiredEnvMap = {
  CLOUDBASE_ENV_ID: ENV_ID,
  CLOUDBASE_SECRET_ID: SECRET_ID,
  CLOUDBASE_SECRET_KEY: SECRET_KEY,
  OPENAI_API_KEY,
  WORKER_SHARED_SECRET
};

function getMissingEnvKeys() {
  return Object.keys(requiredEnvMap).filter((key) => !requiredEnvMap[key]);
}

const missingEnvKeys = getMissingEnvKeys();
const isConfigured = missingEnvKeys.length === 0;

const app = isConfigured ? cloudbase.init({
  env: ENV_ID,
  secretId: SECRET_ID,
  secretKey: SECRET_KEY
}) : null;

const db = app ? app.database() : null;
const collection = db ? db.collection('ai_jobs') : null;
const OpenAIClient = openaiModule.default || openaiModule;
const toFile = openaiModule.toFile;
const openai = isConfigured ? new OpenAIClient({
  apiKey: OPENAI_API_KEY,
  timeout: OPENAI_TIMEOUT_MS,
  ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {})
}) : null;

function getSanitizedBaseUrl(value) {
  if (!value) {
    return 'https://api.openai.com/v1';
  }
  try {
    const target = new URL(value);
    return `${target.protocol}//${target.host}${target.pathname}`;
  } catch (error) {
    return value;
  }
}

function normalizeVisionModelName(value) {
  const normalized = String(value || '').trim().replace(/\s+Thinking$/i, '').trim();
  return normalized || 'gpt-5.5';
}

function parseCommaList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTaskType(job) {
  const taskType = String(job && job.taskType ? job.taskType : '').trim();
  if (taskType) {
    return taskType;
  }
  const sceneId = String(job && job.sceneId ? job.sceneId : '').trim();
  if (sceneId === 'home-effect') {
    return 'parts-compose';
  }
  if (sceneId === 'dimension-annotation') {
    return 'dimension-annotation';
  }
  if (sceneId === 'scene-effect' || sceneId === 'marketing-poster') {
    return 'scene-effect';
  }
  const templateTypeText = String(job && job.templateType ? job.templateType : '');
  if (/尺寸标注|尺寸|标注/.test(templateTypeText)) {
    return 'dimension-annotation';
  }
  if (/门部件拼接效果图|门部件拼接/.test(templateTypeText)) {
    return 'parts-compose';
  }
  if (/场景效果图|场景|背景/.test(templateTypeText)) {
    return 'scene-effect';
  }
  return '';
}

const DIMENSION_DOOR_TYPES = [
  '单开门',
  '双开门',
  '子母门',
  '四开子母门',
  '四开平分门',
  '六开门'
];

const COMMON_DIMENSION_FIELDS = [
  { key: 'openingWidth', label: '门洞宽', annotationLabel: '门洞宽', unit: 'mm' },
  { key: 'openingHeight', label: '门洞高', annotationLabel: '门洞高', unit: 'mm' },
  { key: 'visibleOpeningWidth', label: '见光宽', annotationLabel: '见光宽', unit: 'mm' },
  { key: 'visibleOpeningHeight', label: '见光高', annotationLabel: '见光高', unit: 'mm' },
  { key: 'withEdgeTrimWidth', label: '含包边宽', annotationLabel: '含包边宽', unit: 'mm' },
  { key: 'withEdgeTrimHeight', label: '含包边高', annotationLabel: '含包边高', unit: 'mm' },
  { key: 'wallThickness', label: '墙体厚度', annotationLabel: '墙体厚度', unit: 'mm' },
  { key: 'transomHeight', label: '含气窗高', annotationLabel: '含气窗高', unit: 'mm' },
  { key: 'headerWidth', label: '含门头宽', annotationLabel: '含门头宽', unit: 'mm' },
  { key: 'headerHeight', label: '含门头高', annotationLabel: '含门头高', unit: 'mm' }
];

const DOOR_TYPE_DIMENSION_FIELDS = {
  '单开门': [],
  '双开门': [],
  '子母门': [],
  '四开子母门': [],
  '四开平分门': [],
  '六开门': []
};

function normalizeDimensionDoorType(value) {
  const text = String(value || '').trim();
  if (DIMENSION_DOOR_TYPES.includes(text)) {
    return text;
  }
  if (/六开/.test(text)) {
    return '六开门';
  }
  if (/四开.*子母|子母.*四开/.test(text)) {
    return '四开子母门';
  }
  if (/四开/.test(text)) {
    return '四开平分门';
  }
  if (/子母/.test(text)) {
    return '子母门';
  }
  if (/双开/.test(text)) {
    return '双开门';
  }
  return '单开门';
}

function getDimensionFieldOptions(doorType, viewSide) {
  const normalizedDoorType = normalizeDimensionDoorType(doorType);
  const seen = new Set();
  return COMMON_DIMENSION_FIELDS
    .concat(DOOR_TYPE_DIMENSION_FIELDS[normalizedDoorType] || [])
    .filter((field) => {
      if (!field || !field.key || seen.has(field.key)) {
        return false;
      }
      seen.add(field.key);
      return true;
    });
}

function normalizeDimensionValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const raw = typeof value === 'object' && value.value !== undefined ? value.value : value;
  const text = String(raw).trim();
  if (!text) {
    return '';
  }
  const numeric = text.replace(/mm|毫米/gi, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(numeric)) {
    return '';
  }
  return `${numeric}mm`;
}

function getDimensionInputMap(job) {
  const sources = [
    job && job.dimensionValues,
    job && job.dimensions,
    job && job.dimensionInputs,
    job && job.dimensionAnnotations
  ].filter((item) => item && typeof item === 'object');
  const result = {};
  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const item of source) {
        if (!item || !item.key) {
          continue;
        }
        result[item.key] = item.value !== undefined ? item.value : item.text;
      }
    } else {
      Object.assign(result, source);
    }
  }
  return result;
}

function buildDimensionAnnotationData(job) {
  const doorType = normalizeDimensionDoorType(job && job.doorType);
  const viewSide = job && job.dimensionViewSide === 'back' ? 'back' : 'front';
  const fields = getDimensionFieldOptions(doorType, viewSide);
  const inputMap = getDimensionInputMap(job);
  const selectedKeys = Array.isArray(job && job.dimensionSelectedKeys)
    ? job.dimensionSelectedKeys.map((item) => String(item || '')).filter(Boolean)
    : [];
  const selectedSet = new Set(selectedKeys);
  const provided = fields
    .map((field) => ({
      ...field,
      valueText: normalizeDimensionValue(inputMap[field.key])
    }))
    .filter((field) => field.valueText || selectedSet.has(field.key));
  const providedKeys = new Set(provided.map((field) => field.key));
  const requirementText = job && job.requirement ? String(job.requirement) : '';
  const hasDoorOpeningRequest = providedKeys.has('openingWidth') ||
    providedKeys.has('openingHeight') ||
    /门洞/.test(requirementText);
  const hasVisibleOpeningRequest = providedKeys.has('visibleOpeningWidth') ||
    providedKeys.has('visibleOpeningHeight') ||
    /见光/.test(requirementText);
  return {
    doorType,
    viewSide,
    viewSideLabel: viewSide === 'back' ? '背面图' : '正面图',
    hasDoorOpeningRequest,
    hasVisibleOpeningRequest,
    fields,
    provided
  };
}

function getVisionResponseRequest(input) {
  const request = {
    model: OPENAI_VISION_MODEL,
    input
  };
  if (OPENAI_VISION_REASONING_EFFORT && OPENAI_VISION_REASONING_EFFORT !== 'none') {
    request.reasoning = {
      effort: OPENAI_VISION_REASONING_EFFORT
    };
  }
  return request;
}

function assertConfigured() {
  if (!isConfigured) {
    throw new Error(`缺少环境变量：${missingEnvKeys.join(', ')}`);
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label || '操作'}超时：${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function retryOperation(label, operation, maxAttempts) {
  const attempts = maxAttempts || 2;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const result = await operation(attempt);
      if (attempt > 1) {
        console.log('[worker] operation retry succeeded', {
          label,
          attempt,
          elapsedMs: Date.now() - startedAt
        });
      }
      return result;
    } catch (error) {
      lastError = error;
      console.warn('[worker] operation failed', {
        label,
        attempt,
        elapsedMs: Date.now() - startedAt,
        message: error && error.message ? error.message : String(error || '')
      });
      if (attempt >= attempts) {
        break;
      }
    }
  }
  throw lastError;
}

function signPayload(jobId, timestamp, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${jobId}.${timestamp}`)
    .digest('hex');
}

function verifySignature(body) {
  const { jobId, timestamp, signature } = body || {};
  if (!jobId || !timestamp || !signature || !WORKER_SHARED_SECRET) {
    return false;
  }
  return signPayload(jobId, timestamp, WORKER_SHARED_SECRET) === signature;
}

function getReferenceImages(job) {
  return Array.isArray(job.referenceImages)
    ? job.referenceImages
      .filter((item) => item && (item.originalImageFileID || item.uploadedRef))
      .map((item) => {
        const fileID = item.originalImageFileID || item.uploadedRef;
        return {
          ...item,
          originalImageFileID: fileID,
          uploadedRef: item.uploadedRef || fileID
        };
      })
    : [];
}

function getTargetPartKeys(job) {
  return Array.isArray(job && job.targetParts)
    ? job.targetParts.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function getPrimaryReferenceImage(job) {
  const referenceImages = getReferenceImages(job);
  return referenceImages.find((item) => item.slotId === 'full-door') || referenceImages[0] || null;
}

function getHandleDetailImage(job) {
  const referenceImages = getReferenceImages(job);
  return referenceImages.find((item) => item.slotId === 'handle-detail') || null;
}

function getLockDetailImage(job) {
  const referenceImages = getReferenceImages(job);
  return referenceImages.find((item) => item.slotId === 'lock-detail') || null;
}

function getBackgroundReferenceImage(job) {
  const referenceImages = getReferenceImages(job);
  return referenceImages.find((item) => item.slotId === 'background-reference') || null;
}

function getReferenceSlotLabel(slotId) {
  switch (slotId) {
    case 'full-door':
      return '整门上下文图';
    case 'handle-detail':
      return '门把手细节图';
    case 'edge-trim-detail':
      return '包边参考图';
    case 'color-sample':
      return '颜色参考图';
    case 'left-leaf-detail':
      return '左门扇细节图';
    case 'right-leaf-detail':
      return '右门扇细节图';
    case 'child-leaf-detail':
      return '小门扇细节图';
    case 'middle-join-detail':
      return '中缝/拼接细节图';
    case 'header-column-detail':
      return '门头/门柱细节图';
    case 'lock-detail':
      return '锁体/智能锁细节图';
    case 'panel-style-detail':
      return '门板线条/造型细节图';
    case 'glass-grille-detail':
      return '气窗细节图';
    case 'texture-reference':
      return '材质纹理参考图';
    case 'background-reference':
      return '背景参考图';
    default:
      return slotId || '参考图';
  }
}

function getDetectableReferenceSlotIds() {
  return [
    'edge-trim-detail',
    'color-sample',
    'lock-detail',
    'panel-style-detail',
    'glass-grille-detail',
    'header-column-detail',
    'texture-reference',
    'left-leaf-detail',
    'right-leaf-detail',
    'child-leaf-detail',
    'middle-join-detail',
    'background-reference'
  ];
}

function getPromptDecisionSummary(job) {
  const requirementText = job && job.requirement ? String(job.requirement) : '';
  const backgroundInfo = job && job.backgroundInfo ? String(job.backgroundInfo).trim() : '';
  const referenceImages = getReferenceImages(job);
  const hasEdgeTrimDetail = referenceImages.some((item) => item && item.slotId === 'edge-trim-detail');
  const hasColorSample = referenceImages.some((item) => item && item.slotId === 'color-sample');
  const userSelectedEdgeTrimReferenceColor = referenceImages.some((item) => item && item.slotId === 'edge-trim-detail' && item.colorMode === 'reference');
  const userWantsEdgeTrimDoorColor = /(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:同门|跟门|与门|和门|门体|门扇|整门)[^。；，,.]{0,24}(?:同色|一样|一致|统一)|(?:门体|门扇|整门)[^。；，,.]{0,24}(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:同色|一样|一致|统一)/.test(requirementText);
  const userSpecifiedEdgeTrimColor = /(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:改成|换成|调成|做成|改为|设为|使用|用)[^。；，,.]{0,24}(?:颜色|色|黑|白|灰|棕|木|金|银|红|黄|蓝|绿|深|浅)|(?:黑色|白色|灰色|棕色|木色|金色|银色|深色|浅色)[^。；，,.]{0,24}(?:包边|门套|收口|压线)/.test(requirementText);
  const userWantsEdgeTrimReferenceColor = userSelectedEdgeTrimReferenceColor || /(?:包边|门套|收口|压线)[^。；，,.]{0,28}(?:按|跟随|参考|保留|保持|使用|用)[^。；，,.]{0,28}(?:包边参考图|参考图|原图)[^。；，,.]{0,16}(?:颜色|色|固有色)|(?:包边|门套|收口|压线)[^。；，,.]{0,28}(?:不要|不跟|不同|独立|单独|另外|另做)[^。；，,.]{0,28}(?:同门|跟门|门体|门扇|整门|同色|统一|颜色|色)/.test(requirementText);
  const userWantsEdgeTrimPreserveColor = /(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:颜色|色|原色|本色|自身颜色|当前颜色|现在颜色)[^。；，,.]{0,16}(?:保持不变|不变|别变|不要变|不能变|保留|维持|锁定|不改|不要改|原样)|(?:保持不变|不变|别变|不要变|不能变|保留|维持|锁定|不改|不要改|原样)[^。；，,.]{0,24}(?:包边|门套|收口|压线)[^。；，,.]{0,16}(?:颜色|色|原色|本色|自身颜色|当前颜色|现在颜色)|(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:保留|保持|用|使用)[^。；，,.]{0,16}(?:原色|本色|自身颜色|当前颜色|现在颜色|原包边颜色)/.test(requirementText);
  const userWantsIndependentEdgeTrimColor = !userWantsEdgeTrimDoorColor && (userSpecifiedEdgeTrimColor || userWantsEdgeTrimReferenceColor || userWantsEdgeTrimPreserveColor);
  const allowDoorSurfaceColorChange = hasColorSample || hasDoorSurfaceColorTextRequest(job);
  return {
    requirementText,
    backgroundInfo,
    hasEdgeTrimDetail,
    hasColorSample,
    userSelectedEdgeTrimReferenceColor,
    userWantsEdgeTrimDoorColor,
    userSpecifiedEdgeTrimColor,
    userWantsEdgeTrimReferenceColor,
    userWantsEdgeTrimPreserveColor,
    edgeTrimPreserveMeansReferenceColor: hasEdgeTrimDetail && userWantsEdgeTrimPreserveColor,
    userWantsIndependentEdgeTrimColor,
    edgeTrimColorProtectedFromColorSample: hasEdgeTrimDetail && userWantsIndependentEdgeTrimColor,
    colorSampleAppliesToEdgeTrim: hasColorSample && !(hasEdgeTrimDetail && userWantsIndependentEdgeTrimColor),
    allowDoorSurfaceColorChange
  };
}

function normalizeReferenceCode(value) {
  return String(value || '')
    .trim()
    .replace(/[－–—]/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function normalizeColorTargetName(value) {
  return String(value || '')
    .trim()
    .replace(/[“”"'「」『』]/g, '')
    .replace(/[，。；,.!?！？、].*$/, '')
    .replace(/^(?:为|是|叫|按|用|使用|选择|选|成|到|：|:)+/, '')
    .replace(/(?:这个|这种|一样|一致|参考|即可|就行|颜色|色卡|色号|编号)+$/, '')
    .trim();
}

function removeBackgroundColorText(text) {
  return String(text || '')
    .replace(/(?:背景|底色|底图|白底|白板|透明底|去背景|不改背景)[^。；，,.!?！？]{0,24}/g, ' ')
    .replace(/(?:抠图|扣图|抠出来|扣出来|单独抠|单独扣)[^。；，,.!?！？]{0,24}/g, ' ');
}

function isRejectedColorTargetName(value) {
  return /^(?:白底|白板|透明底|背景|底色|底图|不改|不变|保持|原样|参考图|包边|门套|把手|门把手|整门|门体|门扇|门板|颜色|色卡|色号|编号)$/.test(value);
}

function looksLikeColorName(value) {
  return /黑|白|灰|粉|红|橙|黄|绿|青|蓝|紫|棕|褐|咖|米|金|银|铜|木|梨|橡|桃|胡桃|香槟|奶油|杏|卡其|莫兰迪|茶|驼|藕|铁|砂|珍珠|象牙|浅|深|暖|冷|亮|哑|雅|清|色/.test(value);
}

function getColorRequestText(job) {
  return [
    job && job.requirement,
    job && job.style
  ].filter(Boolean).join(' ');
}

function extractNamedColorTargetFromText(text) {
  const source = removeBackgroundColorText(text);
  const explicitPatterns = [
    /(?:颜色参考|参考颜色|参考色|色卡(?:名称|名字)?|颜色(?:名称|名字)?|色名|门体颜色|门扇颜色|门板颜色|整门颜色|门面颜色)\s*(?:为|是|叫|选|选择|按|用|使用|要|：|:)?\s*([A-Za-z0-9#\u4e00-\u9fa5\-－–—]{1,18})/i,
    /(?:色号|编号)\s*(?:为|是|叫|选|选择|按|用|使用|要|：|:)?\s*([A-Za-z0-9#\u4e00-\u9fa5\-－–—]{1,18})/i
  ];
  for (const pattern of explicitPatterns) {
    const matched = pattern.exec(source);
    const candidate = normalizeColorTargetName(matched && matched[1]);
    if (candidate && !isRejectedColorTargetName(candidate)) {
      return candidate;
    }
  }

  const actionPatterns = [
    /(?:门体|门扇|门板|整门|门面|颜色)?[^。；，,.!?！？]{0,8}(?:改成|换成|调成|做成|改为|设为|选|选择|用|使用|按|想要|要)\s*([A-Za-z0-9#\u4e00-\u9fa5\-－–—]{1,18})(?:色|颜色)?/i
  ];
  for (const pattern of actionPatterns) {
    const matched = pattern.exec(source);
    const candidate = normalizeColorTargetName(matched && matched[1]);
    if (candidate && !isRejectedColorTargetName(candidate) && looksLikeColorName(candidate)) {
      return candidate;
    }
  }
  return '';
}

function extractColorReferenceTarget(job) {
  const text = getColorRequestText(job);
  const codeMatched = /[A-Z]{1,6}\s*[-－–—]?\s*\d{2,8}/i.exec(text);
  if (codeMatched) {
    return {
      type: 'code',
      value: normalizeReferenceCode(codeMatched[0])
    };
  }
  const name = extractNamedColorTargetFromText(text);
  return name
    ? { type: 'name', value: name }
    : { type: '', value: '' };
}

function extractColorReferenceCode(job) {
  return extractColorReferenceTarget(job).value;
}

function hasDoorSurfaceColorTextRequest(job) {
  const text = removeBackgroundColorText(getColorRequestText(job));
  if (extractColorReferenceTarget(job).value) {
    return true;
  }
  return /门.*颜色|颜色.*门|颜色参考|参考颜色|参考色|色卡|色号|编号|改色|换色|调色|变色|颜色不对|颜色再|颜色偏/i.test(text);
}

function getReferenceStylePrompt(slotId, options = {}) {
  const targetColorCode = normalizeReferenceCode(options.targetColorCode);
  const includeTexture = !!options.includeTexture;
  switch (slotId) {
    case 'edge-trim-detail':
      return [
        '请识别这张门业包边参考图中的包边/门套线/收口条外观特征，只返回 JSON。',
        '注意：这张图可能是包边近景，也可能是一整扇门。即使图片是一整扇门，也只能识别门洞周围的包边、门套线、收口条、压线和边缘收口区域，不要识别门扇主体、门板花纹、把手、锁体或整门款式。',
        'JSON 格式必须为：{"part":"包边","sourceType":"近景或整门参考","color":"...","colorFamily":"...","undertone":"...","brightness":"...","saturation":"...","hueLock":"...","toneLock":"...","material":"...","finish":"...","shape":"...","structure":"...","profile":"...","edge":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        '颜色识别必须和门体颜色参考图使用同一套标准：像 Photoshop 吸管工具一样，以包边区域肉眼可见的主取样颜色为准。不要推断“材料本身固有色”，不要自动校正白平衡、环境光或拍摄偏色；看到什么颜色就提取什么颜色。只避开明显高光点、反光点、深阴影、污渍和噪点，从包边/门套线/收口条中最大、最均匀、最能代表包边表面的区域取样。',
        '其中 color 表示可直接用于生成的具体可见取样色描述，不要只写“深色”“浅色”；colorFamily 表示颜色大类，例如黑、灰、白、棕、红棕、金、香槟、木色等；undertone 表示可见冷暖色偏，例如偏黄、偏红、偏灰、偏蓝、偏金；brightness 表示肉眼可见明度，例如深/中深/中/浅；saturation 表示肉眼可见饱和度，例如低饱和/中饱和/高饱和；hueLock 表示最不能漂移的可见色相约束，例如不要偏红、不要偏黄、不要偏绿、不要偏蓝；toneLock 表示最不能漂移的明暗/灰度约束，例如不要提亮、不要压暗、不要加灰、不要加暖；material 表示材质，finish 表示表面工艺或质感，shape 表示整体造型和宽窄比例，structure 表示门套线、收口条、压线、拼接结构，profile 表示截面层次、凹凸、倒角、圆角、折边等轮廓特征，edge 表示边角、转角、收边方式，details 表示纹路、线条、装饰、色差、取样区域等关键细节。',
        '如果包边区域里有多个颜色，请选择面积最大、最像客户想要包边表面颜色的可见主色，并在 details 里说明次要色、纹理色差或阴影色。',
        'sampleBox 必须框住最适合取包边真实可见颜色的区域，坐标是相对整张图 0 到 1 的比例。必须只框包边/门套线/收口条区域，不能框门扇主体、墙面、地面、把手或玻璃；如果是包边近景，就框中间最均匀的包边表面区域。',
        'applyDescription 必须同时包含包边结构描述和“可见取样色”描述，颜色部分要包含颜色大类、冷暖色偏、明度、饱和度和禁止漂移方向，例如“提取参考图中门洞外圈的中浅低饱和偏金香槟色窄边门套线和内侧细压线，不要偏黄或提亮，只迁移包边，不迁移门扇”。',
        '如果参考图是一整扇门，必须在 details 里说明“已忽略门扇主体和把手，只提取包边”。',
        '必须尽量具体，不要只写“普通包边”“金属包边”“木纹包边”这类泛化描述。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    case 'color-sample':
      return [
        '请像 Photoshop 吸管工具一样识别这张门体颜色参考图中肉眼可见的主取样颜色和材质特征，只返回 JSON。',
        includeTexture
          ? '客户已选择“同时提取色卡纹理”，因此除了颜色，还必须识别目标色块/门板里的纹理方向、木纹/拉丝/颗粒、明暗纹理色差、表面质感和材质观感，并把这些纹理信息写入 material、finish、structure、details、applyDescription。'
          : '客户没有选择“同时提取色卡纹理”，因此这张图主要只作为颜色参考；请识别目标色块的可见主色，纹理、木纹方向、颗粒和材质细节只作为辅助说明，不要要求最终图强制迁移色卡纹理。',
        targetColorCode
          ? `客户明确指定颜色编号/名称：${targetColorCode}。如果图片是包含多个门板/色块的色卡页，必须先找到文字标签与 ${targetColorCode} 完全匹配或语义严格匹配的那一个门板/色块，只识别该标签对应的门体颜色；例如用户写“粉白色”可以匹配色卡里的“粉白”，用户写“莫兰迪粉”必须匹配同名或非常明确的莫兰迪粉标签。严禁选择其他编号、相邻名称、整页平均色、标题、背景或面积最大的无关色块。`
          : '如果图片是包含多个门板/色块的色卡页，但客户没有指定编号，请选择最像客户想要门体表面颜色的主色块。',
        targetColorCode
          ? `sampleBox 必须框住 ${targetColorCode} 对应门板/色块上最均匀的门体表面区域，不能框编号文字、颜色名称、背景、其他编号或其他名称的门板、把手、阴影或边框。`
          : '',
        'JSON 格式必须为：{"part":"门体颜色","referenceCode":"...","referenceName":"...","codeMatchConfidence":"...","color":"...","colorFamily":"...","undertone":"...","brightness":"...","saturation":"...","hueLock":"...","toneLock":"...","material":"...","finish":"...","shape":"...","structure":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        '识别时不要推断“材料本身固有色”，不要自动校正白平衡、环境光或拍摄偏色；看到什么颜色就提取什么颜色。只避开明显高光点、反光点、深阴影、污渍和噪点，从最大、最均匀、最能代表门体表面的区域取样。',
        includeTexture
          ? '其中 color 表示可直接用于生成的具体可见取样色描述，不要只写“深色”“浅色”；colorFamily 表示颜色大类，例如黑、灰、白、棕、红棕、金、香槟、木色等；undertone 表示可见冷暖色偏；brightness 表示肉眼可见明度；saturation 表示肉眼可见饱和度；hueLock 表示最不能漂移的可见色相约束；toneLock 表示最不能漂移的明暗/灰度约束；material 表示材质；finish 表示表面质感；shape 可以写“不适用”；structure 必须描述纹理方向、纹理粗细、木纹/拉丝/颗粒/拼色关系；details 必须描述取样区域、主纹理、次要纹理、纹理色差和需要迁移的纹理细节；applyDescription 必须同时包含颜色和纹理迁移描述。'
          : '其中 color 表示可直接用于生成的具体可见取样色描述，不要只写“深色”“浅色”；colorFamily 表示颜色大类，例如黑、灰、白、棕、红棕、金、香槟、木色等；undertone 表示可见冷暖色偏，例如偏黄、偏红、偏灰、偏蓝、偏金；brightness 表示肉眼可见明度，例如深/中深/中/浅；saturation 表示肉眼可见饱和度，例如低饱和/中饱和/高饱和；hueLock 表示最不能漂移的可见色相约束，例如不要偏红、不要偏黄、不要偏绿、不要偏蓝；toneLock 表示最不能漂移的明暗/灰度约束，例如不要提亮、不要压暗、不要加灰、不要加暖；material、finish、structure、details 只作为辅助说明，不强制最终迁移色卡纹理；applyDescription 表示给图像编辑模型执行时应使用的一句话颜色描述。',
        targetColorCode
          ? `如果 ${targetColorCode} 对应门板内部有木纹明暗差，请选择该门板上面积最大、最均匀、最能代表 ${targetColorCode} 可见表面颜色的区域，并在 details 里写明“已按指定标签 ${targetColorCode} 取色”。`
          : '如果图片里有多个颜色，请选择面积最大、最像客户想要门体表面颜色的可见主色，并在 details 里说明次要色或纹理色差。',
        'sampleBox 必须框住最适合取门体真实可见颜色的区域，坐标是相对整张图 0 到 1 的比例。必须只框色卡、门板颜色样、门体表面或材质样，不能框墙面、地面、把手、文字标签、强反光或阴影。',
        targetColorCode
          ? `applyDescription 必须包含“按颜色标签 ${targetColorCode} 对应门板取样”，并写成“可见取样色”描述，包含颜色大类、冷暖色偏、明度、饱和度和禁止漂移方向。`
          : 'applyDescription 必须写成“可见取样色”描述，包含颜色大类、冷暖色偏、明度、饱和度和禁止漂移方向，例如“可见取样色为中深低饱和冷灰木色，不要偏黄或提亮”。',
        includeTexture
          ? '因为客户选择了提取纹理，applyDescription 还必须写清楚应迁移的纹理，例如“保留纵向细木纹、浅深纹理色差、哑光木质质感”，但仍不能改变第一张整门图的门型结构、线条数量或比例。'
          : '因为客户没有选择提取纹理，applyDescription 不要写成强制迁移纹理；最终主要按颜色执行，原门已有纹理结构应尽量保持。',
        '不要解释，不要输出 markdown。'
      ].filter(Boolean).join('\n');
    case 'lock-detail':
      return [
        '请识别这张锁体/智能锁细节参考图中的锁具外观特征，只返回 JSON。',
        '这张图默认只用于锁体、锁孔、智能锁、猫眼、门铃、锁面板、锁芯和相关五金细节，不是整门款式参考，也不是普通把手款式参考。',
        'JSON 格式必须为：{"part":"锁体/智能锁","sourceType":"近景或整门参考","lockIntegrationType":"handle-integrated|standalone|none|uncertain","referenceContainsHandle":true,"handleCount":2,"isDoubleHandle":true,"handleLengthRatio":"...","smartPanelPlacement":"...","hasSmartLockPanel":true,"hasRoundHole":true,"roundHoleDescription":"...","roundHoleRelativePosition":"...","color":"...","colorFamily":"...","material":"...","finish":"...","shape":"...","structure":"...","profile":"...","edge":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        'lockIntegrationType 判断标准：只有当智能锁面板、指纹/密码/刷卡区域与拉手本体物理集成在同一根把手或同一块不可拆面板里，才写 handle-integrated；如果只是参考图里同时拍到了普通把手和旁边/附近的锁具，写 standalone；不确定写 uncertain。注意：小圆孔通常是实体应急锁孔，不代表它和把手物理集成。',
        '必须识别锁体类型、是否把手一体式、把手数量、是否双把手、每根把手的大致长度比例、面板位于哪根把手的哪个高度、颜色、材质、表面质感、边角、屏幕/按键/指纹区/钥匙孔/猫眼位置、实体应急锁孔/小圆孔、装饰线和安装方向。',
        '重要识别规则：门上某个类似锁、拉手、黑色面板、装饰块或小五金的东西附近，只要出现一个不属于门板花纹的小圆孔/锁孔/指示孔，就应优先判断为智能锁或智能锁残留，而不是普通门花纹。这个小圆孔是识别智能锁的关键证据。',
        '小圆孔位置规则：小圆孔是实体应急锁孔，用于智能锁损坏后开门；一体式把手智能锁的小圆孔不能放在把手本体或黑色智能面板上，应放在参考图对应的门扇/中缝附近独立位置。除非智能锁不是把手一体式结构，小圆孔才有可能出现在智能锁面板上。',
        '如果参考图包含整扇门，只能提取锁具和其必要安装区域，不能迁移门扇主体、门板线条、包边、颜色或整门款式。',
        '如果 lockIntegrationType 不是 handle-integrated，applyDescription 必须写明：只迁移智能锁面板、指纹/密码/刷卡区、小圆孔、锁芯和必要安装区域；参考图里的把手仅作定位参考，不迁移把手款式。',
        '如果 lockIntegrationType 是 handle-integrated，applyDescription 必须写明：把智能锁面板和一体式把手作为不可拆整体融合；如果参考图是双把手，最终必须生成双把手，不能变成单把手；把手长度、宽窄、面板高度必须接近参考图；小圆孔作为独立实体应急锁孔放在门扇/中缝附近的参考相对位置，不能放到把手或黑色智能面板上；仍不得改变门型结构、门板线条、包边和背景。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    case 'panel-style-detail':
      return [
        '请识别这张门板线条/造型参考图中的门板表面造型特征，只返回 JSON。',
        '这张图只用于门板线条、压线、门芯凹凸、分割比例、浮雕、平板/凹板/凸板关系，不是整门比例或整门替换参考。',
        'JSON 格式必须为：{"part":"门板线条/造型","sourceType":"近景或整门参考","color":"...","colorFamily":"...","material":"...","finish":"...","shape":"...","structure":"...","profile":"...","edge":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        '必须识别线条数量、方向、宽窄、位置关系、凹凸层次、倒角/圆角、压线截面、门芯形状、纹理和表面质感。',
        '如果参考图包含整扇门，只能提取门板线条/造型，不要迁移把手、锁体、包边、背景、开门方向、整门比例或整门款式。',
        'applyDescription 必须说明如何把参考门板线条/造型约束到第一张整门图的门扇表面，同时保持第一张整门图的外轮廓、宽高比例、把手位置和包边关系。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    case 'glass-grille-detail':
      return [
        '请识别这张气窗参考图中的门上方类似窗户的气窗、透光窗、玻璃、镂空或格栅外观特征，只返回 JSON。',
        '这张图只用于气窗/透光窗区域，不是整门款式参考，也不是门体颜色参考。',
        'JSON 格式必须为：{"part":"气窗","sourceType":"近景或整门参考","color":"...","colorFamily":"...","material":"...","finish":"...","shape":"...","structure":"...","profile":"...","edge":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        '必须识别气窗位置、窗格结构、玻璃类型（如长虹玻璃、磨砂、透明、茶玻、灰玻）、格栅材质和颜色、格栅间距、方向、边框、透光程度、反光/雾面质感、镂空形状和收边方式。',
        'color/colorFamily 只能描述气窗自身的玻璃色、格栅色、气窗小边框色或透光色，不得描述或提取整门门扇、门板主体、包边、墙面或背景颜色。',
        '如果参考图包含整扇门，只能提取气窗/透光窗区域，不能迁移门板主体、门扇颜色、把手、锁体、包边、背景或整门款式。',
        'applyDescription 必须说明气窗应如何融合到第一张整门图对应区域，并强调不得改变门扇外轮廓、门型比例、门体颜色和未点名结构。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    case 'header-column-detail':
      return [
        '请识别这张双开门门头/门柱参考图中的门头、门楣、横梁、罗马柱、侧柱、立柱、外框装饰或门洞外圈结构特征，只返回 JSON。',
        '这张图只用于门头/门柱/外框装饰区域，不是整门款式参考，不是门扇颜色参考，也不是门板线条、把手、锁体或气窗参考。',
        'JSON 格式必须为：{"part":"门头/门柱","sourceType":"近景或整门参考","color":"...","colorFamily":"...","material":"...","finish":"...","shape":"...","structure":"...","profile":"...","edge":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        '必须识别门头高度和层次、横梁/门楣造型、左右门柱宽窄、柱头柱脚、罗马柱沟槽、外框包套、雕花/线条、转角、收边、材质、表面质感和与双开门主体的衔接方式。',
        '细节识别必须具体到可复现的装饰件：拱形门头有几层同心弧形线/台阶边、每层厚度和明暗层次；顶部中央是否有金色牌匾/小竖牌；牌匾下方是否有黑色或深色浮雕花饰、卷草纹、贝壳纹、左右延展花枝；横梁上是否有长矩形压线框、中央圆形装饰钮；左右上角是否有方形装饰块、金属三角/金字塔形饰件；左右立柱是否有内嵌长矩形框、竖向凹槽、腰线、柱脚台阶和底座层次。',
        'details 必须列出这些具体装饰元素是否存在、相对位置、数量和形状，不能只写“欧式门头”“罗马柱”“雕花装饰”这类泛化描述。',
        'color/colorFamily 只能描述门头/门柱自身的可见颜色，不得描述或提取门扇、门板主体、把手、锁体、气窗、墙面或背景颜色。',
        '如果参考图包含整扇门，只能提取门头/门柱/门洞外圈区域，不能迁移门扇主体、左右门扇比例、门板线条、门扇颜色、把手、锁体、气窗、背景或整门款式。',
        'applyDescription 必须说明如何把门头/门柱融合到第一张双开门整门图对应外框区域，并强调保留参考图中的多层拱圈、中心牌匾、下方浮雕花饰、横梁压线框、圆形装饰钮、左右方形三角饰件、立柱内嵌框和柱脚底座等关键细节；不得改变门扇外轮廓、左右门扇比例、中缝、把手位置、锁体位置、门体颜色和未点名结构。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    case 'texture-reference':
      return [
        '请识别这张材质纹理参考图中的表面纹理和材质观感，只返回 JSON。',
        '这张图默认只用于木纹、拉丝、肤感、哑光、亮光、颗粒、纹理方向、纹理粗细和表面质感，不作为门型结构、包边、把手或玻璃参考。',
        'JSON 格式必须为：{"part":"材质纹理","sourceType":"近景或材质样","color":"...","colorFamily":"...","material":"...","finish":"...","shape":"不适用","structure":"...","profile":"...","edge":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        '必须识别纹理方向、木纹/拉丝/颗粒类型、纹理密度、粗细、主次纹理色差、表面光泽、哑光/亮光/肤感/金属/木质等材质观感。',
        '颜色字段只描述纹理照片中的可见颜色；除非客户明确要求或同时把这张图当作颜色参考，否则不要把材质纹理参考图的颜色当成最终门体颜色来源。',
        'applyDescription 必须强调只迁移材质纹理和表面质感，不改变第一张整门图的门型结构、线条数量、包边、把手、锁体、玻璃或背景。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    case 'left-leaf-detail':
      return [
        '请识别这张左门扇细节参考图中的局部门扇外观特征，只返回 JSON。',
        '这张图只用于补充左门扇局部细节，不是整门换款参考，也不是改变门扇数量、比例或中缝位置的依据。',
        'JSON 格式必须为：{"part":"左门扇细节","sourceType":"近景或整门参考","color":"...","colorFamily":"...","material":"...","finish":"...","shape":"...","structure":"...","profile":"...","edge":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        '必须识别左门扇上的门板线条、纹理方向、玻璃/格栅、装饰块、压线、局部五金避让、材质和表面质感。',
        '如果参考图包含整扇门，只能提取左门扇对应局部细节；不能迁移整门比例、门框、包边、把手、锁体、背景或开门方向。',
        'applyDescription 必须说明如何把该细节约束到第一张整门图的左门扇对应区域，同时保持第一张整门图的门扇数量、左右比例、中缝位置、把手和锁体位置不变。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    case 'right-leaf-detail':
      return [
        '请识别这张右门扇细节参考图中的局部门扇外观特征，只返回 JSON。',
        '这张图只用于补充右门扇局部细节，不是整门换款参考，也不是改变门扇数量、比例或中缝位置的依据。',
        'JSON 格式必须为：{"part":"右门扇细节","sourceType":"近景或整门参考","color":"...","colorFamily":"...","material":"...","finish":"...","shape":"...","structure":"...","profile":"...","edge":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        '必须识别右门扇上的门板线条、纹理方向、玻璃/格栅、装饰块、压线、局部五金避让、材质和表面质感。',
        '如果参考图包含整扇门，只能提取右门扇对应局部细节；不能迁移整门比例、门框、包边、把手、锁体、背景或开门方向。',
        'applyDescription 必须说明如何把该细节约束到第一张整门图的右门扇对应区域，同时保持第一张整门图的门扇数量、左右比例、中缝位置、把手和锁体位置不变。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    case 'child-leaf-detail':
      return [
        '请识别这张子母门小门扇细节参考图中的局部门扇外观特征，只返回 JSON。',
        '这张图只用于补充子母门小门扇/子门局部细节，不是整门换款参考，也不是把子母比例改成平分双开的依据。',
        'JSON 格式必须为：{"part":"小门扇细节","sourceType":"近景或整门参考","color":"...","colorFamily":"...","material":"...","finish":"...","shape":"...","structure":"...","profile":"...","edge":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        '必须识别小门扇上的门板线条、纹理方向、玻璃/格栅、装饰块、压线、局部五金避让、材质和表面质感。',
        '如果参考图包含整扇门，只能提取小门扇对应局部细节；不能迁移整门比例、门框、包边、把手、锁体、背景或开门方向。',
        'applyDescription 必须说明如何把该细节约束到第一张整门图的小门扇对应区域，同时保持第一张整门图的子母门宽窄比例、中缝位置、把手和锁体位置不变。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    case 'middle-join-detail':
      return [
        '请识别这张中缝/拼接细节参考图中的门缝收口特征，只返回 JSON。',
        '这张图只用于中缝、拼接条、门缝收口、对缝、压条、止口和局部衔接方式，不是整门换款参考，也不是改变门扇数量或比例的依据。',
        'JSON 格式必须为：{"part":"中缝/拼接细节","sourceType":"近景或整门参考","color":"...","colorFamily":"...","material":"...","finish":"...","shape":"...","structure":"...","profile":"...","edge":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        '必须识别中缝宽窄、压条层次、止口方向、凹凸关系、收边倒角、拼接材质、颜色、阴影缝和与左右门扇的衔接方式。',
        '如果参考图包含整扇门，只能提取中缝/拼接区域；不能迁移门扇主体、包边、把手、锁体、气窗、背景或整门比例。',
        'applyDescription 必须说明如何把该中缝/拼接细节约束到第一张整门图已有中缝或拼缝位置，同时保持第一张整门图的门扇数量、每扇宽窄比例、把手和锁体位置不变。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    case 'background-reference':
      return [
        '请识别这张背景参考图中的空间背景特征，只返回 JSON。',
        '这张图是最终输出的背景底图，应尽量原样保留；本任务只是在背景图的目标门位上贴入第一张整门图里的门，不是重新生成或重绘背景。',
        'JSON 格式必须为：{"part":"背景","sourceType":"实景或效果图","color":"...","colorFamily":"...","material":"...","finish":"...","shape":"空间构图","structure":"...","profile":"...","edge":"...","details":"...","sampleBox":{"left":0.00,"top":0.00,"right":1.00,"bottom":1.00},"applyDescription":"..."}。',
        '必须识别空间类型、墙面颜色和材质、地面颜色和材质、光线方向、明暗、透视、背景层次、是否有家具或装饰物。',
        '必须重点识别背景图中的目标门位：如果背景图里已有旧门，就把旧门外轮廓、四角、门框内口、接地点和透视方向识别为目标门位；如果背景图里留了门洞、门框、空白门位或预留矩形区域，就把该门洞/门位识别为目标门位；如果没有明确门位，就选择最合理的可放门位置。',
        'sampleBox 必须框住背景图中目标门位、旧门、门洞或预留门位的整体外接矩形，坐标是相对整张图 0 到 1 的比例；不能框整张背景，也不能框家具、墙面大面积区域或无关装饰。',
        '如果背景参考图里也出现门，只能把那扇门当作“门位、透视、尺寸和遮挡关系”的定位参考，不能迁移那张图里的门款、门板线条、包边、把手、锁体、玻璃或门体颜色。',
        'applyDescription 必须说明如何把第一张整门图中的门抠出后放入背景图目标门位：按背景门位的四边和透视自动缩放、透视拉伸、旋转、裁切或补边，使门体边缘、门框、底边接地点和背景中的门洞/旧门位置对齐。',
        'applyDescription 还必须强调保持背景参考图的墙面、地面、家具、装饰、光线和空间原样；只允许覆盖旧门/门洞/目标门位区域并添加必要的接地阴影、遮挡和边缘融合。',
        'applyDescription 还必须强调保持第一张整门图的门体、包边、把手、锁体、玻璃、颜色、材质和门款不被重画；只做抠图贴合、透视对齐、阴影和光线融合。',
        '不要解释，不要输出 markdown。'
      ].join('\n');
    default:
      return '';
  }
}

function getPngSize(buffer) {
  if (!buffer || buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function getJpegSize(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const size = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + size;
  }
  return null;
}

function getImageSize(buffer, fileID) {
  const extension = getFileExtensionFromPath(fileID, 'png');
  if (extension === 'png') {
    return getPngSize(buffer);
  }
  if (extension === 'jpg' || extension === 'jpeg') {
    return getJpegSize(buffer);
  }
  return getPngSize(buffer) || getJpegSize(buffer);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeSampleBox(rawBox) {
  if (!rawBox || typeof rawBox !== 'object') {
    return null;
  }
  const left = Number(rawBox.left);
  const top = Number(rawBox.top);
  const right = Number(rawBox.right);
  const bottom = Number(rawBox.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) {
    return null;
  }
  const normalized = {
    left: clamp(left, 0, 1),
    top: clamp(top, 0, 1),
    right: clamp(right, 0, 1),
    bottom: clamp(bottom, 0, 1)
  };
  if (normalized.right - normalized.left < 0.03 || normalized.bottom - normalized.top < 0.03) {
    return null;
  }
  return normalized;
}

function getDefaultColorSampleBox(slotId, style) {
  if (slotId === 'color-sample') {
    return { left: 0.3, top: 0.3, right: 0.7, bottom: 0.7 };
  }
  if (slotId === 'edge-trim-detail') {
    const sourceType = `${style && style.sourceType || ''} ${style && style.details || ''}`;
    if (/近景|细节|局部|特写/.test(sourceType)) {
      return { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 };
    }
  }
  return null;
}

function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, ratio) {
  if (!values.length) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const index = clamp(Math.round((sorted.length - 1) * ratio), 0, sorted.length - 1);
  return sorted[index];
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function solveLinearSystem(matrix, values) {
  const n = values.length;
  const a = matrix.map((row, index) => row.concat(values[index]));
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(a[pivot][col]) < 1e-10) {
      return null;
    }
    if (pivot !== col) {
      const temp = a[col];
      a[col] = a[pivot];
      a[pivot] = temp;
    }
    const divisor = a[col][col];
    for (let k = col; k <= n; k += 1) {
      a[col][k] /= divisor;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = a[row][col];
      for (let k = col; k <= n; k += 1) {
        a[row][k] -= factor * a[col][k];
      }
    }
  }
  return a.map((row) => row[n]);
}

function getHomographyFromUnitSquareToQuad(quad) {
  const source = [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 }
  ];
  const target = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  const matrix = [];
  const values = [];
  for (let index = 0; index < 4; index += 1) {
    const { u, v } = source[index];
    const { x, y } = target[index];
    matrix.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    values.push(x);
    matrix.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    values.push(y);
  }
  const solved = solveLinearSystem(matrix, values);
  if (!solved) {
    return null;
  }
  return [
    solved[0], solved[1], solved[2],
    solved[3], solved[4], solved[5],
    solved[6], solved[7], 1
  ];
}

function invert3x3(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-10) {
    return null;
  }
  return [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det
  ];
}

function applyHomography(matrix, x, y) {
  const denominator = (matrix[6] * x) + (matrix[7] * y) + matrix[8];
  if (Math.abs(denominator) < 1e-10) {
    return null;
  }
  return {
    x: ((matrix[0] * x) + (matrix[1] * y) + matrix[2]) / denominator,
    y: ((matrix[3] * x) + (matrix[4] * y) + matrix[5]) / denominator
  };
}

function describeSampledColor(rgb) {
  if (!rgb) {
    return '';
  }
  return `${rgb.hex} / rgb(${rgb.r},${rgb.g},${rgb.b})`;
}

function getInsetSampleBox(box, xInsetRatio, yInsetRatio) {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  return normalizeSampleBox({
    left: box.left + (width * xInsetRatio),
    top: box.top + (height * yInsetRatio),
    right: box.right - (width * xInsetRatio),
    bottom: box.bottom - (height * yInsetRatio)
  });
}

function getRelativeSampleBox(parent, centerX, centerY, boxWidthRatio, boxHeightRatio) {
  const parentWidth = parent.right - parent.left;
  const parentHeight = parent.bottom - parent.top;
  const boxWidth = parentWidth * boxWidthRatio;
  const boxHeight = parentHeight * boxHeightRatio;
  let left = parent.left + (parentWidth * centerX) - (boxWidth / 2);
  let top = parent.top + (parentHeight * centerY) - (boxHeight / 2);
  let right = left + boxWidth;
  let bottom = top + boxHeight;
  if (left < parent.left) {
    right += parent.left - left;
    left = parent.left;
  }
  if (right > parent.right) {
    left -= right - parent.right;
    right = parent.right;
  }
  if (top < parent.top) {
    bottom += parent.top - top;
    top = parent.top;
  }
  if (bottom > parent.bottom) {
    top -= bottom - parent.bottom;
    bottom = parent.bottom;
  }
  return normalizeSampleBox({ left, top, right, bottom });
}

function dedupeSampleBoxes(boxes) {
  const seen = new Set();
  return boxes.filter((box) => {
    if (!box) {
      return false;
    }
    const key = [box.left, box.top, box.right, box.bottom]
      .map((value) => value.toFixed(4))
      .join(',');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getCandidateSampleBoxes(slotId, sampleBox) {
  if (slotId !== 'color-sample') {
    return [sampleBox];
  }
  const inner = getInsetSampleBox(sampleBox, 0.08, 0.08) || sampleBox;
  return dedupeSampleBoxes([
    getRelativeSampleBox(inner, 0.5, 0.38, 0.34, 0.22),
    getRelativeSampleBox(inner, 0.5, 0.5, 0.34, 0.22),
    getRelativeSampleBox(inner, 0.5, 0.62, 0.34, 0.22),
    getRelativeSampleBox(inner, 0.38, 0.48, 0.28, 0.2),
    getRelativeSampleBox(inner, 0.62, 0.48, 0.28, 0.2),
    getRelativeSampleBox(inner, 0.5, 0.46, 0.55, 0.36),
    inner,
    sampleBox
  ]);
}

async function readColorFromSampleBox(referenceBuffer, size, sampleBox, slotId, candidateIndex) {
  const width = size.width;
  const height = size.height;
  const left = clamp(Math.floor(sampleBox.left * width), 0, Math.max(width - 1, 0));
  const top = clamp(Math.floor(sampleBox.top * height), 0, Math.max(height - 1, 0));
  const extractWidth = clamp(Math.ceil((sampleBox.right - sampleBox.left) * width), 1, width - left);
  const extractHeight = clamp(Math.ceil((sampleBox.bottom - sampleBox.top) * height), 1, height - top);
  const targetWidth = Math.min(extractWidth, 140);
  const targetHeight = Math.max(1, Math.round(extractHeight * (targetWidth / extractWidth)));
  const { data, info } = await sharp(referenceBuffer)
    .rotate()
    .extract({ left, top, width: extractWidth, height: extractHeight })
    .resize({ width: targetWidth, height: targetHeight, fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const reds = [];
  const greens = [];
  const blues = [];
  const pixels = [];
  const lumas = [];
  for (let index = 0; index < data.length; index += info.channels) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    if (luma <= 10 || luma >= 246) {
      continue;
    }
    pixels.push({ r, g, b, luma });
    lumas.push(luma);
  }
  const totalPixels = Math.floor(data.length / info.channels);
  if (pixels.length < Math.max(20, totalPixels * 0.08)) {
    return null;
  }
  const lowLuma = percentile(lumas, 0.08);
  const highLuma = percentile(lumas, 0.92);
  for (const pixel of pixels) {
    if (pixel.luma < lowLuma || pixel.luma > highLuma) {
      continue;
    }
    reds.push(pixel.r);
    greens.push(pixel.g);
    blues.push(pixel.b);
  }
  if (reds.length < Math.max(20, totalPixels * 0.05)) {
    return null;
  }
  const r = median(reds);
  const g = median(greens);
  const b = median(blues);
  const distances = pixels.map((pixel) => Math.sqrt(
    ((pixel.r - r) ** 2) + ((pixel.g - g) ** 2) + ((pixel.b - b) ** 2)
  ));
  const colorSpread = median(distances);
  const lumaSpread = highLuma - lowLuma;
  const score = colorSpread + (lumaSpread * 0.35) + (candidateIndex * 0.6);
  return {
    r,
    g,
    b,
    hex: rgbToHex(r, g, b),
    sampleBox,
    pixelCount: reds.length,
    totalPixels,
    colorSpread: Math.round(colorSpread * 100) / 100,
    lumaSpread: Math.round(lumaSpread * 100) / 100,
    score: Math.round(score * 100) / 100,
    method: `${slotId || 'reference'}-stable-window-trimmed-median-rgb`
  };
}

function getQuadBounds(quad, size) {
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  return {
    left: clamp(Math.floor(Math.min(...points.map((point) => point.x))), 0, Math.max(size.width - 1, 0)),
    top: clamp(Math.floor(Math.min(...points.map((point) => point.y))), 0, Math.max(size.height - 1, 0)),
    right: clamp(Math.ceil(Math.max(...points.map((point) => point.x))), 1, size.width),
    bottom: clamp(Math.ceil(Math.max(...points.map((point) => point.y))), 1, size.height)
  };
}

function expandQuadFromCenter(quad, size, xRatio, yRatio, minPixels) {
  if (!quad || !size || !size.width || !size.height) {
    return quad;
  }
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
  const bounds = getQuadBounds(quad, size);
  const expandX = Math.max(minPixels || 0, (bounds.right - bounds.left) * xRatio);
  const expandY = Math.max(minPixels || 0, (bounds.bottom - bounds.top) * yRatio);
  const expandPoint = (point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const lengthX = Math.max(Math.abs(dx), 1);
    const lengthY = Math.max(Math.abs(dy), 1);
    return {
      x: clamp(Math.round(point.x + (Math.sign(dx || (point.x < center.x ? -1 : 1)) * expandX * (Math.abs(dx) / lengthX))), 0, size.width - 1),
      y: clamp(Math.round(point.y + (Math.sign(dy || (point.y < center.y ? -1 : 1)) * expandY * (Math.abs(dy) / lengthY))), 0, size.height - 1)
    };
  };
  return {
    topLeft: expandPoint(quad.topLeft),
    topRight: expandPoint(quad.topRight),
    bottomRight: expandPoint(quad.bottomRight),
    bottomLeft: expandPoint(quad.bottomLeft),
    source: `${quad.source || 'quad'}-expanded`
  };
}

function expandDoorwayQuad(quad, size) {
  if (!quad || !size || !size.width || !size.height) {
    return quad;
  }
  const bounds = getQuadBounds(quad, size);
  const expandX = Math.max(4, (bounds.right - bounds.left) * 0.01);
  const expandTop = Math.max(3, (bounds.bottom - bounds.top) * 0.004);
  const expandBottom = Math.max(0, (bounds.bottom - bounds.top) * 0.001);
  return {
    topLeft: {
      x: clamp(Math.round(quad.topLeft.x - expandX), 0, size.width - 1),
      y: clamp(Math.round(quad.topLeft.y - expandTop), 0, size.height - 1)
    },
    topRight: {
      x: clamp(Math.round(quad.topRight.x + expandX), 0, size.width - 1),
      y: clamp(Math.round(quad.topRight.y - expandTop), 0, size.height - 1)
    },
    bottomRight: {
      x: clamp(Math.round(quad.bottomRight.x + expandX), 0, size.width - 1),
      y: clamp(Math.round(quad.bottomRight.y + expandBottom), 0, size.height - 1)
    },
    bottomLeft: {
      x: clamp(Math.round(quad.bottomLeft.x - expandX), 0, size.width - 1),
      y: clamp(Math.round(quad.bottomLeft.y + expandBottom), 0, size.height - 1)
    },
    source: `${quad.source || 'quad'}-doorway-expanded`
  };
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - (2 * t));
}

function sampleRawBilinear(data, width, height, channels, x, y) {
  const x0 = clamp(Math.floor(x), 0, width - 1);
  const y0 = clamp(Math.floor(y), 0, height - 1);
  const x1 = clamp(x0 + 1, 0, width - 1);
  const y1 = clamp(y0 + 1, 0, height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const topLeft = ((y0 * width) + x0) * channels;
  const topRight = ((y0 * width) + x1) * channels;
  const bottomLeft = ((y1 * width) + x0) * channels;
  const bottomRight = ((y1 * width) + x1) * channels;
  const result = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const top = (data[topLeft + channel] * (1 - tx)) + (data[topRight + channel] * tx);
    const bottom = (data[bottomLeft + channel] * (1 - tx)) + (data[bottomRight + channel] * tx);
    result[channel] = (top * (1 - ty)) + (bottom * ty);
  }
  return result;
}

function mixColor(source, target, ratio) {
  return [
    source[0] * (1 - ratio) + target[0] * ratio,
    source[1] * (1 - ratio) + target[1] * ratio,
    source[2] * (1 - ratio) + target[2] * ratio,
    source[3]
  ];
}

function colorDistance(a, b) {
  return Math.sqrt(
    ((a[0] - b[0]) ** 2) +
    ((a[1] - b[1]) ** 2) +
    ((a[2] - b[2]) ** 2)
  );
}

async function composeDoorIntoBackground(primaryBuffer, backgroundBuffer, placement) {
  if (!sharp || !primaryBuffer || !backgroundBuffer || !placement || !placement.sourceDoorBox || !placement.targetDoorQuad) {
    return null;
  }
  const sourceBox = placement.sourceDoorBox;
  const targetQuad = placement.targetDoorQuad;
  const backgroundMetadata = await sharp(backgroundBuffer).rotate().metadata();
  const backgroundSize = {
    width: backgroundMetadata.width || 0,
    height: backgroundMetadata.height || 0
  };
  if (!backgroundSize.width || !backgroundSize.height) {
    return null;
  }
  const backgroundRaw = await sharp(backgroundBuffer)
    .rotate()
    .resize(backgroundSize.width, backgroundSize.height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const source = await sharp(primaryBuffer)
    .rotate()
    .extract({
      left: sourceBox.left,
      top: sourceBox.top,
      width: sourceBox.width,
      height: sourceBox.height
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sourceWidth = source.info.width;
  const sourceHeight = source.info.height;
  const sourceChannels = source.info.channels;
  const bounds = getQuadBounds(targetQuad, backgroundSize);
  const overlay = Buffer.alloc(backgroundSize.width * backgroundSize.height * 4);
  const homography = getHomographyFromUnitSquareToQuad(targetQuad);
  const inverse = homography ? invert3x3(homography) : null;
  if (!inverse) {
    return null;
  }
  const shadow = Buffer.alloc(backgroundSize.width * backgroundSize.height * 4);
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const uv = applyHomography(inverse, x + 0.5, y + 0.5);
      if (!uv || uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) {
        continue;
      }
      const sourceX = clamp(uv.x * (sourceWidth - 1), 0, sourceWidth - 1);
      const sourceY = clamp(uv.y * (sourceHeight - 1), 0, sourceHeight - 1);
      let sampled = sampleRawBilinear(source.data, sourceWidth, sourceHeight, sourceChannels, sourceX, sourceY);
      let alphaScale = 1;
      let floorSampleForCleanup = null;
      const floorUv = applyHomography(homography, uv.x, 1.018);
      if (floorUv) {
        const floorX = clamp(floorUv.x, 0, backgroundSize.width - 1);
        const floorY = clamp(floorUv.y + Math.max(3, backgroundSize.height * 0.006), 0, backgroundSize.height - 1);
        const floorSample = sampleRawBilinear(
          backgroundRaw.data,
          backgroundSize.width,
          backgroundSize.height,
          backgroundRaw.info.channels,
          floorX,
          floorY
        );
        floorSampleForCleanup = floorSample;
        const bottomWeight = smoothstep(0.955, 1, uv.y);
        const distanceWeight = smoothstep(28, 120, colorDistance(sampled, floorSample));
        const blendRatio = clamp(bottomWeight * distanceWeight * 0.42, 0, 0.42);
        if (blendRatio > 0.01) {
          sampled = mixColor(sampled, floorSample, blendRatio);
        }
      }
      const bottomCornerWeight = Math.max(
        uv.x < 0.09 ? 1 - smoothstep(0.018, 0.09, uv.x) : 0,
        uv.x > 0.91 ? smoothstep(0.91, 0.982, uv.x) : 0
      ) * smoothstep(0.955, 0.998, uv.y);
      if (bottomCornerWeight > 0.01) {
        if (floorSampleForCleanup) {
          sampled = mixColor(sampled, floorSampleForCleanup, bottomCornerWeight * 0.65);
        }
        alphaScale = 1 - (bottomCornerWeight * 0.96);
      }
      const edgeDistance = Math.min(uv.x, 1 - uv.x, uv.y, 1 - uv.y);
      const edgeAlpha = smoothstep(0, 0.004, edgeDistance);
      const alpha = Math.round(edgeAlpha * alphaScale * 255);
      const targetIndex = ((y * backgroundSize.width) + x) * 4;
      overlay[targetIndex] = clamp(Math.round(sampled[0]), 0, 255);
      overlay[targetIndex + 1] = clamp(Math.round(sampled[1]), 0, 255);
      overlay[targetIndex + 2] = clamp(Math.round(sampled[2]), 0, 255);
      overlay[targetIndex + 3] = Math.min(alpha, sampled[3] == null ? 255 : clamp(Math.round(sampled[3]), 0, 255));

      const shadowIndex = targetIndex;
      const verticalWeight = smoothstep(0.55, 1, uv.y);
      const edgeWeight = 1 - smoothstep(0.035, 0.11, edgeDistance);
      const shadowAlpha = Math.round(42 * Math.max(edgeWeight, verticalWeight * 0.55) * edgeAlpha);
      shadow[shadowIndex] = 0;
      shadow[shadowIndex + 1] = 0;
      shadow[shadowIndex + 2] = 0;
      shadow[shadowIndex + 3] = clamp(shadowAlpha, 0, 48);
    }
  }
  const softShadow = await sharp(shadow, {
    raw: {
      width: backgroundSize.width,
      height: backgroundSize.height,
      channels: 4
    }
  })
    .blur(4)
    .png()
    .toBuffer();
  return sharp(backgroundBuffer)
    .rotate()
    .resize(backgroundSize.width, backgroundSize.height, { fit: 'fill' })
    .composite([
      {
        input: softShadow,
        left: 0,
        top: 0
      },
      {
        input: overlay,
        raw: {
          width: backgroundSize.width,
          height: backgroundSize.height,
          channels: 4
        },
        left: 0,
        top: 0
      }
    ])
    .png()
    .toBuffer();
}

function getBottomSeamRepairRegion(quad, size) {
  if (!quad || !size || !size.width || !size.height) {
    return null;
  }
  const bottomCenter = {
    x: (quad.bottomLeft.x + quad.bottomRight.x) / 2,
    y: (quad.bottomLeft.y + quad.bottomRight.y) / 2
  };
  const bounds = getQuadBounds(quad, size);
  const doorWidth = bounds.right - bounds.left;
  const cropSize = clamp(Math.round(doorWidth * 1.12), 260, Math.min(size.width, size.height, 720));
  let left = Math.round(bottomCenter.x - (cropSize / 2));
  let top = Math.round(bottomCenter.y - (cropSize * 0.68));
  left = clamp(left, 0, Math.max(size.width - cropSize, 0));
  top = clamp(top, 0, Math.max(size.height - cropSize, 0));
  const seamY = clamp(Math.round(bottomCenter.y - top), 0, cropSize - 1);
  const bandHeight = clamp(Math.round(cropSize * 0.12), 24, 56);
  const bandTop = clamp(seamY - Math.round(bandHeight * 0.55), 0, cropSize - 1);
  const bandBottom = clamp(seamY + Math.round(bandHeight * 0.65), bandTop + 1, cropSize);
  return {
    cropBox: {
      left,
      top,
      width: cropSize,
      height: cropSize
    },
    maskBox: {
      left: Math.round(cropSize * 0.22),
      top: bandTop,
      right: Math.round(cropSize * 0.78),
      bottom: bandBottom
    }
  };
}

function normalizeLocalBox(rawBox, size) {
  if (!rawBox || !size || !size.width || !size.height) {
    return null;
  }
  const left = clamp(Math.round(Number(rawBox.left)), 0, Math.max(size.width - 1, 0));
  const top = clamp(Math.round(Number(rawBox.top)), 0, Math.max(size.height - 1, 0));
  const right = clamp(Math.round(Number(rawBox.right)), left + 1, size.width);
  const bottom = clamp(Math.round(Number(rawBox.bottom)), top + 1, size.height);
  if (right - left < 3 || bottom - top < 3) {
    return null;
  }
  return { left, top, right, bottom };
}

async function detectBottomNonDoorResidues(cropBuffer, cropSize) {
  const response = await openai.responses.create(getVisionResponseRequest([
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: [
            '你只做图片缺陷定位，不修图。',
            `这是一张门底部局部裁剪图，坐标基于该裁剪图 width=${cropSize.width}, height=${cropSize.height}。`,
            '请只找出门底附近明显“不属于门体/门套/门槛结构”的源图背景残留块，例如白底、灰白块、旧背景角、错误地板块、矩形贴图残留。',
            '不要把真实门套脚、门框线、门槛、门底板、门体阴影或地板本身标为缺陷。',
            '只返回 JSON，不要解释，不要 markdown。',
            'JSON 格式：{"regions":[{"box":{"left":整数,"top":整数,"right":整数,"bottom":整数},"confidence":"high|medium|low","reason":"..."}]}。',
            '如果没有明确残留，返回 {"regions":[] }。'
          ].join('\n')
        },
        {
          type: 'input_image',
          image_url: `data:image/png;base64,${cropBuffer.toString('base64')}`
        }
      ]
    }
  ]));
  const parsed = extractJsonObject(response.output_text || '');
  const regions = Array.isArray(parsed && parsed.regions) ? parsed.regions : [];
  return regions
    .filter((region) => /high|medium/i.test(String(region.confidence || '')))
    .map((region) => ({
      box: normalizeLocalBox(region.box, cropSize),
      confidence: region.confidence || '',
      reason: region.reason || ''
    }))
    .filter((region) => region.box);
}

async function blendBottomResiduesWithFloor(imageBuffer, placement) {
  if (!sharp || !imageBuffer || !placement || !placement.targetDoorQuad) {
    return imageBuffer;
  }
  const metadata = await sharp(imageBuffer).metadata();
  const size = {
    width: metadata.width || 0,
    height: metadata.height || 0
  };
  if (!size.width || !size.height) {
    return imageBuffer;
  }
  const region = getBottomSeamRepairRegion(placement.targetDoorQuad, size);
  if (!region) {
    return imageBuffer;
  }
  const cropBuffer = await sharp(imageBuffer)
    .extract(region.cropBox)
    .png()
    .toBuffer();
  const detected = await detectBottomNonDoorResidues(cropBuffer, {
    width: region.cropBox.width,
    height: region.cropBox.height
  });
  if (!detected.length) {
    return imageBuffer;
  }
  const cropRaw = await sharp(cropBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const data = Buffer.from(cropRaw.data);
  for (const detectedRegion of detected) {
    const box = detectedRegion.box;
    const sampleY = clamp(box.bottom + Math.max(3, Math.round(region.cropBox.height * 0.01)), 0, region.cropBox.height - 1);
    for (let y = box.top; y < box.bottom; y += 1) {
      for (let x = box.left; x < box.right; x += 1) {
        const index = ((y * region.cropBox.width) + x) * 4;
        const sample = sampleRawBilinear(
          cropRaw.data,
          region.cropBox.width,
          region.cropBox.height,
          4,
          x,
          sampleY
        );
        const centerX = (box.left + box.right) / 2;
        const centerY = (box.top + box.bottom) / 2;
        const dx = Math.abs(x - centerX) / Math.max((box.right - box.left) / 2, 1);
        const dy = Math.abs(y - centerY) / Math.max((box.bottom - box.top) / 2, 1);
        const feather = clamp(1 - Math.max(dx, dy), 0, 1);
        const ratio = 0.35 + (smoothstep(0, 1, feather) * 0.55);
        data[index] = clamp(Math.round((data[index] * (1 - ratio)) + (sample[0] * ratio)), 0, 255);
        data[index + 1] = clamp(Math.round((data[index + 1] * (1 - ratio)) + (sample[1] * ratio)), 0, 255);
        data[index + 2] = clamp(Math.round((data[index + 2] * (1 - ratio)) + (sample[2] * ratio)), 0, 255);
        data[index + 3] = clamp(Math.round(data[index + 3] * (1 - (ratio * 0.72))), 0, 255);
      }
    }
  }
  const repairedCrop = await sharp(data, {
    raw: {
      width: region.cropBox.width,
      height: region.cropBox.height,
      channels: 4
    }
  })
    .png()
    .toBuffer();
  return sharp(imageBuffer)
    .composite([{
      input: repairedCrop,
      left: region.cropBox.left,
      top: region.cropBox.top
    }])
    .png()
    .toBuffer();
}

async function sampleVisibleMedianColor(referenceImage, referenceBuffer, style) {
  if (!sharp || !referenceBuffer) {
    return null;
  }
  const slotId = referenceImage && referenceImage.slotId;
  const sampleBox = normalizeSampleBox(style && style.sampleBox) || getDefaultColorSampleBox(slotId, style);
  if (!sampleBox) {
    return null;
  }
  const metadata = await sharp(referenceBuffer).rotate().metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) {
    return null;
  }
  const candidates = getCandidateSampleBoxes(slotId, sampleBox);
  const sampled = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const result = await readColorFromSampleBox(
      referenceBuffer,
      { width, height },
      candidates[index],
      slotId,
      index
    );
    if (result) {
      sampled.push(result);
    }
  }
  if (!sampled.length) {
    return null;
  }
  sampled.sort((a, b) => a.score - b.score);
  return {
    ...sampled[0],
    sourceSampleBox: sampleBox,
    candidateCount: candidates.length,
    acceptedCandidateCount: sampled.length
  };
}

function buildHandleMaskBuffer(width, height, box) {
  const rowLength = 1 + (width * 4);
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixelStart = rowStart + 1 + (x * 4);
      const inside = x >= box.left && x < box.right && y >= box.top && y < box.bottom;
      raw[pixelStart] = 255;
      raw[pixelStart + 1] = 255;
      raw[pixelStart + 2] = 255;
      raw[pixelStart + 3] = inside ? 0 : 255;
    }
  }

  const chunks = [];
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  chunks.push(pngHeader);

  function createChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBuffer, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((crc32(crcInput) >>> 0), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(createChunk('IHDR', ihdr));
  chunks.push(createChunk('IDAT', zlib.deflateSync(raw)));
  chunks.push(createChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function buildCompositeMaskBuffer(width, height, box) {
  const rowLength = 1 + (width * 4);
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixelStart = rowStart + 1 + (x * 4);
      const inside = x >= box.left && x < box.right && y >= box.top && y < box.bottom;
      raw[pixelStart] = 255;
      raw[pixelStart + 1] = 255;
      raw[pixelStart + 2] = 255;
      raw[pixelStart + 3] = inside ? 255 : 0;
    }
  }

  const chunks = [];
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  chunks.push(pngHeader);

  function createChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBuffer, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((crc32(crcInput) >>> 0), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(createChunk('IHDR', ihdr));
  chunks.push(createChunk('IDAT', zlib.deflateSync(raw)));
  chunks.push(createChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeMaskBox(rawBox, size, source) {
  if (!rawBox || !size || !size.width || !size.height) {
    return null;
  }
  const left = clamp(Math.round(rawBox.left), 0, Math.max(size.width - 1, 0));
  const top = clamp(Math.round(rawBox.top), 0, Math.max(size.height - 1, 0));
  const right = clamp(Math.round(rawBox.right), left + 1, size.width);
  const bottom = clamp(Math.round(rawBox.bottom), top + 1, size.height);
  if (right <= left || bottom <= top) {
    return null;
  }
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    source: source || rawBox.source || 'unknown'
  };
}

function normalizePoint(rawPoint, size) {
  if (!rawPoint || !size || !size.width || !size.height) {
    return null;
  }
  const x = Number(rawPoint.x);
  const y = Number(rawPoint.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return {
    x: clamp(Math.round(x), 0, Math.max(size.width - 1, 0)),
    y: clamp(Math.round(y), 0, Math.max(size.height - 1, 0))
  };
}

function normalizeCornerQuad(rawQuad, size, source) {
  if (!rawQuad || !size || !size.width || !size.height) {
    return null;
  }
  const topLeft = normalizePoint(rawQuad.topLeft || rawQuad.tl, size);
  const topRight = normalizePoint(rawQuad.topRight || rawQuad.tr, size);
  const bottomRight = normalizePoint(rawQuad.bottomRight || rawQuad.br, size);
  const bottomLeft = normalizePoint(rawQuad.bottomLeft || rawQuad.bl, size);
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) {
    return null;
  }
  const xs = [topLeft.x, topRight.x, bottomRight.x, bottomLeft.x];
  const ys = [topLeft.y, topRight.y, bottomRight.y, bottomLeft.y];
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  if (width < size.width * 0.08 || height < size.height * 0.15) {
    return null;
  }
  return {
    topLeft,
    topRight,
    bottomRight,
    bottomLeft,
    source: source || rawQuad.source || 'unknown'
  };
}

function boxToQuad(box) {
  if (!box) {
    return null;
  }
  return {
    topLeft: { x: box.left, y: box.top },
    topRight: { x: box.right, y: box.top },
    bottomRight: { x: box.right, y: box.bottom },
    bottomLeft: { x: box.left, y: box.bottom },
    source: box.source || 'box'
  };
}

function inferHandleMaskBox(size, handleBuffer, job) {
  if (!size || !size.width || !size.height) {
    return null;
  }
  const aspect = handleBuffer && handleBuffer.length ? 0.28 : 0.22;
  const boxWidth = Math.max(Math.round(size.width * aspect), 140);
  const boxHeight = Math.max(Math.round(boxWidth * 1.4), 180);
  const isDoubleDoor = /双开|子母|四开|六开/.test(job && job.doorType || '');
  const centerX = isDoubleDoor ? size.width * 0.5 : size.width * 0.78;
  const centerY = size.height * 0.5;
  return normalizeMaskBox({
    left: centerX - (boxWidth / 2),
    top: centerY - (boxHeight / 2),
    right: centerX + (boxWidth / 2),
    bottom: centerY + (boxHeight / 2)
  }, size, isDoubleDoor ? 'door-type-center-heuristic' : 'door-type-side-heuristic');
}

function inferLockMaskBox(size, lockBuffer, job) {
  if (!size || !size.width || !size.height) {
    return null;
  }
  const isDoubleDoor = /双开|子母|四开|六开/.test(job && job.doorType || '');
  const boxWidthRatio = isDoubleDoor ? 0.28 : 0.22;
  const boxHeightRatio = lockBuffer && lockBuffer.length ? 0.42 : 0.34;
  const boxWidth = Math.max(Math.round(size.width * boxWidthRatio), isDoubleDoor ? 220 : 160);
  const boxHeight = Math.max(Math.round(size.height * boxHeightRatio), 280);
  const centerX = isDoubleDoor ? size.width * 0.5 : size.width * 0.72;
  const centerY = size.height * 0.58;
  return normalizeMaskBox({
    left: centerX - (boxWidth / 2),
    top: centerY - (boxHeight / 2),
    right: centerX + (boxWidth / 2),
    bottom: centerY + (boxHeight / 2)
  }, size, isDoubleDoor ? 'lock-center-heuristic' : 'lock-side-heuristic');
}

function getDirectHandleTargetBox(size, job, maskBox) {
  if (maskBox && !/heuristic/i.test(maskBox.source || '')) {
    return maskBox;
  }
  if (!size || !size.width || !size.height) {
    return null;
  }
  const isDoubleDoor = /双开|子母|四开|六开/.test(job && job.doorType || '');
  const boxWidth = Math.max(Math.round(size.width * (isDoubleDoor ? 0.22 : 0.16)), isDoubleDoor ? 180 : 120);
  const boxHeight = Math.max(Math.round(size.height * 0.34), 260);
  const centerX = isDoubleDoor ? size.width * 0.5 : size.width * 0.72;
  const centerY = size.height * (isDoubleDoor ? 0.62 : 0.56);
  return normalizeMaskBox({
    left: centerX - (boxWidth / 2),
    top: centerY - (boxHeight / 2),
    right: centerX + (boxWidth / 2),
    bottom: centerY + (boxHeight / 2)
  }, size, isDoubleDoor ? 'direct-handle-center-heuristic' : 'direct-handle-side-heuristic');
}

function getHeuristicReferenceHandleBox(size, job) {
  if (!size || !size.width || !size.height) {
    return null;
  }
  const isDoubleDoor = /双开|子母|四开|六开/.test(job && job.doorType || '');
  const left = isDoubleDoor ? 0.36 : 0.54;
  const right = isDoubleDoor ? 0.64 : 0.86;
  return normalizeMaskBox({
    left: size.width * left,
    top: size.height * 0.48,
    right: size.width * right,
    bottom: size.height * 0.9
  }, size, 'reference-handle-heuristic');
}

function getLuminance(data, index) {
  return (data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114);
}

function getRawLuminanceStats(data, pixelCount) {
  if (!data || !pixelCount) {
    return { mean: 0, variance: 0, stddev: 0 };
  }
  let total = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    total += getLuminance(data, pixel * 4);
  }
  const mean = total / pixelCount;
  let varianceTotal = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const delta = getLuminance(data, pixel * 4) - mean;
    varianceTotal += delta * delta;
  }
  const variance = varianceTotal / pixelCount;
  return { mean, variance, stddev: Math.sqrt(variance) };
}

async function buildBrightForegroundOverlay(referenceBuffer, referenceBox, targetBox) {
  if (!sharp || !referenceBuffer || !referenceBox || !targetBox) {
    return null;
  }
  const width = targetBox.width;
  const height = targetBox.height;
  const raw = await sharp(referenceBuffer)
    .rotate()
    .extract({
      left: referenceBox.left,
      top: referenceBox.top,
      width: referenceBox.width,
      height: referenceBox.height
    })
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = raw.info.channels;
  if (channels < 4) {
    return null;
  }
  const pixelCount = width * height;
  const stats = getRawLuminanceStats(raw.data, pixelCount);
  const threshold = Math.min(235, stats.mean + Math.max(26, stats.stddev * 0.55));
  const output = Buffer.alloc(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const sourceIndex = pixel * channels;
    const targetIndex = pixel * 4;
    const luminance = getLuminance(raw.data, sourceIndex);
    const alpha = clamp(Math.round(((luminance - threshold) / 44) * 255), 0, 230);
    output[targetIndex] = raw.data[sourceIndex];
    output[targetIndex + 1] = raw.data[sourceIndex + 1];
    output[targetIndex + 2] = raw.data[sourceIndex + 2];
    output[targetIndex + 3] = alpha < 24 ? 0 : alpha;
  }
  return sharp(output, {
    raw: {
      width,
      height,
      channels: 4
    }
  }).png().toBuffer();
}

async function buildDirectHandleCompositeFallback(job, editArtifacts, error) {
  if (!ENABLE_DIRECT_HANDLE_COMPOSITE_FALLBACK) {
    return null;
  }
  if (!sharp || !editArtifacts || !editArtifacts.primaryBuffer || !editArtifacts.primarySize) {
    return null;
  }
  const targetParts = getTargetPartKeys(job);
  if (targetParts.length && !(targetParts.length === 1 && targetParts[0] === 'handle')) {
    return null;
  }
  const handleDetail = editArtifacts.handleDetail;
  const handleBuffer = editArtifacts.handleBuffer;
  if (!handleDetail || !handleBuffer) {
    return null;
  }
  const referenceSize = getImageSize(handleBuffer, handleDetail.originalImageFileID);
  const referenceBox = getHeuristicReferenceHandleBox(referenceSize, job);
  const targetBox = getDirectHandleTargetBox(editArtifacts.primarySize, job, editArtifacts.maskBox);
  if (!referenceBox || !targetBox) {
    return null;
  }
  const blurredPatch = await sharp(editArtifacts.primaryBuffer)
    .rotate()
    .extract({
      left: targetBox.left,
      top: targetBox.top,
      width: targetBox.width,
      height: targetBox.height
    })
    .blur(18)
    .modulate({ brightness: 0.98 })
    .png()
    .toBuffer();
  const overlay = await buildBrightForegroundOverlay(handleBuffer, referenceBox, targetBox);
  if (!overlay) {
    return null;
  }
  console.warn('[worker] using direct handle composite fallback after image api failure', {
    jobId: job && (job._id || job.jobId),
    targetBox,
    referenceBox,
    imageError: error && error.message ? error.message : String(error || '')
  });
  return sharp(editArtifacts.primaryBuffer)
    .rotate()
    .composite([
      { input: blurredPatch, left: targetBox.left, top: targetBox.top },
      { input: overlay, left: targetBox.left, top: targetBox.top }
    ])
    .png()
    .toBuffer();
}

function sampleBoxToMaskBox(sampleBox, size, source) {
  const normalized = normalizeSampleBox(sampleBox);
  if (!normalized || !size || !size.width || !size.height) {
    return null;
  }
  const expandX = Math.max(0.015, (normalized.right - normalized.left) * 0.035);
  const expandY = Math.max(0.015, (normalized.bottom - normalized.top) * 0.035);
  return normalizeMaskBox({
    left: Math.floor((normalized.left - expandX) * size.width),
    top: Math.floor((normalized.top - expandY) * size.height),
    right: Math.ceil((normalized.right + expandX) * size.width),
    bottom: Math.ceil((normalized.bottom + expandY) * size.height)
  }, size, source || 'sample-box');
}

function toDataUrl(buffer, fileID) {
  return `data:${getMimeType(getFileExtensionFromPath(fileID, 'png'))};base64,${buffer.toString('base64')}`;
}

function extractJsonObject(text) {
  if (!text) {
    return null;
  }
  const matched = /\{[\s\S]*\}/.exec(text);
  if (!matched) {
    return null;
  }
  try {
    return JSON.parse(matched[0]);
  } catch (error) {
    return null;
  }
}

async function detectHandleStyle(primaryBuffer, primaryFileID, handleBuffer, handleFileID) {
  if (!handleBuffer) {
    return null;
  }
  const response = await openai.responses.create(getVisionResponseRequest([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '请识别第二张门把手细节图中的门把手外观特征，只返回 JSON。',
              'JSON 格式必须为：{"color":"...","material":"...","finish":"...","shape":"...","base":"...","details":"...","containsSmartLock":true或false,"smartLockInterference":"..."}。',
              '其中 color 表示可见主颜色，material 表示材质，finish 表示表面工艺或质感，shape 表示主体造型，base 表示把手底座/面板特征，details 表示纹路、转角、装饰、镂空、线条等关键细节。',
              '第二张图只作为“门把手”参考；如果图里同时出现智能锁、黑色锁面板、密码键盘、指纹头、摄像头、猫眼、锁芯、圆形应急孔或门铃，请把它们标记为 smartLockInterference，不要混入门把手的 shape/base/details。',
              'containsSmartLock 表示第二张门把手细节图是否包含上述锁体/智能锁干扰物；smartLockInterference 简述这些非把手部件的位置和外观。',
              '不要解释，不要输出 markdown。'
            ].join('\n')
          },
          {
            type: 'input_image',
            image_url: toDataUrl(primaryBuffer, primaryFileID)
          },
          {
            type: 'input_image',
            image_url: toDataUrl(handleBuffer, handleFileID)
          }
        ]
      }
    ]));
  const parsed = extractJsonObject(response.output_text || '');
  if (!parsed) {
    return null;
  }
  return {
    color: parsed.color || '',
    colorFamily: parsed.colorFamily || '',
    undertone: parsed.undertone || '',
    brightness: parsed.brightness || '',
    saturation: parsed.saturation || '',
    hueLock: parsed.hueLock || '',
    toneLock: parsed.toneLock || '',
    material: parsed.material || '',
    finish: parsed.finish || '',
    shape: parsed.shape || '',
    base: parsed.base || '',
    details: parsed.details || '',
    containsSmartLock: Boolean(parsed.containsSmartLock),
    smartLockInterference: parsed.smartLockInterference || ''
  };
}

async function detectHandleMaskBox(primaryBuffer, primaryFileID, handleBuffer, handleFileID, size, job) {
  if (!primaryBuffer || !handleBuffer || !size) {
    return null;
  }
  const response = await openai.responses.create(getVisionResponseRequest([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '你要定位整门照中的门把手区域。',
              `门类型：${job && job.doorType ? job.doorType : '未指定'}`,
              '第一张图是整门照，第二张图是要融合上去的门把手细节图。',
              '请在整门照中找到最适合替换为该门把手的位置。',
              '注意：第二张门把手图如果包含智能锁、黑色锁面板、密码键盘、指纹头、摄像头、猫眼、锁芯或圆形应急孔，这些都不是把手替换目标。',
              '如果第一张整门照原本有智能锁，请不要把智能锁区域框进把手 mask；只框住原把手握持件、把手底座及极小衔接边缘。',
              '如果把手和智能锁距离很近，优先给出更小的把手-only 框，宁可少框一点，也不要覆盖整门照中的原智能锁。',
              '只返回 JSON，不要返回任何额外文字。',
              'JSON 格式必须为：{"left":整数,"top":整数,"right":整数,"bottom":整数}。',
              `坐标基于第一张图原始尺寸 width=${size.width}, height=${size.height}。`,
              '如果门上已有把手，就框住原把手区域；如果不明显，也要给出最合理的门把手安装区域。'
            ].join('\n')
          },
          {
            type: 'input_image',
            image_url: toDataUrl(primaryBuffer, primaryFileID)
          },
          {
            type: 'input_image',
            image_url: toDataUrl(handleBuffer, handleFileID)
          }
        ]
      }
    ]));
  const text = response.output_text || '';
  const parsed = extractJsonObject(text);
  return normalizeMaskBox(parsed, size, 'vision-detected');
}

async function detectLockMaskBox(primaryBuffer, primaryFileID, lockBuffer, lockFileID, size, job) {
  if (!primaryBuffer || !lockBuffer || !size) {
    return null;
  }
  const response = await openai.responses.create(getVisionResponseRequest([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '你要定位整门照中的锁体/智能锁安装编辑区域，只做坐标定位，不生成图片。',
              `门类型：${job && job.doorType ? job.doorType : '未指定'}`,
              '第一张图是整门照，第二张图是要融合上去的锁体/智能锁参考图。',
              '请在第一张整门照中找到最适合安装或替换该锁体/智能锁的位置，并返回一个局部编辑框。',
              '编辑框必须覆盖：原锁体、旧智能锁、钥匙孔、小圆孔、猫眼/门铃、与锁体冲突的把手底座，以及放置新智能锁面板所需的必要衔接区域。',
              '如果参考图是一体式把手智能锁，编辑框还必须覆盖整门照中原把手或新一体式把手需要占用的区域。',
              '如果参考图只是单个智能锁/单侧把手锁，不要默认框住双开门左右两根把手，也不要让编辑框横跨中缝居中覆盖左右两扇门；只覆盖安装智能锁所在主开启扇一侧，以及与该锁体直接冲突的局部把手/底座。只有参考图明确是双把手/双锁，或客户明确要求两侧都换，才允许覆盖中缝两侧全部五金。',
              '如果参考图是非一体式智能锁，只框锁具面板和必要安装区，不要框完整门扇；但不能因为想保留原把手而把智能锁安装区域框得过小。',
              '不要把门头、门柱、整扇门板、阴影、背景或装饰花纹当作锁体编辑区域。',
              '只返回 JSON，不要返回任何额外文字。',
              'JSON 格式必须为：{"left":整数,"top":整数,"right":整数,"bottom":整数,"confidence":"high|medium|low","notes":"..."}。',
              `坐标基于第一张图原始尺寸 width=${size.width}, height=${size.height}。`,
              '如果第一张整门照中没有明显锁具，也要根据门型、门缝、把手位置和参考图比例给出最合理的智能锁安装局部区域。'
            ].join('\n')
          },
          {
            type: 'input_image',
            image_url: toDataUrl(primaryBuffer, primaryFileID)
          },
          {
            type: 'input_image',
            image_url: toDataUrl(lockBuffer, lockFileID)
          }
        ]
      }
    ]));
  const parsed = extractJsonObject(response.output_text || '');
  return normalizeMaskBox(parsed, size, parsed && parsed.confidence ? `lock-vision-${parsed.confidence}` : 'lock-vision-detected');
}

async function detectDoorPlacement(primaryBuffer, primaryFileID, backgroundBuffer, backgroundFileID, primarySize, backgroundSize, job) {
  if (!primaryBuffer || !backgroundBuffer || !primarySize || !backgroundSize) {
    return null;
  }
  const response = await openai.responses.create(getVisionResponseRequest([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '你只做坐标定位，不生成图片。',
              '第一张图是要抠出的主门整门照，第二张图是最终背景图。',
              `第一张图尺寸 width=${primarySize.width}, height=${primarySize.height}。第二张图尺寸 width=${backgroundSize.width}, height=${backgroundSize.height}。`,
              `门类型：${job && job.doorType ? job.doorType : '未指定'}`,
              '请定位第一张图中“需要贴到背景里的完整门体区域”，应包含门扇、门套/包边、把手、锁体、玻璃等完整门成品，尽量贴紧外轮廓，不要包含大面积墙面、地面或无关背景。',
              '请定位第二张图中“目标旧门/门洞/预留门位”的四个角。若背景里已有旧门，必须以旧门、旧门套、旧包边、旧门框阴影和最外层可见旧门边线的整体外轮廓四角为准，宁可左右和顶部略微外扩覆盖旧门残边，也不要框到旧门内口导致旧门红棕边、旧门套边或旧阴影残留。底部必须停在旧门/门套与地面接触线附近，不要框入大面积地板、踢脚线或两侧木饰面。',
              '只返回 JSON，不要解释，不要 markdown。',
              'JSON 格式必须为：{"sourceDoorBox":{"left":整数,"top":整数,"right":整数,"bottom":整数},"targetDoorQuad":{"topLeft":{"x":整数,"y":整数},"topRight":{"x":整数,"y":整数},"bottomRight":{"x":整数,"y":整数},"bottomLeft":{"x":整数,"y":整数}},"confidence":"high|medium|low","notes":"..."}。',
              '坐标必须使用各自图片的原始像素坐标。targetDoorQuad 必须覆盖完整旧门位的最外轮廓，包括细窄旧边框、外侧压线、旧门框投影和门槛边缘；但不要框入整面墙、家具、地面、踢脚线、左右木饰面或无关装饰。'
            ].join('\n')
          },
          {
            type: 'input_image',
            image_url: toDataUrl(primaryBuffer, primaryFileID)
          },
          {
            type: 'input_image',
            image_url: toDataUrl(backgroundBuffer, backgroundFileID)
          }
        ]
      }
    ]));
  const parsed = extractJsonObject(response.output_text || '');
  if (!parsed) {
    return null;
  }
  const sourceDoorBox = normalizeMaskBox(parsed.sourceDoorBox, primarySize, 'vision-source-door-box');
  const targetDoorQuad = normalizeCornerQuad(parsed.targetDoorQuad, backgroundSize, 'vision-target-door-quad');
  if (!sourceDoorBox || !targetDoorQuad) {
    return null;
  }
  return {
    sourceDoorBox,
    targetDoorQuad: expandDoorwayQuad(targetDoorQuad, backgroundSize),
    confidence: parsed.confidence || '',
    notes: parsed.notes || ''
  };
}

function normalizeDimensionBox(value, size, source) {
  const box = normalizeMaskBox(value, size, source);
  if (!box) {
    return null;
  }
  return {
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom,
    source: box.source
  };
}

function normalizeDimensionY(value, size) {
  const number = Number(value);
  if (!Number.isFinite(number) || !size || !size.height) {
    return null;
  }
  return Math.max(0, Math.min(size.height, Math.round(number)));
}

function normalizeDimensionBoxes(parsed, size) {
  if (!parsed || !size) {
    return null;
  }
  const result = {
    outerTrimBox: normalizeDimensionBox(parsed.outerTrimBox, size, 'dimension-outer-trim'),
    openingMidlineBox: normalizeDimensionBox(parsed.openingMidlineBox, size, 'dimension-opening-midline'),
    visibleOpeningBox: normalizeDimensionBox(parsed.visibleOpeningBox, size, 'dimension-visible-opening'),
    headerOuterBox: normalizeDimensionBox(parsed.headerOuterBox, size, 'dimension-header-outer'),
    transomTopY: normalizeDimensionY(parsed.transomTopY, size),
    doorBottomY: normalizeDimensionY(parsed.doorBottomY, size),
    heightBottomMode: parsed.heightBottomMode === 'separate' ? 'separate' : 'shared',
    bottomNotes: parsed.bottomNotes ? String(parsed.bottomNotes).trim() : '',
    confidence: parsed.confidence || '',
    notes: parsed.notes || ''
  };
  if (!result.outerTrimBox && !result.openingMidlineBox && !result.visibleOpeningBox && !result.headerOuterBox && result.doorBottomY === null) {
    return null;
  }
  return result;
}

async function detectDimensionBoxes(primaryBuffer, primaryFileID, size, job) {
  if (!primaryBuffer || !size || !size.width || !size.height) {
    return null;
  }
  const dimensionData = buildDimensionAnnotationData(job);
  const requestedText = dimensionData.provided.length
    ? dimensionData.provided.map((field) => field.label).join('、')
    : '未填写结构化尺寸项';
  const response = await openai.responses.create(getVisionResponseRequest([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '你只做尺寸标注边界定位，不生成图片。',
              `图片尺寸 width=${size.width}, height=${size.height}。`,
              `门类型：${dimensionData.doorType}。图面方向：${dimensionData.viewSideLabel}。`,
              `客户需要标注的尺寸项：${requestedText}。`,
              '请识别这些尺寸线应贴合的关键边界，并只返回 JSON。',
              'JSON 格式：{"outerTrimBox":{"left":整数,"top":整数,"right":整数,"bottom":整数},"openingMidlineBox":{"left":整数,"top":整数,"right":整数,"bottom":整数},"visibleOpeningBox":{"left":整数,"top":整数,"right":整数,"bottom":整数},"headerOuterBox":{"left":整数,"top":整数,"right":整数,"bottom":整数},"transomTopY":整数或null,"doorBottomY":整数,"heightBottomMode":"shared|separate","bottomNotes":"...","confidence":"high|medium|low","notes":"..."}。',
              'outerTrimBox 是含包边外沿/最外侧门套包边的整体矩形。',
              'openingMidlineBox 是门洞尺寸使用的边界：如果同时有门洞和见光，门洞取包边厚度中线/半包边位置；如果只有门洞没有见光，门洞取门和包边之间的连接硬边。',
              'visibleOpeningBox 是见光尺寸使用的门和包边之间的连接硬边，不含外侧包边；同时有门洞和见光时，见光尺寸取这一条连接硬边。',
              '边界必须来自真实实体结构线：门套外沿、门洞内沿、门扇/门框交界、门头门柱外沿。不要把投影、渐变阴影、地面接触阴影、背景灰边、光晕、压缩噪点识别成门边界；如果阴影贴着门边，取阴影内侧的真实硬边。',
              'doorBottomY 是门体最下沿/门底统一下边界。你必须自己判断高度尺寸是否共用底部：如果底部没有下槛、台阶、门洞落差或其他额外部件，heightBottomMode 写 shared，含包边高、门洞高、见光高都应使用同一个 doorBottomY；只有实际可见底部结构导致不同高度必须落到不同底边时，才写 separate，并在 bottomNotes 说明原因。',
              'transomTopY 是气窗最上沿，用于含气窗高；没有气窗时填 null。',
              'headerOuterBox 是门+门头+门柱的整体最外矩形，用于含门头宽/含门头高；没有门头门柱时填 null。',
              '只返回 JSON，不要解释，不要 markdown。'
            ].join('\n')
          },
          {
            type: 'input_image',
            image_url: toDataUrl(primaryBuffer, primaryFileID)
          }
        ]
      }
    ]));
  return normalizeDimensionBoxes(extractJsonObject(response.output_text || ''), size);
}

async function detectReferenceStyle(referenceImage, referenceBuffer, job) {
  const targetColorCode = referenceImage && referenceImage.slotId === 'color-sample'
    ? extractColorReferenceCode(job)
    : '';
  const includeTexture = !!(referenceImage && referenceImage.slotId === 'color-sample' && referenceImage.textureMode === 'reference');
  const prompt = getReferenceStylePrompt(referenceImage && referenceImage.slotId, {
    targetColorCode,
    includeTexture
  });
  if (!prompt || !referenceBuffer) {
    return null;
  }
  const response = await openai.responses.create(getVisionResponseRequest([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: prompt
          },
          {
            type: 'input_image',
            image_url: toDataUrl(referenceBuffer, referenceImage.originalImageFileID)
          }
        ]
      }
    ]));
  const parsed = extractJsonObject(response.output_text || '');
  if (!parsed) {
    return null;
  }
  return {
    slotId: referenceImage.slotId || '',
    label: getReferenceSlotLabel(referenceImage.slotId),
    referenceCode: parsed.referenceCode || targetColorCode || '',
    referenceName: parsed.referenceName || '',
    targetColorCode,
    codeMatchConfidence: parsed.codeMatchConfidence || '',
    textureMode: referenceImage.textureMode || '',
    includeTexture,
    part: parsed.part || getReferenceSlotLabel(referenceImage.slotId),
    sourceType: parsed.sourceType || '',
    color: parsed.color || '',
    colorFamily: parsed.colorFamily || '',
    undertone: parsed.undertone || '',
    brightness: parsed.brightness || '',
    saturation: parsed.saturation || '',
    hueLock: parsed.hueLock || '',
    toneLock: parsed.toneLock || '',
    material: parsed.material || '',
    finish: parsed.finish || '',
    shape: parsed.shape || '',
    structure: parsed.structure || '',
    profile: parsed.profile || '',
    edge: parsed.edge || '',
    details: parsed.details || '',
    sampleBox: normalizeSampleBox(parsed.sampleBox),
    lockIntegrationType: parsed.lockIntegrationType || '',
    referenceContainsHandle: !!parsed.referenceContainsHandle,
    handleCount: Number(parsed.handleCount || 0) || 0,
    isDoubleHandle: !!parsed.isDoubleHandle,
    handleLengthRatio: parsed.handleLengthRatio || '',
    smartPanelPlacement: parsed.smartPanelPlacement || '',
    hasSmartLockPanel: !!parsed.hasSmartLockPanel,
    hasRoundHole: !!parsed.hasRoundHole,
    roundHoleDescription: parsed.roundHoleDescription || '',
    roundHoleRelativePosition: parsed.roundHoleRelativePosition || '',
    applyDescription: parsed.applyDescription || ''
  };
}

function isHandleIntegratedLockStyle(style) {
  if (!style || style.slotId !== 'lock-detail') {
    return false;
  }
  const text = [
    style.lockIntegrationType,
    style.handleCount ? `handleCount=${style.handleCount}` : '',
    style.isDoubleHandle ? '双把手' : '',
    style.shape,
    style.structure,
    style.profile,
    style.details,
    style.applyDescription
  ].filter(Boolean).join(' ');
  if (/handle-integrated|一体式|一体|集成|嵌入把手|把手内置|不可拆|同一根把手|同一块面板/.test(text)) {
    return true;
  }
  if (style.referenceContainsHandle && style.hasSmartLockPanel && /把手|门把手|拉手|长拉手|长条|长杆|扶手|手柄|面板/.test(text)) {
    return true;
  }
  return !!(style.hasSmartLockPanel && (style.handleCount >= 1 || /长条|长杆|扶手|手柄|把手|拉手|握持|一体/.test(text)));
}

function buildReferenceStyleInstruction(referenceStyles, options) {
  const styles = Array.isArray(referenceStyles) ? referenceStyles.filter(Boolean) : [];
  if (!styles.length) {
    return '';
  }
  const useEdgeTrimReferenceColor = !!(options && options.useEdgeTrimReferenceColor);
  const preserveEdgeTrimColor = !!(options && options.preserveEdgeTrimColor);
  const edgeTrimColorFallback = preserveEdgeTrimColor
    ? '最终包边颜色按客户“保持不变/原色”语义执行；如已上传包边参考图，则保持包边参考图中包边自身的可见颜色。'
    : '最终包边颜色跟门体/颜色参考图统一。';
  return styles.map((style) => (
    style.slotId === 'edge-trim-detail' && !useEdgeTrimReferenceColor
      ? `系统识别到${style.label || style.part || '包边参考图'}结构特征：来源类型=${style.sourceType || '未识别'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；轮廓/形态=${style.shape || '未识别'}；结构=${style.structure || '未识别'}；截面/层次=${style.profile || '未识别'}；边角/收边=${style.edge || '未识别'}；关键细节=${style.details || '未识别'}；程序取样色=${describeSampledColor(style.sampledColor) || '未取到'}；颜色字段默认忽略，不作为最终包边颜色；执行描述=只提取包边结构、宽窄、层次、线条、纹理走向和收边方式，${edgeTrimColorFallback}`
      : style.slotId === 'lock-detail'
        ? `系统识别到${style.label || style.part || '锁体/智能锁参考图'}特征：来源类型=${style.sourceType || '未识别'}；锁具颜色=${style.color || '未识别'}；程序取样色=${describeSampledColor(style.sampledColor) || '未取到'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；轮廓/形态=${style.shape || '未识别'}；结构=${style.structure || '未识别'}；锁具与把手关系=${style.lockIntegrationType || '未识别'}；参考图是否拍到把手=${style.referenceContainsHandle ? '是' : '否'}；把手数量=${style.handleCount || '未识别'}；是否双把手=${style.isDoubleHandle ? '是' : '否'}；把手长度比例=${style.handleLengthRatio || '未识别'}；智能面板位置=${style.smartPanelPlacement || '未识别'}；是否有智能锁面板=${style.hasSmartLockPanel ? '是' : '否'}；是否有小圆孔=${style.hasRoundHole ? '是' : '否'}；小圆孔描述=${style.roundHoleDescription || '未识别'}；小圆孔相对位置=${style.roundHoleRelativePosition || '未识别'}；截面/层次=${style.profile || '未识别'}；边角=${style.edge || '未识别'}；关键细节=${style.details || '未识别'}；执行描述=${style.applyDescription || '只应用到锁体/智能锁/锁孔/猫眼等五金区域；除非识别为把手一体式智能锁，否则不作为把手款式参考'}。`
      : style.slotId === 'panel-style-detail'
        ? `系统识别到${style.label || style.part || '门板线条/造型参考图'}特征：来源类型=${style.sourceType || '未识别'}；线条/造型=${style.shape || '未识别'}；结构=${style.structure || '未识别'}；截面/凹凸层次=${style.profile || '未识别'}；边角/压线=${style.edge || '未识别'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；关键细节=${style.details || '未识别'}；参考图可见颜色=${style.color || '未识别'}；颜色字段仅作为参考图信息，不作为门体改色来源；执行描述=${style.applyDescription || '只迁移门扇表面的线条、压线、凹凸和门芯造型，不迁移整门比例、包边、把手、锁体、玻璃、颜色或背景'}。`
      : style.slotId === 'glass-grille-detail'
        ? `系统识别到${style.label || style.part || '气窗参考图'}特征：来源类型=${style.sourceType || '未识别'}；气窗局部可见颜色=${style.color || '未识别'}；程序取样色=${describeSampledColor(style.sampledColor) || '未取到'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；轮廓/形态=${style.shape || '未识别'}；结构=${style.structure || '未识别'}；截面/层次=${style.profile || '未识别'}；边框/收边=${style.edge || '未识别'}；关键细节=${style.details || '未识别'}；颜色字段和取样色只允许用于气窗玻璃、格栅、透光窗或气窗小边框自身，不得作为门扇/门体/包边改色来源；执行描述=${style.applyDescription || '只应用到气窗/透光窗/玻璃/格栅/镂空及其收边区域，不作为门体颜色、包边、把手、锁体或背景参考'}。`
      : style.slotId === 'header-column-detail'
        ? `系统识别到${style.label || style.part || '门头/门柱参考图'}特征：来源类型=${style.sourceType || '未识别'}；门头/门柱局部可见颜色=${style.color || '未识别'}；程序取样色=${describeSampledColor(style.sampledColor) || '未取到'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；轮廓/形态=${style.shape || '未识别'}；结构=${style.structure || '未识别'}；截面/层次=${style.profile || '未识别'}；边角/收边=${style.edge || '未识别'}；关键细节=${style.details || '未识别'}；颜色字段和取样色只允许用于门头、门楣、门柱、立柱、外框装饰自身，不得作为门扇/门体/把手/锁体/气窗/背景改色来源；执行描述=${style.applyDescription || '只应用到门头、门楣、门柱、立柱、外框装饰及其衔接区域，不作为门扇款式、门体颜色、把手、锁体、气窗或背景参考'}。`
      : style.slotId === 'texture-reference'
        ? `系统识别到${style.label || style.part || '材质纹理参考图'}特征：材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；纹理方向/结构=${style.structure || '未识别'}；纹理层次=${style.profile || '未识别'}；边缘/纹理过渡=${style.edge || '未识别'}；关键纹理细节=${style.details || '未识别'}；可见颜色=${style.color || '未识别'}；执行描述=${style.applyDescription || '只迁移材质纹理和表面质感，不把该参考图当成门型、包边、把手、锁体或玻璃参考；除非客户明确要求，不把该图颜色作为最终门体颜色来源'}。`
      : style.slotId === 'left-leaf-detail'
        ? `系统识别到${style.label || style.part || '左门扇细节参考图'}特征：来源类型=${style.sourceType || '未识别'}；局部可见颜色=${style.color || '未识别'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；门扇局部形态=${style.shape || '未识别'}；线条/纹理/玻璃结构=${style.structure || '未识别'}；凹凸/压线层次=${style.profile || '未识别'}；边角/收口=${style.edge || '未识别'}；关键细节=${style.details || '未识别'}；执行描述=${style.applyDescription || '只应用到第一张整门图左门扇对应区域，保持门扇数量、左右比例、中缝、把手、锁体、包边和背景不变'}。`
      : style.slotId === 'right-leaf-detail'
        ? `系统识别到${style.label || style.part || '右门扇细节参考图'}特征：来源类型=${style.sourceType || '未识别'}；局部可见颜色=${style.color || '未识别'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；门扇局部形态=${style.shape || '未识别'}；线条/纹理/玻璃结构=${style.structure || '未识别'}；凹凸/压线层次=${style.profile || '未识别'}；边角/收口=${style.edge || '未识别'}；关键细节=${style.details || '未识别'}；执行描述=${style.applyDescription || '只应用到第一张整门图右门扇对应区域，保持门扇数量、左右比例、中缝、把手、锁体、包边和背景不变'}。`
      : style.slotId === 'child-leaf-detail'
        ? `系统识别到${style.label || style.part || '小门扇细节参考图'}特征：来源类型=${style.sourceType || '未识别'}；局部可见颜色=${style.color || '未识别'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；小门扇局部形态=${style.shape || '未识别'}；线条/纹理/玻璃结构=${style.structure || '未识别'}；凹凸/压线层次=${style.profile || '未识别'}；边角/收口=${style.edge || '未识别'}；关键细节=${style.details || '未识别'}；执行描述=${style.applyDescription || '只应用到第一张整门图小门扇/子门对应区域，保持子母宽窄比例、中缝、把手、锁体、包边和背景不变'}。`
      : style.slotId === 'middle-join-detail'
        ? `系统识别到${style.label || style.part || '中缝/拼接细节参考图'}特征：来源类型=${style.sourceType || '未识别'}；局部可见颜色=${style.color || '未识别'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；中缝/拼接形态=${style.shape || '未识别'}；止口/压条/收口结构=${style.structure || '未识别'}；凹凸/层次=${style.profile || '未识别'}；边角/对缝=${style.edge || '未识别'}；关键细节=${style.details || '未识别'}；执行描述=${style.applyDescription || '只应用到第一张整门图已有中缝或拼缝位置，保持门扇数量、每扇宽窄比例、把手、锁体、门体颜色、包边和背景不变'}。`
      : style.slotId === 'background-reference'
        ? `系统识别到${style.label || style.part || '背景参考图'}特征：来源类型=${style.sourceType || '未识别'}；空间/构图=${style.shape || '未识别'}；墙地面/结构=${style.structure || '未识别'}；空间层次=${style.profile || '未识别'}；边界/衔接=${style.edge || '未识别'}；主色=${style.color || '未识别'}；材质=${style.material || '未识别'}；光线/质感=${style.finish || '未识别'}；关键背景细节=${style.details || '未识别'}；执行描述=${style.applyDescription || '以背景参考图为最终背景底图，只在目标门位抠图贴入第一张整门图的门，不重绘墙面、地面、家具、装饰和整体空间；不把该图当成门款、包边、把手、锁体、玻璃、门体颜色或材质参考'}。`
      : `系统识别到${style.label || style.part || '参考图'}特征：${style.referenceCode || style.referenceName || style.targetColorCode ? `指定/匹配颜色标签=${style.referenceCode || style.referenceName || style.targetColorCode}；匹配置信度=${style.codeMatchConfidence || '未说明'}；` : ''}来源类型=${style.sourceType || '未识别'}；颜色=${style.color || '未识别'}；程序取样色=${describeSampledColor(style.sampledColor) || '未取到'}；颜色大类=${style.colorFamily || '未识别'}；冷暖色偏=${style.undertone || '未识别'}；明度=${style.brightness || '未识别'}；饱和度=${style.saturation || '未识别'}；色相锁定=${style.hueLock || '未识别'}；明暗/灰度锁定=${style.toneLock || '未识别'}；材质=${style.material || '未识别'}；表面质感=${style.finish || '未识别'}；轮廓/形态=${style.shape || '未识别'}；结构=${style.structure || '未识别'}；截面/层次=${style.profile || '未识别'}；边角/收边=${style.edge || '未识别'}；关键细节=${style.details || '未识别'}；执行描述=${style.applyDescription || '未识别'}。`
  )).join('\n');
}

function formatDimensionBox(box) {
  if (!box) {
    return '';
  }
  return `left=${box.left}, top=${box.top}, right=${box.right}, bottom=${box.bottom}`;
}

function buildDimensionBoxInstruction(dimensionBoxes) {
  if (!dimensionBoxes) {
    return '';
  }
  return [
    '系统已预先识别尺寸标注关键边界坐标，坐标基于第一张整门图原始像素；生成尺寸线时必须优先贴合这些坐标，不要只凭视觉自由估计。',
    '这些坐标只认真实实体结构线，不能把投影、渐变阴影、地面接触阴影、背景灰边、光晕或压缩噪点当成门边界；如果阴影贴边，尺寸线贴阴影内侧的真实硬边。',
    '宽度尺寸使用对应边界框的 left/right；高度尺寸主要使用对应边界框的 top，底部必须按 heightBottomMode 和 doorBottomY 判断。',
    dimensionBoxes.outerTrimBox ? `含包边外沿 outerTrimBox：${formatDimensionBox(dimensionBoxes.outerTrimBox)}。含包边宽使用 left/right，含包边高使用 top；底部不要机械使用 outerTrimBox.bottom。` : '',
    dimensionBoxes.openingMidlineBox ? `门洞边界 openingMidlineBox：${formatDimensionBox(dimensionBoxes.openingMidlineBox)}。门洞宽使用 left/right，门洞高使用 top；底部不要机械使用 openingMidlineBox.bottom。` : '',
    dimensionBoxes.visibleOpeningBox ? `见光净开口 visibleOpeningBox：${formatDimensionBox(dimensionBoxes.visibleOpeningBox)}。见光宽使用 left/right，见光高使用 top；底部不要机械使用 visibleOpeningBox.bottom。` : '',
    dimensionBoxes.headerOuterBox ? `含门头整体外沿 headerOuterBox：${formatDimensionBox(dimensionBoxes.headerOuterBox)}。含门头宽/高应贴这组门+门头+门柱整体外边界；含门头高可以使用 headerOuterBox.bottom。` : '',
    dimensionBoxes.transomTopY !== null && dimensionBoxes.transomTopY !== undefined ? `气窗最上沿 transomTopY=${dimensionBoxes.transomTopY}。含气窗高应从这个 y 标到门底。` : '',
    dimensionBoxes.doorBottomY !== null && dimensionBoxes.doorBottomY !== undefined ? `门底统一下边界 doorBottomY=${dimensionBoxes.doorBottomY}。heightBottomMode=${dimensionBoxes.heightBottomMode || 'shared'}。` : '',
    dimensionBoxes.heightBottomMode === 'separate'
      ? 'AI 识别到底部有真实结构差异，可以让个别高度使用不同底边，但必须只用于确实有下槛、台阶、门洞落差或额外底部部件的尺寸；不要因为 outerTrimBox/openingMidlineBox/visibleOpeningBox 的 bottom 不同就画三条底边。'
      : 'AI 判断高度底部共用：含包边高、门洞高、见光高、含气窗高应共用 doorBottomY 作为底部，不要画出三条不同的底部横线。',
    dimensionBoxes.bottomNotes ? `底部判断备注：${dimensionBoxes.bottomNotes}。` : '',
    dimensionBoxes.confidence ? `边界识别置信度：${dimensionBoxes.confidence}。` : '',
    dimensionBoxes.notes ? `边界识别备注：${dimensionBoxes.notes}。` : ''
  ].filter(Boolean).join('\n');
}

function buildDoorImageInstruction(job, maskBox, handleStyle, referenceStyles, dimensionBoxes) {
  const requirementText = job && job.requirement ? String(job.requirement) : '';
  const backgroundInfo = job && job.backgroundInfo ? String(job.backgroundInfo).trim() : '';
  const doorType = job && job.doorType ? String(job.doorType) : '';
  const taskType = normalizeTaskType(job);
  const isDimensionAnnotationTask = taskType === 'dimension-annotation';
  const dimensionAnnotationData = isDimensionAnnotationTask ? buildDimensionAnnotationData(job) : null;
  const isPartsComposeTask = taskType === 'parts-compose';
  const isMultiLeafDoorType = /双开门|子母门|四开子母门|四开平分门|六开门/.test(doorType);
  const referenceImages = getReferenceImages(job);
  const userSelectedEdgeTrimReferenceColor = referenceImages.some((item) => item && item.slotId === 'edge-trim-detail' && item.colorMode === 'reference');
  const allowHandleColorChange = /把手.*颜色|颜色.*把手|门把手.*颜色|颜色.*门把手|调成门的颜色|改成门的颜色|同门颜色|跟门同色|与门同色/.test(requirementText);
  const allowHandleStyleChange = /更换把手|更改把手样式|改变把手样式|换个把手|把手款式|把手造型|把手结构/.test(requirementText);
  const allowHandleBaseChange = /去掉底座|删除底座|取消底座|不要底座|只保留把手主体|弱化底座|缩小底座/.test(requirementText);
  const userWantsEdgeTrimDoorColor = /(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:同门|跟门|与门|和门|门体|门扇|整门)[^。；，,.]{0,24}(?:同色|一样|一致|统一)|(?:门体|门扇|整门)[^。；，,.]{0,24}(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:同色|一样|一致|统一)/.test(requirementText);
  const userSpecifiedEdgeTrimColor = /(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:改成|换成|调成|做成|改为|设为|使用|用)[^。；，,.]{0,24}(?:颜色|色|黑|白|灰|棕|木|金|银|红|黄|蓝|绿|深|浅)|(?:黑色|白色|灰色|棕色|木色|金色|银色|深色|浅色)[^。；，,.]{0,24}(?:包边|门套|收口|压线)/.test(requirementText);
  const userWantsEdgeTrimReferenceColor = userSelectedEdgeTrimReferenceColor || /(?:包边|门套|收口|压线)[^。；，,.]{0,28}(?:按|跟随|参考|保留|保持|使用|用)[^。；，,.]{0,28}(?:包边参考图|参考图|原图)[^。；，,.]{0,16}(?:颜色|色|固有色)|(?:包边|门套|收口|压线)[^。；，,.]{0,28}(?:不要|不跟|不同|独立|单独|另外|另做)[^。；，,.]{0,28}(?:同门|跟门|门体|门扇|整门|同色|统一|颜色|色)/.test(requirementText);
  const userWantsEdgeTrimPreserveColor = /(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:颜色|色|原色|本色|自身颜色|当前颜色|现在颜色)[^。；，,.]{0,16}(?:保持不变|不变|别变|不要变|不能变|保留|维持|锁定|不改|不要改|原样)|(?:保持不变|不变|别变|不要变|不能变|保留|维持|锁定|不改|不要改|原样)[^。；，,.]{0,24}(?:包边|门套|收口|压线)[^。；，,.]{0,16}(?:颜色|色|原色|本色|自身颜色|当前颜色|现在颜色)|(?:包边|门套|收口|压线)[^。；，,.]{0,24}(?:保留|保持|用|使用)[^。；，,.]{0,16}(?:原色|本色|自身颜色|当前颜色|现在颜色|原包边颜色)/.test(requirementText);
  const userWantsIndependentEdgeTrimColor = !userWantsEdgeTrimDoorColor && (userSpecifiedEdgeTrimColor || userWantsEdgeTrimReferenceColor || userWantsEdgeTrimPreserveColor);
  const allowEdgeTrimColorChange = userWantsEdgeTrimDoorColor || userSpecifiedEdgeTrimColor || userWantsEdgeTrimReferenceColor || userWantsEdgeTrimPreserveColor;
  const allowEdgeTrimStyleChange = /更换包边|更改包边|改变包边|包边款式|包边造型|包边结构|门套线.*样式|收口条.*样式/.test(requirementText);
  const allowEdgeTrimRemoveChange = /去掉包边|删除包边|取消包边|不要包边|去掉门套线|删除门套线|取消门套线|不要门套线/.test(requirementText);
  const targetParts = Array.isArray(job.targetParts)
    ? job.targetParts.map((item) => {
        if (item === 'handle') {
          return '门把手';
        }
        if (item === 'edge-trim') {
          return '包边';
        }
        if (item === 'door-color') {
          return '门体颜色';
        }
        if (item === 'lock') {
          return '锁体/智能锁';
        }
        if (item === 'panel-style') {
          return '门板线条/造型';
        }
        if (item === 'glass-grille') {
          return '气窗';
        }
        if (item === 'header-column') {
          return '门头/门柱';
        }
        if (item === 'material-texture') {
          return '材质纹理';
        }
        if (item === 'background') {
          return '背景';
        }
        return item;
      }).filter(Boolean)
    : [];
  let targetPartText = targetParts.length ? targetParts.join('、') : '门体';
  const hasHandleDetail = referenceImages.some((item) => item.slotId === 'handle-detail');
  const hasHeaderColumnDetail = referenceImages.some((item) => item.slotId === 'header-column-detail');
  const hasUploadedEdgeTrimDetail = referenceImages.some((item) => item.slotId === 'edge-trim-detail');
  const hasEdgeTrimDetail = hasUploadedEdgeTrimDetail && !hasHeaderColumnDetail;
  const hasColorSample = referenceImages.some((item) => item.slotId === 'color-sample');
  const colorSampleUsesReferenceTexture = referenceImages.some((item) => item.slotId === 'color-sample' && item.textureMode === 'reference');
  const hasLockDetail = referenceImages.some((item) => item.slotId === 'lock-detail');
  const hasPanelStyleDetail = referenceImages.some((item) => item.slotId === 'panel-style-detail');
  const hasGlassGrilleDetail = referenceImages.some((item) => item.slotId === 'glass-grille-detail');
  const hasTextureReference = referenceImages.some((item) => item.slotId === 'texture-reference');
  const hasBackgroundReference = referenceImages.some((item) => item.slotId === 'background-reference');
  const hasLeftLeafDetail = referenceImages.some((item) => item.slotId === 'left-leaf-detail');
  const hasRightLeafDetail = referenceImages.some((item) => item.slotId === 'right-leaf-detail');
  const hasChildLeafDetail = referenceImages.some((item) => item.slotId === 'child-leaf-detail');
  const hasMiddleJoinDetail = referenceImages.some((item) => item.slotId === 'middle-join-detail');
  const userWantsIndependentHeaderColumnColor = /(?:门头|门楣|门柱|立柱|罗马柱|外框)[^。；，,.]{0,28}(?:单独|独立|不要同门|不跟门|不同色|另外|另做|按参考图颜色|用参考图颜色|保持原色|颜色保持不变|颜色不变)|(?:单独|独立|不要同门|不跟门|不同色|另外|另做)[^。；，,.]{0,28}(?:门头|门楣|门柱|立柱|罗马柱|外框)/.test(requirementText);
  const colorSampleAppliesToHeaderColumn = hasColorSample && hasHeaderColumnDetail && !userWantsIndependentHeaderColumnColor;
  const orderedReferenceImages = hasBackgroundReference
    ? [
        ...referenceImages.filter((item) => item && item.slotId === 'background-reference'),
        ...referenceImages.filter((item) => item && item.slotId === 'full-door'),
        ...referenceImages.filter((item) => item && item.slotId !== 'background-reference' && item.slotId !== 'full-door')
      ]
    : referenceImages;
  const imageLines = orderedReferenceImages.map((item, index) => {
    const label = getReferenceSlotLabel(item.slotId);
    if (hasBackgroundReference && item.slotId === 'background-reference') {
      return `输入图${index + 1}：${label}。这是最终输出的背景底图和画布来源；系统 mask 已限制只编辑这张图中的旧门/门洞/目标门位区域，墙面、地面、家具、装饰、光线和空间构图必须尽量保持原图。`;
    }
    if (hasBackgroundReference && item.slotId === 'full-door') {
      return `输入图${index + 1}：${label}。这是唯一门体来源和门型来源；最终必须从这张图中抠出门体，贴入输入图1背景参考图的目标门位。`;
    }
    if (index === 0) {
      return `参考图${index + 1}：${label}。这是唯一底图和唯一门型来源，最终必须像在这张图上做局部编辑。`;
    }
    return `输入图${index + 1}：${label}。这只是对应部件参考，不能作为整门底图或整门款式参考。`;
  });
  const useDefaultWhiteBoardBackground = isPartsComposeTask;
  const activeTargetParts = [
    hasHandleDetail ? '门把手' : '',
    hasEdgeTrimDetail ? '包边' : '',
    hasColorSample || hasDoorSurfaceColorTextRequest(job) ? '门体颜色' : '',
    hasLockDetail ? '锁体/智能锁' : '',
    hasPanelStyleDetail ? '门板线条/造型' : '',
    hasGlassGrilleDetail ? '气窗' : '',
    hasHeaderColumnDetail ? '门头/门柱' : '',
    hasTextureReference ? '材质纹理' : '',
    hasLeftLeafDetail ? '左门扇细节' : '',
    hasRightLeafDetail ? '右门扇细节' : '',
    hasChildLeafDetail ? '小门扇细节' : '',
    hasMiddleJoinDetail ? '中缝/拼接细节' : '',
    useDefaultWhiteBoardBackground ? '白板背景' : (hasBackgroundReference || backgroundInfo || /抠图|扣图|白底|透明底|去背景|去掉背景|去除背景/.test(requirementText) ? '背景/抠图' : '')
  ].filter(Boolean);
  targetPartText = activeTargetParts.length
    ? activeTargetParts.join('、')
    : (targetParts.length ? `暂无已上传局部参考图，仅按客户补充要求处理；可选部件包括：${targetParts.join('、')}` : '门体');
  const edgeTrimPreserveMeansReferenceColor = hasEdgeTrimDetail && userWantsEdgeTrimPreserveColor;
  const edgeTrimColorProtectedFromColorSample = hasEdgeTrimDetail && userWantsIndependentEdgeTrimColor;
  const colorSampleAppliesToEdgeTrim = hasColorSample && !edgeTrimColorProtectedFromColorSample;
  const isCutoutRequest = /抠图|扣图|扣出来|抠出来|单独抠|单独扣|单独.*出来|白底|透明底|去背景|去掉背景|去除背景/.test(`${requirementText} ${backgroundInfo}`);
  const maskInstruction = maskBox
    ? (hasBackgroundReference && /background|doorway|门位|背景/.test(maskBox.source || '')
      ? `系统检测到背景图目标门位 mask：left=${maskBox.left}, top=${maskBox.top}, right=${maskBox.right}, bottom=${maskBox.bottom}。注意：image edit 的第一张输入图是背景参考图，mask 只开放第一张图中的旧门/门洞/目标门位区域。本次只能在该 mask 透明区域内覆盖旧门、贴入主门、做边缘融合、遮挡和接地阴影；mask 外的背景墙面、地面、家具、护墙板、踢脚线、装饰、光线和纹理必须保持原背景图，不得重画、改色、扩写或美化。`
      : `系统检测到门把手编辑区域：left=${maskBox.left}, top=${maskBox.top}, right=${maskBox.right}, bottom=${maskBox.bottom}。本次只允许在该区域及极小衔接边缘内编辑。`)
    : hasBackgroundReference
      ? '本次未启用区域 mask，但客户上传了背景参考图，因此抠图贴合是明确目标任务：必须把第一张整门图中的门抠出并贴入背景图的旧门/门洞/预留门位；不要把“无 mask”理解为不能处理门位。背景图整体应尽量原样保留，只允许处理目标门位、遮挡、接地阴影和边缘融合。门体本身仍以第一张整门图为准，只允许为了对齐背景门位做整体缩放、透视拉伸、旋转、轻微裁切和光影融合。'
      : useDefaultWhiteBoardBackground
        ? '本次未启用区域 mask，但门部件拼接效果图默认白板背景，因此必须编辑背景、墙面、地面和空间为干净白板效果；门体本身、部件结构、颜色和材质保持第一张整门图及已上传部件参考图约束。'
        : `本次未启用区域 mask，请仅围绕目标部件（${targetPartText}）及必要衔接区域做处理，不要扩散到背景、墙面或其他未点名区域。`;
  const handleStyleInstruction = handleStyle && (handleStyle.color || handleStyle.material || handleStyle.finish || handleStyle.shape || handleStyle.base || handleStyle.details)
    ? [
        `系统识别到门把手细节特征：颜色=${handleStyle.color || '未识别'}；材质=${handleStyle.material || '未识别'}；表面质感=${handleStyle.finish || '未识别'}；主体造型=${handleStyle.shape || '未识别'}；底座/面板=${handleStyle.base || '未识别'}；关键细节=${handleStyle.details || '未识别'}。`,
        handleStyle.containsSmartLock || handleStyle.smartLockInterference
          ? `系统同时识别到门把手细节图中含有非把手锁体/智能锁干扰物：${handleStyle.smartLockInterference || '存在智能锁、锁面板或锁芯类部件'}。这些干扰物不能作为把手样式、底座或装饰细节迁移到整门图。`
          : '',
        allowHandleColorChange
          ? '用户这次明确要求调整门把手颜色，因此颜色可以按用户要求改变；但主体造型、材质观感、底座结构和关键细节仍应尽量保持与细节图一致。'
          : '最终成图中的门把手必须优先保持细节图中的颜色，不要因为环境光或门体配色自动改成其他颜色。',
        allowHandleStyleChange
          ? '用户这次明确要求改变把手样式，因此可按要求调整样式；但除用户点名变化外，仍应尽量保留其余细节。'
          : '门把手主体造型、轮廓、线条、转角和装饰细节都应以细节图为准，不要把细节简化成相似但不同的款式。',
        allowHandleBaseChange
          ? '用户这次明确要求调整底座或只保留主体，因此底座相关结构可以按要求删减或弱化；但不要顺带改变把手主体样式。'
          : '底座/面板结构也应尽量保持与细节图一致，不要擅自删除或替换。'
      ].filter(Boolean).join('\n')
    : hasHandleDetail
      ? '门把手颜色、材质、主体造型、底座结构和关键细节都必须以门把手细节图为准；如果用户明确要求改变其中某项，则只改那一项。'
      : '当前没有门把手细节图，请只在整门图中识别现有门把手；除非用户明确要求，不要擅自改变门把手款式、颜色、材质、底座结构或关键细节。';
  const handleReferenceSmartLockFreezeInstruction = hasHandleDetail && !hasLockDetail
    ? [
        '把手图含锁防污染规则：本次上传的是门把手细节图，不是锁体/智能锁细节图；除非另有 lock-detail 智能锁细节图，否则门把手图只允许控制门把手握持件、把手底座和必要安装衔接。',
        '如果门把手细节图里同时拍到了智能锁、黑色锁面板、密码键盘、指纹头、摄像头、猫眼、锁芯、圆形应急孔、门铃或其他锁体部件，这些都必须视为非把手干扰信息，不能被复制、替换、移动或覆盖到最终整门图。',
        '整门照中原本存在的智能锁/锁体/锁芯/猫眼/门铃位置、数量、尺寸、外观和与把手的相对关系必须保留；不得把把手图里的智能锁 P 到门上，也不得用把手图里的锁替换整门照原锁。',
        '如果参考图中的把手与智能锁是一体式结构，但用户没有上传智能锁细节图，则只提取可分离的把手握持造型；不可分离时优先保留整门照原智能锁和原锁区域，仅做把手外观融合。',
        '验收失败定义：最终图出现了把手参考图里的新智能锁/黑色锁面板/密码键盘/指纹头，或者整门照原智能锁被删除、遮挡、换款、换位置，都属于不合格。'
      ].join('\n')
    : '';
  const lockDetailMustApplyInstruction = hasLockDetail
    ? [
        '智能锁强制落图规则：只要上传了 lock-detail 锁体/智能锁细节图，本次就必须把该参考图中的智能锁核心可见部件 P 到整门图上，不能只保留原门拉手或原锁具。',
        '智能锁核心可见部件包括：黑色/金属锁面板、密码键盘、指纹识别区、刷卡区、摄像头、猫眼、门铃、锁芯孔、实体应急小圆孔、屏幕、指示灯和必要安装底座；参考图里能看到哪些，最终图中就应尽量出现对应哪些。',
        '如果智能锁参考图与原门把手或原锁具位置冲突，lock-detail 优先级高于“保持原把手/原锁具”：允许覆盖、替换或清理原门把手附近的冲突五金，但不得改变门扇比例、门板线条、包边、门头/门柱和背景。',
        '锁体任务默认不是把手删除任务：除非客户明确要求拆掉把手，或把手与智能锁实际安装区域发生直接重叠，否则必须保留第一张整门照中未冲突的原把手、拉手和对侧五金。双开门中只安装一个智能锁时，不得把另一扇门上的对侧拉手一并删除。',
        '如果整门图是双开门/子母门/四开/六开门，应把智能锁放在主开启扇靠中缝的合理五金安装区；不要放到门板中央装饰纹样里，不要放到门头、立柱或背景上。',
        '双开门单锁布局规则：如果 lock-detail 只有一个智能锁主体，最终智能锁必须主要落在一扇主开启扇上并贴近中缝，不得骑在中缝正中跨左右两扇门，不得为了安装单锁而同时删除左右两根原拉手。',
        '如果参考图是普通独立智能锁面板而不是把手一体式锁，也必须生成清晰可见的智能锁面板/锁孔/指纹或密码区；“参考图里的把手不迁移”只表示不复制普通拉手款式，不能理解为不迁移智能锁本身。',
        '智能锁验收失败定义：最终图中没有清晰可见的新智能锁面板、密码/指纹/锁孔等参考图核心锁具特征，或者只保留原来的金色双拉手/原五金不变，都属于失败。'
      ].join('\n')
    : '';
  const multiLeafDoorLockInstruction = isMultiLeafDoorType
    ? [
        `多门型专属冻结：当前门类型为${doorType || '多开门'}，第一张整门图中的门扇数量、每扇门宽窄比例、中缝/拼缝位置、开门方向、左右/子母/四开/六开分割关系必须作为基础结构锁定。`,
        '禁止把双开门变成单开门，禁止把子母门变成双开平分门，禁止把四开/六开门合并、删减、增补门扇，也禁止把左右门扇比例自动拉平均。',
        doorType === '双开门'
          ? '双开门必须保留左右两扇门和中缝位置；除非客户明确要求，不要改变左右对称关系、双把手相对位置和中缝收口。'
          : '',
        doorType === '子母门'
          ? '子母门必须保留子门/母门宽窄比例和中缝位置；不要把小门扇放大成平分双开门，也不要删除小门扇。'
          : '',
        doorType === '四开子母门'
          ? '四开子母门必须保留四扇门、子母比例、左右分组和各中缝位置；不要改成四开平分门或普通双开门。'
          : '',
        doorType === '四开平分门'
          ? '四开平分门必须保留四扇均分关系和三条主要拼缝；不要改成子母比例或双开门。'
          : '',
        doorType === '六开门'
          ? '六开门必须保留六扇门的分割数量、对称关系和各拼缝位置；不要减少成四开、双开或单开。'
          : '',
        hasLeftLeafDetail || hasRightLeafDetail || hasChildLeafDetail || hasMiddleJoinDetail
          ? '左右门扇、小门扇和中缝/拼接细节照只用于补充对应局部细节和定位关系，不是整门换款参考；不能因为这些上下文图改变第一张整门图的门扇数量、比例、门型结构、把手位置或锁体位置。'
          : '',
        hasMiddleJoinDetail
          ? '中缝/拼接细节照只约束门缝收口、拼接条、对缝、压条和局部衔接方式；不得带动门扇宽度、门扇数量、门面颜色或门板整体造型变化。'
          : ''
      ].filter(Boolean).join('\n')
    : '';
  const headerColumnOverridesEdgeTrimInstruction = hasHeaderColumnDetail
    ? [
        '门头/门柱覆盖包边规则：本次已上传门头/门柱细节图，因此门头/门柱图同时作为双开门外框、门楣、门柱、门套外框和包边结构的主要参考来源。',
        '不需要再执行单独包边参考任务；即使输入里同时存在包边细节图，也应以门头/门柱参考图为准，忽略包边细节图对结构和颜色的控制。',
        '门头/门柱任务已经覆盖外框/包边区域，不能让包边图再把门头、门柱、外框颜色或结构拉回另一套样式。',
        '门头/门柱细节保真要求：最终图不能只生成大概拱形和两根柱子，必须尽量保留参考图中可见的关键装饰件，包括多层同心拱圈/台阶边、顶部中央金色牌匾或竖牌、牌匾下方深色浮雕花饰/卷草纹、横梁长矩形压线框、中央圆形装饰钮、左右上角方形金属三角饰件、立柱内嵌长矩形框、竖向凹槽、腰线、柱脚台阶和底座层次。',
        '门头/门柱验收失败定义：如果最终图缺少参考图中明显的中心牌匾、浮雕花饰、两侧方形三角饰件、横梁压线框或立柱内嵌框等主要装饰，只保留了简单外轮廓，就属于门头/门柱细节不足，应补回这些装饰。'
      ].join('\n')
    : '';
  const effectiveReferenceStyles = hasHeaderColumnDetail
    ? (Array.isArray(referenceStyles) ? referenceStyles.filter((style) => style && style.slotId !== 'edge-trim-detail') : [])
    : referenceStyles;
  const referenceStyleInstruction = buildReferenceStyleInstruction(effectiveReferenceStyles, {
    useEdgeTrimReferenceColor: userWantsIndependentEdgeTrimColor && !(!hasEdgeTrimDetail && userWantsEdgeTrimPreserveColor),
    preserveEdgeTrimColor: edgeTrimPreserveMeansReferenceColor
  });
  const edgeTrimStyle = Array.isArray(effectiveReferenceStyles)
    ? effectiveReferenceStyles.find((style) => style && style.slotId === 'edge-trim-detail')
    : null;
  const lockStyle = Array.isArray(referenceStyles)
    ? referenceStyles.find((style) => style && style.slotId === 'lock-detail')
    : null;
  const lockReferenceIsHandleIntegrated = isHandleIntegratedLockStyle(lockStyle);
  const colorSampleStyle = Array.isArray(referenceStyles)
    ? referenceStyles.find((style) => style && style.slotId === 'color-sample')
    : null;
  const lockReferenceIsDoubleHandle = !!(lockStyle && (lockStyle.isDoubleHandle || lockStyle.handleCount >= 2));
  const backgroundStyle = Array.isArray(referenceStyles)
    ? referenceStyles.find((style) => style && style.slotId === 'background-reference')
    : null;
  const targetColorCode = colorSampleStyle && (colorSampleStyle.referenceCode || colorSampleStyle.referenceName || colorSampleStyle.targetColorCode)
    ? (colorSampleStyle.referenceCode || colorSampleStyle.referenceName || colorSampleStyle.targetColorCode)
    : extractColorReferenceCode(job);
  const allowDoorSurfaceColorChange = hasColorSample || hasDoorSurfaceColorTextRequest(job);
  const allowBackgroundChange = useDefaultWhiteBoardBackground || hasBackgroundReference || (!isPartsComposeTask && (!!backgroundInfo || isCutoutRequest));
  const freezeDoorSurfaceColor = !allowDoorSurfaceColorChange;
  const hasEdgeTrimOnlyReference = hasEdgeTrimDetail && !hasHandleDetail && !allowDoorSurfaceColorChange && !allowBackgroundChange && !allowEdgeTrimColorChange;
  const edgeTrimScopeLimitInstruction = allowDoorSurfaceColorChange
    ? '最高优先级限制：包边替换不是整门换款。包边任务只允许修改包边、门套线、收口条、压线和其极小衔接边缘；包边参考图默认只提供包边结构、宽窄、层次、线条和收边方式，包边颜色默认跟门扇/门体同色，并随颜色参考图一起统一；只有客户明确指定包边独立颜色、按包边参考图颜色，或要求包边颜色保持不变时，包边颜色才不跟门体同色。包边任务本身不得改变门扇主体造型、门板花纹、门板线条数量、线条位置、门型比例、玻璃、门芯结构和五金把手；如果本次同时上传门板线条/造型或气窗参考图，对应目标区域只由对应参考图任务控制，不能由包边任务带动改变。严禁为了适配包边而重画门扇。'
    : '最高优先级限制：包边替换不是整门换款。只允许修改包边、门套线、收口条、压线和其极小衔接边缘；包边参考图默认只提供包边结构、宽窄、层次、线条和收边方式，包边颜色默认匹配第一张整门图的门体原始颜色；严禁把门扇/门体颜色改成包边参考图颜色。包边任务本身不得改变门扇主体、门板花纹、门板线条数量、线条位置、门型比例、玻璃、门芯造型、门面颜色和五金把手；如果本次同时上传门板线条/造型或气窗参考图，对应目标区域只由对应参考图任务控制，不能由包边任务带动改变。严禁为了适配包边而重画门扇。';
  const requiredReferenceTasks = [
    hasHandleDetail ? '门把手：必须按门把手细节图融合/替换' : '',
    hasEdgeTrimDetail ? '包边：必须识别包边参考图中的包边结构并产生可见融合/替换效果，不能保留原包边不变' : '',
    hasLockDetail ? (lockReferenceIsHandleIntegrated
      ? `锁体/智能锁：必须按锁体/智能锁细节图替换为一体式把手锁整体，包含智能锁面板、指纹/密码/刷卡区和与其物理一体的把手；小圆孔是独立实体应急锁孔，不能放在把手或黑色智能面板上；${lockReferenceIsDoubleHandle ? '参考图是双把手，最终必须生成双把手，不能只生成单把手；' : ''}不能保留整门图里的原智能锁或原把手不变`
      : '锁体/智能锁：必须按锁体/智能锁细节图处理锁具、锁孔、智能锁面板、猫眼、小圆孔或相关五金区域；最终必须出现清晰可见的智能锁/锁具核心特征，不能只保留原把手不变；参考图里的普通把手默认不迁移，但智能锁面板和锁孔必须迁移') : '',
    hasPanelStyleDetail ? '门板线条/造型：必须按门板线条/造型细节图处理门扇表面的线条、压线、门芯凹凸或造型结构' : '',
    hasGlassGrilleDetail ? '气窗：必须按气窗细节图处理玻璃、镂空、格栅、透光窗或对应装饰区域' : '',
    hasHeaderColumnDetail ? '门头/门柱：必须按门头/门柱细节图处理双开门门头、门楣、门柱、立柱或外框装饰区域' : '',
    hasTextureReference ? '材质纹理：必须按材质纹理参考图处理门体表面的木纹、拉丝、颗粒、肤感、哑光/亮光等纹理和表面质感' : '',
    hasLeftLeafDetail ? '左门扇细节：必须按左门扇细节图补充或融合左门扇局部线条、纹理、玻璃、装饰或材质细节；只能作用于左门扇对应区域，不能改变整门门扇数量、左右比例、中缝、把手、锁体和包边' : '',
    hasRightLeafDetail ? '右门扇细节：必须按右门扇细节图补充或融合右门扇局部线条、纹理、玻璃、装饰或材质细节；只能作用于右门扇对应区域，不能改变整门门扇数量、左右比例、中缝、把手、锁体和包边' : '',
    hasChildLeafDetail ? '小门扇细节：必须按小门扇细节图补充或融合子母门小门扇局部线条、纹理、玻璃、装饰或材质细节；只能作用于小门扇对应区域，不能把子母比例改成平分门' : '',
    hasMiddleJoinDetail ? '中缝/拼接细节：必须按中缝/拼接细节图处理门缝收口、拼接条、对缝、压条、止口或局部衔接；只能作用于已有中缝/拼缝位置，不能改变门扇数量、每扇宽窄比例、门体颜色和五金位置' : '',
    hasBackgroundReference ? '背景：必须以背景参考图为最终背景底图，把第一张整门图中的门抠出并贴入背景图目标门位；即使客户没有填写背景信息，只要上传了背景参考图，也必须执行抠图贴合；背景参考图不能作为门款或门体部件参考，也不能被整体重绘' : '',
    hasColorSample
        ? (edgeTrimColorProtectedFromColorSample
        ? (edgeTrimPreserveMeansReferenceColor
          ? `门体颜色：必须按颜色参考图调整门扇/门体可见表面颜色${colorSampleUsesReferenceTexture ? '和纹理/材质观感' : ''}；包边因客户明确要求颜色保持不变，必须保持包边参考图中包边自身的可见颜色，不参与门体统一颜色`
          : `门体颜色：必须按颜色参考图调整门扇/门体可见表面颜色${colorSampleUsesReferenceTexture ? '和纹理/材质观感' : ''}；包边因客户明确要求独立颜色，按客户包边颜色或包边参考图颜色执行`)
        : `整门颜色：默认必须按颜色参考图统一调整整门可见门面颜色${colorSampleUsesReferenceTexture ? '和纹理/材质观感' : ''}，包含包边/门套${colorSampleAppliesToHeaderColumn ? '、门头/门柱/外框装饰' : ''}同色；如补充要求指定局部不同颜色，则按指定部件优先`)
      : ''
  ].filter(Boolean);
  const requiredReferenceTaskInstruction = requiredReferenceTasks.length
    ? [
        `结构化强制任务清单：${requiredReferenceTasks.join('；')}。`,
        '以上任务是并列关系，不是互斥关系；如果同时上传了多个参考图，最终成图必须同时完成这些参考图对应的修改。',
        '不要只执行其中一个参考图任务后忽略其他已上传参考图。',
        hasEdgeTrimDetail
          ? '包边验收标准：只要上传了包边参考图，最终图中包边/门套线/收口条/压线区域必须能看出来自参考图的宽窄、层次、截面、线条或收边方式变化；颜色同门同色不等于完成包边任务，保留原包边结构不变视为失败。'
          : ''
      ].filter(Boolean).join('\n')
    : '';
  const edgeTrimIndependentColorInstruction = edgeTrimColorProtectedFromColorSample
    ? [
        '包边颜色独立意图解释：客户说“包边按参考图颜色”“包边单独颜色”“包边颜色保持不变”“包边颜色不要跟门走”等，都应理解为包边颜色不参与默认同门同色，不被颜色参考图或门体统一颜色覆盖。',
        userSelectedEdgeTrimReferenceColor
          ? `本次用户已在上传页选择“包边颜色和包边参考图颜色一样”，因此包边颜色必须按包边参考图中包边区域的照片像素取样色执行${edgeTrimStyle && edgeTrimStyle.sampledColor ? `：${describeSampledColor(edgeTrimStyle.sampledColor)}` : ''}。这是照片里的可见颜色，不要做白平衡校正、不要去光线、不要去阴影、不要自动美化。`
          : '',
        edgeTrimPreserveMeansReferenceColor
          ? '本次已上传包边参考图，且文字更接近“包边颜色保持不变”，这里的“不变”指保持包边参考图中包边自身的可见颜色；不要理解成保留主门旧包边颜色。'
          : '如果客户指定了具体色名或色号，就按客户指定；如果客户说按包边参考图颜色，就按包边参考图；如果只说包边单独/不要同门，则由 AI 根据客户语义和上传参考图判断最合理的独立包边颜色，但绝不能自动拉成门体颜色。',
        '无论包边颜色如何独立，包边结构仍必须来自包边参考图，门扇主体结构必须来自第一张整门图。'
      ].filter(Boolean).join('\n')
    : '';
  const layeredTaskOrderInstruction = requiredReferenceTasks.length
    ? [
        hasColorSample
          ? '强制执行顺序：先锁定第一张整门图的门型几何、门扇比例、线条位置和把手位置，再按已上传局部参考图分别处理对应局部层（包边、锁体、门板造型、气窗、门头/门柱、材质纹理等），再按颜色参考图处理门体颜色层，最后才处理背景/白底。'
          : '强制执行顺序：先锁定第一张整门图的门型几何、门扇比例、线条位置、门体原始颜色和把手位置，再按已上传局部参考图分别处理对应局部层（包边、锁体、门板造型、气窗、门头/门柱、材质纹理等），最后才处理背景/白底；本次没有颜色参考图，不存在门体颜色层。',
        edgeTrimColorProtectedFromColorSample
          ? (edgeTrimPreserveMeansReferenceColor
            ? '后执行的任务不能覆盖先执行的任务：客户已经明确要求包边颜色保持不变，因此颜色任务不能把包边统一成门体颜色；包边颜色应保持包边参考图自身可见颜色，背景/白底任务不能删除、变浅、简化或重画包边。'
            : '后执行的任务不能覆盖先执行的任务：客户已经明确要求包边独立颜色，因此颜色任务不能把包边统一成门体颜色；背景/白底任务不能删除、变浅、简化或重画包边。')
          : (hasColorSample
            ? `后执行的任务不能覆盖先执行的任务：颜色任务默认要覆盖门扇、门体、包边、门套、收口条、压线、同门体侧边${colorSampleAppliesToHeaderColumn ? '、门头、门楣、门柱、立柱和外框装饰' : ''}的可见门面颜色，使包边${colorSampleAppliesToHeaderColumn ? '、门头/门柱' : ''}与门体同色；但不能改变局部参考图提供的宽窄、层次、线条和收边结构；背景/白底任务不能删除、变浅、简化或重画包边${colorSampleAppliesToHeaderColumn ? '或门头/门柱' : ''}。`
            : '后执行的任务不能覆盖先执行的任务：本次没有颜色任务，门扇/门体颜色必须保持第一张整门图原样；包边同门同色只能通过调整包边颜色去匹配原门体颜色完成；背景/白底任务不能改变门体颜色，也不能删除、变浅、简化或重画包边。'),
        hasEdgeTrimDetail
          ? '最终自检：只要上传了包边参考图，成图中门洞周围必须能清楚看到参考包边的宽窄、层次、线条和收边结构；如果包边仍是原图旧结构、没有可见结构变化、白底后变成无层次的普通边框或消失，视为失败。'
          : '',
        hasHeaderColumnDetail
          ? (colorSampleAppliesToHeaderColumn
            ? '最终自检：只要同时上传了门头/门柱参考图和颜色参考图，成图中双开门外框区域必须同时满足“结构来自门头/门柱参考图、颜色跟颜色参考图/门体统一”；如果门头/门柱仍是原图旧结构、没有可见融合变化、颜色没有跟给定颜色统一，或带动门扇比例变化，视为失败。'
            : '最终自检：只要上传了门头/门柱参考图，成图中双开门外框区域必须能清楚看到参考门头、门楣、门柱、立柱或外框装饰的结构特征；如果门头/门柱仍是原图旧结构、没有可见融合变化，或带动门扇比例/颜色变化，视为失败。')
          : '',
        hasColorSample
          ? (edgeTrimColorProtectedFromColorSample
            ? '最终自检：只要同时上传包边参考图和颜色参考图，必须同时完成“包边结构来自包边参考图、门扇/门体颜色来自颜色参考图、包边颜色按客户独立颜色意图执行”，不能只改颜色而忽略包边结构，也不能把包边拉成门体同色。'
            : '最终自检：只要同时上传包边参考图和颜色参考图，必须同时完成“包边结构来自包边参考图、整门颜色来自颜色参考图且包边默认同门同色”，不能只改颜色而忽略包边结构。')
          : '最终自检：没有颜色参考图时，最终门扇/门体颜色必须仍然是第一张整门图的原颜色；如果门体被改成包边参考图颜色，视为失败。'
      ].join('\n')
    : '';
  const doorSurfaceColorFreezeInstruction = freezeDoorSurfaceColor
    ? [
        '最高优先级门体颜色冻结：本次没有上传颜色参考图，也没有客户明确要求改变门体颜色，因此第一张整门图中的门扇/门体颜色必须保持原样。',
        hasEdgeTrimDetail
          ? '包边默认跟门同色的含义是：把新包边的颜色调整为第一张整门图里的门体原始颜色；绝对不是把门体颜色改成包边参考图的颜色。'
          : '',
        allowBackgroundChange
          ? '背景白底、白板、去背景或场景调整只允许改变背景、墙面、地面和空间，不得把门扇/门体漂白、提亮、换色或改成包边参考图颜色。'
          : ''
      ].filter(Boolean).join('\n')
    : '';
  const edgeTrimStrictInstruction = hasEdgeTrimDetail
    ? [
        '高优先级指令：包边参考图是包边款式的唯一参考来源，严格程度与门把手细节图相同。',
        '高优先级指令：包边参考图可能是一张包边近景，也可能是一整扇门。无论是哪一种，都只能从中提取门洞周围的包边、门套线、收口条、压线、外框边缘和收边方式。',
        '禁止从包边参考图中迁移门扇主体、门芯造型、门板分割、门板花纹、玻璃、把手、锁体、门扇颜色或整门款式；参考图里那扇门不是要替换的门，只是包边来源。',
        '如果包边参考图是一整扇门，必须把它当作“包边取样图”，不能把它当作“新门样式图”。不要让最终门扇变成包边参考图中的那扇门。',
        '高优先级指令：只要输入中包含包边参考图，本次任务就默认必须执行“把该参考包边融合/替换到整门照中”的操作；这是强制目标，不需要等待客户额外说明，也不能因为颜色同门同色、补充要求为空、背景任务或颜色任务而跳过。',
        '任务目标：请先在整门照中识别原有包边、门套线、门框内外侧收口条、压线和边缘收口区域，再把包边参考图中的包边款式融合到这些对应位置。必须直接观察输入的包边参考图本身，即使系统识别文本为空或不完整，也要从参考图里提取包边结构。',
        '最终输出必须是一张已经使用参考包边后的完整整门效果图，不能只是把包边参考图当作颜色参考，也不能保留与参考图不一致的原包边。颜色同门同色时，也必须通过宽窄、层次、截面、线条、倒角、压线或收边方式体现包边已更换。',
        edgeTrimScopeLimitInstruction,
        allowBackgroundChange
          ? '背景、抠图或白底按客户背景要求执行；但背景变化不能反向改变门扇结构、门体原始颜色、包边参考任务、门体颜色任务或把手任务。'
          : '墙面、地面、背景和整体构图必须保持整门照原样。',
        '如果模型需要在“更完整地替换包边”和“保持门样式不变”之间取舍，必须优先保持门样式不变，只做更小范围的包边融合。',
        '包边融合失败判定：如果最终图出现新的门板分割、新的浮雕花纹、新的把手位置、新的门扇比例或把主门替换成参考门款式，都属于失败，必须退回为第一张整门图的门扇结构。',
        '包边未执行失败判定：如果最终图的包边/门套线/收口条/压线看起来仍是第一张整门图原来的结构，没有体现参考图的宽窄、层次、截面、线条或收边方式，也属于失败。',
        edgeTrimStyle && edgeTrimStyle.applyDescription
          ? (userWantsIndependentEdgeTrimColor
            ? (edgeTrimPreserveMeansReferenceColor
              ? `包边执行描述：${edgeTrimStyle.applyDescription}。这里的“颜色保持不变”指保持该包边参考图中的包边自身颜色。`
              : `包边执行描述：${edgeTrimStyle.applyDescription}。`)
            : '包边执行描述：只迁移包边参考图的结构、宽窄、层次、线条、纹理走向和收边方式；忽略包边参考图颜色，最终包边颜色跟门体/颜色参考图统一。')
          : '',
        '最终成图中的包边必须优先保持包边参考图中“门洞周围包边区域”的宽窄比例、截面层次、凹凸倒角、收边方式、线条、纹理走向和关键装饰细节。',
        userWantsIndependentEdgeTrimColor
          ? (edgeTrimPreserveMeansReferenceColor
            ? '客户这次明确要求包边颜色保持不变，因此包边结构和颜色都应来自包边参考图中的包边区域；不要改成门体颜色或颜色参考图颜色，也不要保留主门旧包边颜色。'
            : `客户这次明确要求包边使用独立颜色或按包边参考图颜色，因此包边颜色可以不同于门体；${edgeTrimStyle && edgeTrimStyle.sampledColor ? `包边颜色必须接近照片取样色 ${describeSampledColor(edgeTrimStyle.sampledColor)}；` : ''}但包边结构、宽窄比例、截面层次、线条和关键细节仍应保持与包边参考图一致。`)
          : (allowDoorSurfaceColorChange
            ? '默认规则：包边颜色必须跟门扇/门体同色。包边参考图默认不决定最终包边颜色，只决定包边结构、宽窄、层次、线条和收边方式；如果上传了颜色参考图，包边也应随整门一起使用该颜色参考图的颜色。'
            : '默认规则：包边颜色必须匹配第一张整门图的门扇/门体原始颜色。包边参考图默认不决定最终包边颜色，只决定包边结构、宽窄、层次、线条和收边方式；严禁为了让包边同色而把门体改成包边参考图颜色。'),
        allowEdgeTrimStyleChange
          ? '用户这次明确要求改变包边样式，因此可按要求调整样式；但除用户点名变化外，仍应尽量保留其余包边细节。'
          : '不要把包边简化成相似但不同的款式，不要擅自改变包边宽窄、线条、截面、倒角、收边或拼接结构。',
        allowEdgeTrimRemoveChange
          ? `用户这次明确要求删除或取消包边，因此可以按要求处理包边；但不要顺带改变门把手、门型结构或背景${hasColorSample ? '，门体颜色仍按颜色参考图执行' : '，门体颜色也保持原样'}。`
          : '不要擅自删除、弱化、替换或重新设计包边。'
      ].join('\n')
    : '';
  const auxiliaryReferenceInstruction = [
    hasEdgeTrimDetail
      ? '高优先级指令：输入中包含包边参考图时，系统默认必须自动识别、定位并更换/融合该包边参考；如果参考图是一整扇门，也必须只识别这扇门的包边并 P 到主门上，不需要客户额外说明“把包边 P 上去”。最终包边结构必须有可见变化，不能只保持原包边不动。'
      : '',
    hasColorSample
      ? (edgeTrimColorProtectedFromColorSample
        ? (edgeTrimPreserveMeansReferenceColor
          ? `高优先级指令：输入中包含颜色参考图时，AI 必须自动识别主色、色偏${colorSampleUsesReferenceTexture ? '、纹理和表面质感' : ''}，并默认按该颜色参考图调整门扇/门体可见表面颜色；不需要客户额外说明“改成这个颜色”。本次客户明确要求包边颜色保持不变，因此颜色参考图不得作用到包边，包边颜色保持包边参考图自身可见颜色。`
          : `高优先级指令：输入中包含颜色参考图时，AI 必须自动识别主色、色偏${colorSampleUsesReferenceTexture ? '、纹理和表面质感' : ''}，并默认按该颜色参考图调整门扇/门体可见表面颜色；不需要客户额外说明“改成这个颜色”。本次客户表达了包边颜色独立意图，因此包边颜色由 AI 根据客户语义判断，不参与整门统一颜色。`)
        : `高优先级指令：输入中包含颜色参考图时，AI 必须自动识别主色、色偏${colorSampleUsesReferenceTexture ? '、纹理和表面质感' : ''}，并默认按该颜色参考图统一调整整门可见门面颜色，包含包边/门套${colorSampleAppliesToHeaderColumn ? '、门头/门柱/外框装饰' : ''}同色；不需要客户额外说明“改成这个颜色”。如果补充要求明确写了不同部件不同颜色，则按局部指定优先。`)
      : '',
    hasEdgeTrimDetail || hasColorSample
      ? (edgeTrimColorProtectedFromColorSample
        ? (edgeTrimPreserveMeansReferenceColor
          ? '包边参考图和颜色参考图只用于约束对应部件；除非用户明确要求，不要因为这些参考图顺带改变门把手、门型结构、门扇样式、背景或其他未点名内容。多张参考图同时存在时，必须像图层编辑一样分别执行：包边层改包边结构并保持包边参考图自身颜色，颜色层只改门扇/门体可见表面，背景层只改背景；包边颜色保持不变的要求优先于整门同色。'
          : '包边参考图和颜色参考图只用于约束对应部件；除非用户明确要求，不要因为这些参考图顺带改变门把手、门型结构、门扇样式、背景或其他未点名内容。多张参考图同时存在时，必须像图层编辑一样分别执行：包边层只改包边结构并按客户语义判断包边独立颜色，颜色层只改门扇/门体可见表面，背景层只改背景；包边独立颜色不要被统一颜色覆盖。')
        : (hasColorSample
          ? `包边参考图和颜色参考图只用于约束对应部件；除非用户明确要求，不要因为这些参考图顺带改变门把手、门型结构、门扇样式、背景或其他未点名内容。多张参考图同时存在时，必须像图层编辑一样分别执行：包边层只改包边结构${hasHeaderColumnDetail ? '，门头/门柱层只改门头/门柱结构' : ''}，颜色层默认统一整门可见门面颜色并包含包边同色${colorSampleAppliesToHeaderColumn ? '、门头/门柱同色' : ''}，背景层只改背景；如果用户给某个部件指定了不同颜色，则该部件不要被统一颜色覆盖。`
          : '包边参考图只用于约束包边结构、宽窄、层次、线条和收边方式；本次没有颜色参考图，因此没有颜色层，不允许因为包边参考图或白底背景而改变门扇/门体颜色。包边颜色默认匹配第一张整门图的原门体颜色，背景层只改背景。'))
      : ''
  ].filter(Boolean).join('\n');
  const colorSampleStrictInstruction = hasColorSample
    ? [
        edgeTrimColorProtectedFromColorSample
          ? '高优先级指令：颜色参考图是门扇/门体可见表面的默认颜色和材质观感参考来源，严格程度与门把手、包边参考图相同；但客户已经表达包边颜色独立意图时，包边颜色不参与整门统一颜色，必须按客户语义判断是保持原包边色、用包边参考图色，还是用客户指定色。'
          : '高优先级指令：颜色参考图是整门默认统一颜色和材质观感的唯一颜色参考来源，严格程度与门把手、包边参考图相同。',
        targetColorCode
          ? `高优先级颜色标签约束：客户指定颜色编号/名称为 ${targetColorCode}。颜色参考图如为多色卡页面，最终颜色只能来自 ${targetColorCode} 对应的门板/色块；色名可以严格语义匹配，例如“粉白色”匹配“粉白”，但严禁使用相邻编号/名称、整页平均色、最大面积色、标题背景色或模型自行推断的近似色。`
          : '',
        colorSampleUsesReferenceTexture
          ? '纹理提取选项：用户已选择“同时提取色卡纹理”，因此目标色块/门板中的木纹、拉丝、颗粒、纹理方向、纹理粗细、明暗纹理色差和表面质感也属于本次颜色任务的一部分，需要随颜色一起迁移到门体可见表面。'
          : '纹理提取选项：用户没有选择“同时提取色卡纹理”，因此颜色参考图只约束颜色、色偏、明度和饱和度；不要强制把色卡里的木纹方向、颗粒、拉丝或材质纹理迁移到门体上，原门已有纹理结构应尽量保留。',
        '颜色取样规则：颜色参考图必须按 Photoshop 吸管工具的思路执行，以图片中肉眼可见的主取样色为准。不要推断材料本身固有色，不要自动校正白平衡、环境光或拍摄偏色；看到什么颜色就用什么颜色。只避开明显高光点、反光点、深阴影、污渍和噪点。',
        colorSampleAppliesToEdgeTrim
          ? '高优先级指令：只要输入中包含颜色参考图，本次任务就默认必须执行“把整门照中的可见门面颜色统一调整为该参考颜色”的操作；这是强制目标，不需要等待客户额外说明。'
          : '高优先级指令：只要输入中包含颜色参考图，本次任务就默认必须执行“把整门照中的门扇/门体可见表面颜色调整为该参考颜色”的操作；这是强制目标，不需要等待客户额外说明。包边因客户表达独立颜色意图而另行执行。',
        colorSampleAppliesToEdgeTrim
          ? `默认统一范围：门扇正面、门板凹凸面、装饰线/压线、同一门体上的可见侧边、门框/门套/包边${colorSampleAppliesToHeaderColumn ? '、门头、门楣、门柱、立柱、外框装饰' : ''}等属于这扇门的可见门面区域，默认都应呈现同一参考色系和材质观感，不能只改中间门板而留下其他门面区域明显不同色。`
          : '默认范围：门扇正面、门板凹凸面、门体同材质压线和同门体可见侧边；因为客户表达了包边颜色独立意图，本次必须排除包边、门套线、收口条和外框边缘的颜色统一。',
        edgeTrimColorProtectedFromColorSample
          ? '优先级例外：客户已经表达包边颜色独立意图，因此包边颜色按客户语义独立执行，不被整门统一颜色覆盖；其他部件只有在补充要求明确指定不同颜色时，才按局部颜色优先。'
          : '优先级例外：只有补充要求明确指定某个部件使用不同颜色时，该部件才按局部颜色优先；包边参考图默认只提供结构，不会让包边颜色脱离整门统一颜色。',
        `颜色执行描述：${(colorSampleStyle && (colorSampleStyle.applyDescription || colorSampleStyle.color)) || (targetColorCode ? `按颜色标签 ${targetColorCode} 对应门板的可见主取样色、纹理和材质观感为准` : '以颜色参考图中的可见主取样色、纹理和材质观感为准')}。`,
        colorSampleStyle && colorSampleStyle.sampledColor
          ? `程序取样色：${describeSampledColor(colorSampleStyle.sampledColor)}。这是从照片目标区域直接取得的 RGB 中位数，只过滤极端高光和极端黑影；生成时必须优先接近这个照片可见色，不要做白平衡校正、不要去光线、不要去阴影、不要自动美化。`
          : '',
        `颜色约束：颜色大类=${(colorSampleStyle && colorSampleStyle.colorFamily) || '未识别'}；冷暖色偏=${(colorSampleStyle && colorSampleStyle.undertone) || '未识别'}；明度=${(colorSampleStyle && colorSampleStyle.brightness) || '未识别'}；饱和度=${(colorSampleStyle && colorSampleStyle.saturation) || '未识别'}；色相锁定=${(colorSampleStyle && colorSampleStyle.hueLock) || '未识别'}；明暗/灰度锁定=${(colorSampleStyle && colorSampleStyle.toneLock) || '未识别'}。`,
        colorSampleAppliesToEdgeTrim
          ? `请把颜色参考图中的可见主取样色应用到整门可见门面${colorSampleAppliesToHeaderColumn ? '，包括门头、门楣、门柱、立柱和外框装饰' : ''}。不要把参考图颜色重新解释为更亮、更暗、更暖、更冷或更灰的材料固有色。`
          : '请把颜色参考图中的可见主取样色应用到门扇/门体可见表面；包边颜色按客户表达的独立包边颜色意图处理。不要把参考图颜色重新解释为更亮、更暗、更暖、更冷或更灰的材料固有色。',
        '颜色匹配优先级高于“更自然”“更高级”“更协调”的自动美化；不要为了环境光、背景色或整体风格主动把可见取样色调暖、调冷、调红、调黄、调蓝、提亮、压暗、加灰或降饱和。',
        '必须保持可见取样色的色相、冷暖色偏、明度和饱和度关系。允许为了贴合原图光影做极轻微明暗过渡，但不能改变取样色本身。',
        '如果整门照环境光会让颜色看起来偏色，应优先让最终视觉颜色接近颜色参考图中的可见取样色，而不是校正成模型认为更合理的材质本色。',
        edgeTrimColorProtectedFromColorSample
          ? (colorSampleUsesReferenceTexture
            ? '颜色任务只允许调整门扇/门体可见表面的颜色、目标色卡纹理色差和必要材质观感；包边颜色按客户表达的独立包边颜色意图执行，不被颜色参考图覆盖；包边宽窄、层次和线条按包边参考图执行；颜色任务本身不得改变门型结构、门板线条数量、线条位置、凹凸深浅、玻璃、把手和门框比例；如本次同时上传门板造型或气窗参考图，对应变化只由对应参考图任务控制。'
            : '颜色任务只允许调整门扇/门体可见表面的颜色、色偏、明度和饱和度；不要强制迁移颜色参考图纹理；包边颜色按客户表达的独立包边颜色意图执行，不被颜色参考图覆盖；包边宽窄、层次和线条按包边参考图执行；颜色任务本身不得改变门型结构、门板线条数量、线条位置、凹凸深浅、玻璃、把手和门框比例；如本次同时上传门板造型或气窗参考图，对应变化只由对应参考图任务控制。')
          : (colorSampleUsesReferenceTexture
            ? `颜色任务默认允许统一调整整门可见门面颜色、目标色卡纹理色差和必要材质观感，包括门扇、压线、同门体侧边、包边/门套${colorSampleAppliesToHeaderColumn ? '、门头/门柱/外框装饰' : ''}等可见门面区域；颜色任务本身不得改变门型结构、门板线条数量、线条位置、凹凸深浅、玻璃、把手、包边、门头/门柱结构和门框比例；如本次同时上传门板造型、气窗或门头/门柱参考图，对应结构变化只由对应参考图任务控制。`
            : `颜色任务默认允许统一调整整门可见门面颜色、色偏、明度和饱和度，包括门扇、压线、同门体侧边、包边/门套${colorSampleAppliesToHeaderColumn ? '、门头/门柱/外框装饰' : ''}等可见门面区域；不要强制迁移颜色参考图纹理；颜色任务本身不得改变门型结构、门板线条数量、线条位置、凹凸深浅、玻璃、把手、包边、门头/门柱结构和门框比例；如本次同时上传门板造型、气窗或门头/门柱参考图，对应结构变化只由对应参考图任务控制。`),
        allowBackgroundChange
          ? '背景、抠图或白底按客户背景要求执行；颜色任务不能与背景任务互相覆盖。'
          : '墙面、地面、背景和整体构图必须保持整门照原样。',
        colorSampleAppliesToEdgeTrim
          ? '统一颜色只表示同一扇门的可见门面默认同色系，不表示可以重画门款、增加新线条或改变包边宽窄结构。不要把颜色参考图误当成新的门款式，不要因为改颜色而重绘门扇结构或替换门型。'
          : '门体颜色只表示门扇/门体可见表面按颜色参考图调整，不表示可以重画门款、增加新线条、改变包边颜色或改变包边宽窄结构。不要把颜色参考图误当成新的门款式，不要因为改颜色而重绘门扇结构或替换门型。',
        edgeTrimColorProtectedFromColorSample
          ? '最终自检：客户表达包边颜色独立意图时，最终包边颜色必须按客户语义独立处理，不能被颜色参考图拉成门扇颜色，也不能被默认同门同色规则覆盖。'
          : '',
        '如果无法精确匹配颜色，应优先保持门型结构不变，再尽量接近颜色参考图的可见取样色。'
      ].filter(Boolean).join('\n')
    : '';
  const headerColumnColorUnificationInstruction = colorSampleAppliesToHeaderColumn
    ? [
        '最高优先级门头/门柱同色规则：本次同时上传了颜色参考图和门头/门柱参考图，且客户没有明确要求门头/门柱单独颜色，因此门头、门楣、横梁、罗马柱、侧柱、立柱、外框装饰必须跟颜色参考图/门体颜色统一。',
        '门头/门柱参考图只决定结构、层次、轮廓、线条和装饰细节；它自身的深灰、黑色、木色或拍摄环境色不能保留为最终颜色。',
        '颜色层必须最后校正门头/门柱颜色：如果门扇已经变成目标色，但门头、门楣、门柱、立柱或外框仍是深灰/黑色/原参考图色，就属于失败结果。',
        '允许门头/门柱因为阴影和凹凸产生合理明暗层次，但整体色相、冷暖、明度和饱和度必须归入同一目标色系，不能看起来像另一套深色门头柱。'
      ].join('\n')
    : '';
  const finalColorCoverageInstruction = hasColorSample
    ? [
        '最终颜色覆盖自检：颜色参考图是最终颜色层来源。除非客户明确指定某个部件独立颜色，否则最终图不能只把中间门扇改色而留下门框、门套、包边、侧边、门头、门楣、门柱、立柱或外框装饰保持第一张整门图的旧深色/旧灰色。',
        colorSampleAppliesToHeaderColumn
          ? '本次同时有门头/门柱参考图和颜色参考图，门头/门柱/外框装饰必须先按门头/门柱参考图处理结构，再被颜色参考图统一校色；“门头/门柱参考图不是颜色参考图”不能被解释为门头/门柱不用跟随颜色参考图。'
          : '',
        edgeTrimColorProtectedFromColorSample
          ? '包边存在独立颜色意图时，包边颜色按独立意图执行；但门扇/门体和没有独立颜色要求的其他门面区域仍必须按颜色参考图执行。'
          : '包边没有独立颜色意图时，包边/门套/收口条/压线必须随门体按颜色参考图统一，不能保留旧包边颜色。'
      ].filter(Boolean).join('\n')
    : '';
  const singleDoorAdditionalPartInstruction = [
    hasLockDetail
      ? [
          '锁体/智能锁边界：锁体/智能锁参考图只约束锁具、锁孔、智能锁面板、猫眼、门铃和其必要安装衔接区域。',
          '替换前必须先检查第一张整门图中是否存在原智能锁或隐蔽智能锁：凡是类似锁、拉手、黑色面板、装饰块或小五金的物体附近有一个不属于门花纹的小圆孔/锁孔/指示孔，就应判定为原智能锁区域。该原智能锁区域必须被本次参考智能锁覆盖或清理，不能残留在最终图里，也不能把原智能锁和新智能锁同时画出来。',
          lockReferenceIsHandleIntegrated
            ? `系统识别到该智能锁与把手为物理一体式结构，因此本次锁体任务必须把智能锁面板和一体式把手作为同一个不可拆整体替换到整门图上；把手数量、长度、宽窄、颜色和面板位置应随一体式锁具一起保持一致。只能替换与该一体式智能锁直接冲突的原智能锁/原把手；双开门、子母门或多开门中未被智能锁占用的另一侧拉手必须保留。小圆孔是独立实体应急锁孔，不属于把手本体，不能放在把手或黑色智能面板上。${lockReferenceIsDoubleHandle ? '参考图为双把手结构，必须在最终图中保留两根对应把手及其相对位置；不能减少成单把手。' : ''}`
            : '系统未识别为把手一体式智能锁，因此即使锁体参考图里拍到了普通把手，也只能把普通把手当作定位参考，不复制普通把手款式；但智能锁面板、密码/指纹/刷卡区、锁芯孔、小圆孔和必要底座必须迁移到整门图。若原把手或原五金遮挡智能锁安装位置，允许覆盖或清理冲突区域，不能因为“保留原把手”而跳过智能锁；未遮挡智能锁安装位置的原把手必须保留。',
          lockStyle && lockStyle.hasRoundHole
            ? `智能锁参考图包含小圆孔，最终图必须保留真实实体应急锁孔细节；${lockStyle.roundHoleDescription || '小圆孔应位于智能锁或门缝附近的合理位置'}；相对位置=${lockStyle.roundHoleRelativePosition || '按参考图相对智能面板、把手和门缝的位置'}。一体式把手锁时，小圆孔不能在把手本体或黑色智能面板上，应位于门扇/中缝附近的独立位置；如果把手附近没有足够空间，可以让小圆孔整体小幅移动，但必须保持它相对智能面板、把手和门缝的关系，不要挪到门板中央或错误门扇。`
            : '如果智能锁结构需要小圆孔、锁芯孔或指示孔，应按参考图真实位置和尺寸保守添加；不要凭空放大或放到门板中央。',
          '如果参考图中包含整门，只能提取锁具外观，不能迁移参考图里的门板线条、包边、颜色、背景或整门款式。',
          lockReferenceIsHandleIntegrated
            ? '一体式智能锁修改仍不得改变门扇外轮廓、门板线条数量、门型比例、包边结构和背景；但一体式把手锁所在区域必须产生清晰可见的替换结果。为保持智能面板、把手和实体应急锁孔的相对位置，可以小幅度移动整个一体式把手锁的位置；移动幅度只限于五金安装区域内的对齐调整，不能大幅偏离原门合理安装区。把手长度不得明显缩短或变成与参考图不同的比例。'
            : '非一体式锁体/智能锁修改不得改变门扇外轮廓、门板线条数量、门型比例、包边结构和背景；但锁具安装区必须有清晰可见的新智能锁结果，允许为了放置智能锁面板而覆盖原锁具、旧锁孔或与锁具冲突的局部把手底座。'
        ].join('\n')
      : '',
    hasPanelStyleDetail
      ? [
          '门板线条/造型边界：门板线条/造型参考图只约束门扇表面的线条、压线、门芯凹凸、分割比例、浮雕或平板/凹板/凸板关系。',
          '如果参考图中包含整门，只能提取门板表面造型，不迁移把手、锁体、包边、背景、开门方向、整门比例或整门款式。',
          '门板造型可以影响门扇表面线条和凹凸关系，但必须保留第一张整门图的门扇外轮廓、透视角度、宽高比例、门框关系和已明确保留的把手/锁体位置。'
        ].join('\n')
      : '',
    hasGlassGrilleDetail
      ? [
          '气窗边界：气窗参考图只约束玻璃、长虹玻璃、磨砂/透明/茶玻/灰玻、镂空、格栅、透光窗、边框和收边方式。',
          '气窗参考图中的颜色只允许作用到气窗玻璃、格栅、透光窗或气窗小边框自身；不得把气窗照片里的颜色、白平衡、环境光、木色、墙色或门扇色迁移到整门门体。',
          '如果参考图中包含整门，只能提取气窗/透光窗区域，不迁移门板主体、门扇颜色、把手、锁体、包边、背景或整门款式。',
          '气窗修改不得改变第一张整门图的外轮廓、门型比例、门体颜色、未点名线条结构和包边关系；没有气窗位置时，应在不破坏门型的前提下保守融合。'
        ].join('\n')
      : '',
    hasHeaderColumnDetail
      ? [
          '门头/门柱边界：门头/门柱参考图只约束双开门外侧的门头、门楣、横梁、罗马柱、侧柱、立柱、外框装饰、柱头柱脚和门洞外圈衔接区域。',
          '门头/门柱参考图中的颜色只允许作用到门头/门柱/外框装饰自身；不得把参考图里的颜色、白平衡、环境光、墙色或门扇色迁移到双开门门扇、把手、锁体、气窗或背景。',
          '如果参考图中包含整门，只能提取门头/门柱/外框装饰区域，不迁移门扇主体、左右门扇比例、门板线条、门扇颜色、把手、锁体、气窗、背景或整门款式。',
          '门头/门柱修改不得改变第一张整门图的双开门门扇外轮廓、左右门扇比例、中缝位置、把手位置、锁体位置、门体颜色和未点名结构。'
        ].join('\n')
      : '',
    hasTextureReference
      ? [
          '材质纹理边界：材质纹理参考图只约束门体表面纹理、木纹、拉丝、颗粒、肤感、哑光/亮光、纹理方向、纹理粗细和表面质感。',
          '材质纹理参考图默认不是颜色参考、不是门型参考、不是包边/把手/锁体/玻璃参考；除非客户明确要求，不要把该图颜色当成最终门体颜色来源。',
          '迁移材质纹理时必须保持第一张整门图的门型结构、线条数量、线条位置、包边、把手、锁体、玻璃和背景不被重画。'
        ].join('\n')
      : ''
  ].filter(Boolean).join('\n');
  const additionalPartConflictResolutionInstruction = [
    hasPanelStyleDetail
      ? '冲突消解：本提示词中任何“保持门板线条、门芯造型、凹凸结构原样”的规则，都只约束门板线条/造型参考图以外的任务；客户已上传门板线条/造型参考图时，门扇表面线条、压线、凹凸和门芯造型允许按该参考图局部调整，但不能改变门扇外轮廓、比例、包边、把手、锁体、玻璃和背景。'
      : '',
    hasGlassGrilleDetail
      ? '冲突消解：本提示词中任何“保持玻璃、镂空或格栅原样”的规则，都只约束气窗参考图以外的任务；客户已上传气窗参考图时，玻璃、格栅、镂空、透光窗及其收边允许按该参考图局部调整，但不能改变门扇外轮廓、比例、门体颜色、包边、把手、锁体、无关门板线条和背景。气窗参考图不是颜色参考图，不能触发整门改色。'
      : '',
    hasHeaderColumnDetail
      ? '冲突消解：门头/门柱参考图只打开“门头、门楣、门柱、立柱和外框装饰”局部变化权限；不能改变双开门门扇比例、中缝、门板线条、门体颜色、包边、把手、锁体、气窗和背景。门头/门柱参考图不是颜色参考图，不能触发整门改色。'
      : '',
    hasTextureReference
      ? '冲突消解：材质纹理参考图只打开“纹理/表面质感”变化权限，不自动打开“门体改色”权限；如果没有颜色参考图或明确文字改色要求，门体可见颜色仍按原整门图保持，只让纹理方向、粗细、木纹/拉丝/颗粒和光泽质感接近参考。'
      : '',
    hasLeftLeafDetail || hasRightLeafDetail || hasChildLeafDetail
      ? '冲突消解：左门扇、右门扇或小门扇细节图只打开对应门扇局部细节变化权限；不能因为这些参考图改变门扇数量、每扇宽窄比例、中缝位置、把手位置、锁体位置、包边、背景或整门门款。'
      : '',
    hasMiddleJoinDetail
      ? '冲突消解：中缝/拼接细节图只打开已有中缝或拼缝位置的局部收口变化权限；不能因为中缝参考图改变门扇数量、每扇宽窄比例、门面颜色、门板整体造型、把手位置、锁体位置、包边或背景。'
      : '',
    hasLockDetail
      ? (lockReferenceIsHandleIntegrated
        ? '冲突消解：锁体/智能锁参考图被识别为把手一体式智能锁时，只额外打开“一体式把手锁整体”变化权限；不允许因锁具参考图改变门扇颜色、门板线条、包边、玻璃或背景，也不允许删除未与智能锁安装区冲突的另一侧原把手。'
        : '冲突消解：锁体/智能锁参考图只打开锁具五金局部变化权限，不允许因锁具参考图改变门扇颜色、门板线条、包边、玻璃、把手位置、把手款式或背景；参考图里的把手默认不迁移，未与锁体安装区冲突的原把手必须保留。')
      : '',
    hasBackgroundReference
      ? '冲突消解：背景参考图只打开“在背景图目标门位抠图贴入主门”的权限，不打开重绘背景权限；不允许因背景图改变门体颜色、门板线条、包边、把手、锁体、玻璃、材质纹理或门型比例。'
      : ''
  ].filter(Boolean).join('\n');
  const textColorInstruction = !hasColorSample && targetColorCode
    ? [
        `高优先级文字颜色指令：客户没有上传颜色参考图，但补充要求中明确指定门体/门扇颜色为“${targetColorCode}”。这本身就是有效改色需求，不能因为没有颜色参考图而冻结门体颜色。`,
        `请按常识理解“${targetColorCode}”的颜色含义；如果它是“粉白、莫兰迪粉、奶油白、浅灰木、银梨3号、铁灰橡木、清雅胡桃”等色卡名称或商业色名，就按该名称最直观对应的可见颜色、冷暖偏向、明度、饱和度和材质观感执行。`,
        '文字颜色只允许改变门扇/门体可见表面的颜色、纹理色差和必要材质观感；文字颜色任务本身不得重画门型、改变门板线条数量、线条位置、门扇比例、玻璃、把手或包边结构；如本次同时上传门板造型或气窗参考图，对应变化只由对应参考图任务控制。',
        '如果客户没有明确说包边独立颜色，包边默认跟门体同色；如果客户明确说包边颜色另做，则按局部颜色优先。'
      ].join('\n')
    : '';
  const edgeTrimOnlyFreezeInstruction = hasEdgeTrimOnlyReference
    ? [
        '本次只有包边参考图，且客户没有上传颜色参考图，也没有在文字中提出改颜色、改背景或其他变化。',
        '因此本次唯一允许变化的对象是包边/门套线/收口条/压线区域；包边颜色默认匹配第一张整门图的门体颜色，不按包边参考图的颜色独立变化。',
        '虽然颜色默认匹配门体，但包边结构必须发生可见替换：宽窄比例、截面层次、内外线条、压线、倒角或收边方式至少应有一项明显来自包边参考图。',
        '禁止改变门扇样式、门板纹理、门板颜色、门型结构、开门比例、玻璃形状、门把手、锁体、背景和整体构图。',
        '输出应看起来像在原整门照上只更换了包边，而不是重新生成了一扇门。'
      ].join('\n')
    : '';
  const structuredReferenceInstruction = [
    hasHandleDetail
      ? '结构化需求确认：客户上传了门把手细节图，因此“更换/融合门把手”本身已经是明确需求。'
      : '',
    hasEdgeTrimDetail
      ? '结构化需求确认：客户上传了包边参考图，因此“识别参考图中的包边并更换/融合包边”本身已经是明确需求，不应被理解为未点名改动。'
      : '',
    hasColorSample
      ? (edgeTrimColorProtectedFromColorSample
        ? `结构化需求确认：客户上传了颜色参考图，因此“默认按颜色参考调整门扇/门体可见表面颜色${colorSampleUsesReferenceTexture ? '和纹理/材质观感' : ''}”本身已经是明确需求；本次包边有独立包边约束，包边不参与门体统一颜色。`
        : `结构化需求确认：客户上传了颜色参考图，因此“默认按颜色参考统一整门可见门面颜色${colorSampleUsesReferenceTexture ? '和纹理/材质观感' : ''}，包边跟门体同色”本身已经是明确需求；如补充要求指定局部不同颜色，则局部指定优先。`)
      : '',
    hasLockDetail
      ? '结构化需求确认：客户上传了锁体/智能锁细节图，因此“识别并更换/融合锁体、锁孔、智能锁、猫眼等五金细节”本身已经是明确需求。'
      : '',
    hasPanelStyleDetail
      ? '结构化需求确认：客户上传了门板线条/造型细节图，因此“识别并调整门扇表面线条、压线、凹凸和门芯造型”本身已经是明确需求；该任务只作用于门扇表面造型，不等于重画整门。'
      : '',
    hasGlassGrilleDetail
      ? '结构化需求确认：客户上传了气窗细节图，因此“识别并更换/融合玻璃、格栅、镂空或透光窗细节”本身已经是明确需求。'
      : '',
    hasHeaderColumnDetail
      ? '结构化需求确认：客户上传了门头/门柱细节图，因此“识别并更换/融合双开门门头、门楣、门柱、立柱或外框装饰”本身已经是明确需求；该任务只作用于双开门外框装饰区域，不等于重画整门。'
      : '',
    hasTextureReference
      ? '结构化需求确认：客户上传了材质纹理参考图，因此“识别并迁移门体表面纹理和材质观感”本身已经是明确需求；默认不把该图颜色当成门体改色来源。'
      : '',
    hasLeftLeafDetail
      ? '结构化需求确认：客户上传了左门扇细节图，因此“识别并融合左门扇局部线条、纹理、玻璃、装饰或材质细节”本身已经是明确需求；该任务只作用于左门扇对应区域，不等于改变整门比例。'
      : '',
    hasRightLeafDetail
      ? '结构化需求确认：客户上传了右门扇细节图，因此“识别并融合右门扇局部线条、纹理、玻璃、装饰或材质细节”本身已经是明确需求；该任务只作用于右门扇对应区域，不等于改变整门比例。'
      : '',
    hasChildLeafDetail
      ? '结构化需求确认：客户上传了小门扇细节图，因此“识别并融合子母门小门扇局部线条、纹理、玻璃、装饰或材质细节”本身已经是明确需求；该任务只作用于小门扇对应区域，不等于改变子母比例。'
      : '',
    hasMiddleJoinDetail
      ? '结构化需求确认：客户上传了中缝/拼接细节图，因此“识别并融合门缝收口、拼接条、对缝、压条、止口或局部衔接方式”本身已经是明确需求；该任务只作用于已有中缝/拼缝位置，不等于改变门扇数量或比例。'
      : '',
    hasBackgroundReference
      ? '结构化需求确认：客户上传了背景参考图，因此“把主门抠图贴入背景图目标门位”本身已经是明确需求；背景图是最终背景底图，不是门款或门体部件参考，也不是要重绘的新背景。'
      : ''
  ].filter(Boolean).join('\n');
  const immutableBaseDoorInstruction = [
    hasBackgroundReference
      ? '最高优先级场景合成协议：最终图必须以背景参考图作为画布底图，以第一张整门上下文图作为唯一门体来源；任务是把第一张图里的门抠出并贴入背景参考图目标门位，不是把第一张图的背景保留下来。'
      : '最高优先级不可重绘协议：最终图必须沿用第一张整门上下文图中的同一扇门，不能重新画一扇相似的门，不能重新建模，不能替换成商品渲染门。',
    hasBackgroundReference
      ? '第一张整门图不是最终底图，而是门体抠图来源；背景参考图才是最终底图。必须保留第一张图的门型、颜色、包边、把手、锁体、玻璃和材质，同时保留背景参考图的墙面、地面、家具、装饰和空间构图。'
      : '第一张整门图不是“风格参考”，而是必须被保留的底图。所有修改都必须像在这张底图上做局部修图：只覆盖被允许修改的区域，其他区域应保持原图结构和布局。',
    hasPanelStyleDetail || hasGlassGrilleDetail || hasHeaderColumnDetail
      ? '基础冻结项：门扇外轮廓、宽高比例、透视角度、开门方向、把手安装位置、锁体位置、门框和门扇相对比例必须保持第一张整门图；门板线条/凹凸/门芯造型只有在上传了门板线条/造型参考图时才允许按该参考图局部调整；玻璃/镂空/格栅只有在上传了气窗参考图时才允许按该参考图局部调整；门头/门柱/外框装饰只有在上传了门头/门柱参考图时才允许按该参考图局部调整。'
      : '绝对冻结项：门扇外轮廓、宽高比例、透视角度、开门方向、门板分割数量、每条装饰线/压线的位置、门芯造型、凹凸深浅、玻璃/镂空位置、把手安装位置、锁体位置、门框和门扇相对比例。',
    lockReferenceIsHandleIntegrated
      ? '例外说明：本次锁体参考图已识别为把手一体式智能锁，因此“把手安装位置/把手形态冻结”只对非一体式把手区域生效；一体式智能锁所在把手区域必须随锁具整体替换、迁移和对齐，不能保留原把手锁。为了放置实体应急锁孔并保持相对位置，可以小幅度移动整个一体式把手锁，但不能移动到不合理门扇区域。'
      : '',
    allowDoorSurfaceColorChange
      ? (edgeTrimColorProtectedFromColorSample
        ? '允许变化项只限于已上传参考图、背景信息或客户文字明确要求的对象：包边层只改包边/门套线/收口条/压线区域，并按客户语义判断包边独立颜色；颜色层按颜色参考图调整门扇/门体可见表面，但不得覆盖包边独立颜色；背景层只在上传背景参考图、填写背景信息或要求抠图/白底时改背景；把手层只改把手区域；锁体层、门板造型层、气窗层、门头/门柱层、材质纹理层、左/右/小门扇细节层和中缝/拼接层仅在上传对应参考图时改对应区域。'
        : '允许变化项只限于已上传参考图、背景信息或客户文字明确要求的对象：包边层只改包边/门套线/收口条/压线区域；颜色层按颜色参考图统一调整整门可见门面，默认覆盖包边并让包边跟门体同色；只有客户明确要求包边独立颜色或按包边参考图颜色时，包边颜色才不参与统一；背景层只在上传背景参考图、填写背景信息或要求抠图/白底时改背景；把手层只改把手区域；锁体层、门板造型层、气窗层、门头/门柱层、材质纹理层、左/右/小门扇细节层和中缝/拼接层仅在上传对应参考图时改对应区域。')
      : hasBackgroundReference
        ? '允许变化项只限于已上传参考图、背景信息或客户文字明确要求的对象：背景层必须把第一张整门图的门体抠出并贴入背景参考图目标门位；门体本身不得改色、重画或换款，只允许整体缩放、透视拉伸、旋转、轻微裁切、边缘融合和接地阴影；把手层、包边层、锁体层、门板造型层、气窗层、门头/门柱层、材质纹理层、左/右/小门扇细节层和中缝/拼接层仅在上传对应参考图时改对应区域。'
        : '允许变化项只限于已上传参考图、背景信息或客户文字明确要求的对象：包边层只改包边/门套线/收口条/压线区域，并让包边颜色匹配第一张整门图的原门体颜色；本次没有颜色层，门扇/门体颜色不得改变；背景层只在上传背景参考图、填写背景信息或要求抠图/白底时改背景；把手层只改把手区域；锁体层、门板造型层、气窗层、门头/门柱层、材质纹理层、左/右/小门扇细节层和中缝/拼接层仅在上传对应参考图时改对应区域。',
    freezeDoorSurfaceColor ? '门体颜色冻结项：未上传颜色参考图且未明确要求改门体颜色时，门扇/门体颜色不属于允许变化项；气窗参考图、门头/门柱参考图、包边参考图、门板造型图、锁体图、把手图、材质纹理图和背景图都不能作为门体改色来源；包边同门同色时，只能改包边颜色去匹配第一张整门图的原门体颜色，不能反向改变门体颜色。' : '',
    '如果参考图中的包边、颜色、把手、锁体、门板造型、气窗、门头/门柱、材质纹理或背景与第一张整门图的基础门型冲突，必须优先保留第一张整门图的门体外轮廓、比例、透视和门框关系；只有对应目标区域允许局部融合，不能扩展成整门重画。',
    hasPanelStyleDetail || hasGlassGrilleDetail || hasHeaderColumnDetail
      ? '失败结果定义：除门板线条/造型参考图、气窗参考图和门头/门柱参考图明确对应的目标区域外，最终图只要出现新的门扇比例、新的把手位置、新的锁体位置、无关区域的新门板线条、无关区域的新玻璃位置、门体颜色被气窗或门头/门柱参考图带偏、或变成另一扇浅色/深色商品门，就属于失败，必须改回第一张整门图的基础门型和原门体颜色。'
      : '失败结果定义：最终图只要出现新的门板线条数量、新的线条位置、新的浮雕/门芯图案、新的门扇比例、新的把手位置、或变成另一扇浅色/深色商品门，就属于失败，必须改回第一张整门图的门型。',
    '不要为了白底、抠图、换颜色、换包边、换锁体、换气窗、迁移纹理、更干净、更高级、更真实、更协调而重绘门扇主体。'
  ].filter(Boolean).join('\n');
  const doorIdentityLockInstruction = [
    '最高优先级门型锁定：第一张整门上下文图是最终输出的唯一门型基底，不是风格参考图，也不是可自由重绘的提示图。',
    '本任务是“基于第一张整门图的局部编辑/换色/换包边/换局部部件”，不是“根据参考图重新生成一扇门”。',
    hasPanelStyleDetail || hasGlassGrilleDetail || hasHeaderColumnDetail
      ? '必须保留第一张整门图里的门扇外轮廓、宽高比例、开门方向、把手位置、锁体位置和门框相对比例；门板分割、线条位置、凹凸/浮雕/压线结构、玻璃位置、门头/门柱/外框装饰和门芯造型只有在对应上传参考图明确要求时，才允许在对应目标区域内局部调整。'
      : '必须保留第一张整门图里的门扇外轮廓、宽高比例、开门方向、门板分割数量、线条位置、凹凸/浮雕/压线结构、玻璃位置、门芯造型、把手位置和门框相对比例。',
    lockReferenceIsHandleIntegrated
      ? `把手一体式智能锁例外：只允许在一体式智能锁把手自身区域内替换把手和锁面板的整体位置、数量、长度、宽窄、颜色、黑色面板和安装衔接；允许为保持智能面板、把手和实体应急锁孔的相对位置而小幅移动整个一体式把手锁；小圆孔作为独立实体应急锁孔，不属于把手本体，不能放在把手或黑色智能面板上；${lockReferenceIsDoubleHandle ? '参考图是双把手时，最终必须保留双把手数量、左右/双扇相对位置和长短比例，不能生成单把手。' : ''}如果整门图中已有隐蔽智能锁、小圆孔或旧锁面板，必须被新的一体式智能锁覆盖或清理，不得叠加残留。门型、包边、门板线条和背景仍冻结。`
      : '',
    edgeTrimColorProtectedFromColorSample
      ? '包边参考图只约束包边/门套线/收口条/压线区域的结构、宽窄、层次、线条和收边方式；颜色参考图约束门扇/门体可见表面颜色、纹理色差和材质观感，但本次包边颜色按客户独立颜色意图执行；门把手细节图只约束门把手区域；锁体/智能锁参考图只约束锁具五金区域；门板造型参考图只约束门扇表面线条/凹凸/门芯造型；气窗参考图只约束气窗/透光窗/玻璃/格栅/镂空区域，气窗颜色只作用于该局部区域；门头/门柱参考图只约束门头/门楣/门柱/外框装饰区域；材质纹理参考图只约束门体表面纹理和质感；背景参考图和背景文字只约束背景、墙面、地面、空间和光线或抠图。'
      : '包边参考图只约束包边/门套线/收口条/压线区域的结构、宽窄、层次、线条和收边方式；颜色参考图默认约束整门可见门面颜色、纹理色差和材质观感，包含包边同色；门把手细节图只约束门把手区域；锁体/智能锁参考图只约束锁具五金区域；门板造型参考图只约束门扇表面线条/凹凸/门芯造型；气窗参考图只约束气窗/透光窗/玻璃/格栅/镂空区域，气窗颜色只作用于该局部区域；门头/门柱参考图只约束门头/门楣/门柱/外框装饰区域；材质纹理参考图只约束门体表面纹理和质感；背景参考图和背景文字只约束背景、墙面、地面、空间和光线或抠图。',
    freezeDoorSurfaceColor ? '没有颜色参考图或明确改门色要求时，必须保留第一张整门图的门体原始颜色；气窗参考图、门头/门柱参考图和包边参考图都不能作为门体颜色来源。' : '',
    hasPanelStyleDetail || hasGlassGrilleDetail || hasHeaderColumnDetail
      ? '如果最终图在目标区域以外的门板线条数量、线条位置、门芯造型、门扇比例、把手位置、锁体位置、开门方向或门框比例与第一张整门图明显不同，应视为失败结果，必须改回第一张整门图的基础门型。'
      : '如果最终图的门板线条数量、线条位置、门芯造型、门扇比例、把手位置、开门方向或门框比例与第一张整门图明显不同，应视为失败结果，必须改回第一张整门图的门型结构。',
    hasPanelStyleDetail
      ? '不要把第一张整门图重画成另一款门；门板线条/造型参考只能在门扇表面目标区域内改变线条、压线、凹凸和门芯关系，不能带动包边、把手、锁体、玻璃、门扇比例和背景改变。'
      : '不要把第一张整门图重画成另一款门，不要新增或删除门板装饰线，不要把平板门改成浮雕门，也不要把浮雕门改成平板门。',
    '即使用户要求白底、抠图、换背景、改颜色、换包边、换锁体、换气窗或迁移材质纹理，也只能在第一张整门图的基础门型上完成，不得生成一扇新的商品门。'
  ].filter(Boolean).join('\n');
  const cutoutPreservationInstruction = isCutoutRequest
    ? [
        '高优先级抠图说明：客户要求抠图、白底或把某一扇门单独扣出来时，含义是从第一张整门图中提取/保留指定门扇并更换背景，不是重新设计一扇新门。',
        '允许删除未被指定的旁边门扇、墙面、地面或原背景；但被保留的目标门扇必须沿用第一张整门图的门型、门板线条、凹凸结构、比例、把手位置和细节。',
        '抠图后即使背景变成白底，也不能因为画面更干净而重新生成门板造型、门芯花纹、把手位置或门框结构。'
      ].join('\n')
    : '';
  const backgroundInstruction = useDefaultWhiteBoardBackground
    ? [
        '背景要求：门部件拼接效果图默认使用白板背景。',
        '本用途不做自定义空间背景替换；如需按背景图或指定空间换背景，应使用“场景效果图”入口。',
        '请把第一张整门图中的原背景、墙面、地面和杂乱环境处理为干净白板/纯白展示背景，保留门体自然接地阴影或轻微投影，使门看起来不是悬浮的。',
        '白板背景只允许改变背景、墙面、地面和空间，不得改变门扇/门体颜色、包边结构、把手、锁体、玻璃、材质纹理、门型比例或已经执行的其他部件拼接任务。',
        backgroundInfo
          ? `客户填写的背景信息为“${backgroundInfo}”。在本用途下仅可理解为对白板背景的细节偏好，不能扩展成场景背景替换。`
          : ''
      ].filter(Boolean).join('\n')
    : hasBackgroundReference
      ? [
          `背景要求：${backgroundInfo || '按上传的背景参考图替换背景'}`,
          '最高优先级抠图贴合指令：客户上传了背景参考图，因此必须把背景参考图作为最终背景底图，并把第一张整门图中的门抠出后贴入背景图目标门位；即使客户没有填写背景信息，也不能默认不处理背景图。',
          '不要重新生成、重绘、改造或美化背景参考图。背景图中的墙面、地面、家具、装饰、光线和空间构图应尽量保持原样。',
          backgroundStyle && backgroundStyle.applyDescription
            ? `背景执行描述：${backgroundStyle.applyDescription}`
            : '',
          '背景参考图可能已经有旧门，也可能只留了门洞、门框、空白门位或预留矩形区域。必须先识别该旧门/门洞/预留门位的位置、四边、四角、底边接地点、透视角度、遮挡关系和光线方向。',
          '然后把第一张整门图中的门作为实际门体抠出并放入这个目标门位，按背景门位自动缩放、透视拉伸、旋转、裁切或补边，使门体外轮廓、门框边缘、底边和背景中的旧门/门洞/预留门位对齐。',
          '如果背景图里有旧门，最终应使用第一张整门图中的门替换旧门；旧门只提供位置、大小、透视、接地和光影参考，不能保留旧门款式，也不能迁移旧门颜色、线条、把手、锁体或包边。',
          '如果背景图里只有门洞或预留门位，最终应把第一张整门图中的门填入门洞/门位；门边缘要贴合门洞或门框，必要时做轻微透视变形和阴影融合。',
          '允许修改范围只限于：旧门/门洞/目标门位区域、主门贴合边缘、必要遮挡、接地阴影、轻微光影融合。除此之外的背景墙面、地面、家具、装饰、空间线条和整体光线尽量保持背景参考图原样。',
          '背景参考图只提供背景底图、目标门位、透视、接地和光影参考；不能把背景参考图里的门款、门板线条、包边、把手、锁体、玻璃、门体颜色或材质迁移到主门上。',
          '换背景时必须保留第一张整门图中的门体、门扇外轮廓、门框比例、包边、把手、锁体、玻璃、门体颜色、材质纹理和已经执行的其他局部部件任务；允许的几何变化只限于为了贴合背景门位所需的整体缩放、透视拉伸、旋转和轻微裁切。',
          '最终效果应像把原门真实安装到背景参考图的门位中：门与背景透视、接地、阴影和光线要协调，但不能为了协调而重画门或重画背景。'
        ].filter(Boolean).join('\n')
      : backgroundInfo
      ? [
          `背景要求：${backgroundInfo}`,
          '客户填写了背景信息，因此允许按该背景要求调整门后空间、墙面、地面、光线或场景氛围。',
          '背景调整只控制背景、空间、墙面、地面、光线或抠图白底效果；不能改变门型结构、门框比例、把手位置，也不能改变门扇/门体原始颜色或覆盖包边、颜色等其他已明确目标任务。'
        ].join('\n')
      : [
          '背景要求：未填写。',
          '高优先级指令：客户没有上传背景参考图，也没有填写背景信息，因此默认不改背景。',
          '必须保留整门照中的原背景、墙面、地面、空间、光线方向和整体构图；不要为了更高级、更协调或更真实而主动替换、虚化、美化或重绘背景。'
        ].join('\n');
  const modifyScopeInstruction = job && job.actionType === 'modify'
    ? [
        '高优先级指令：本次任务是继续修改，只允许执行用户这一次明确提出的修改要求；已有成功结果中的其他区域保持不变。',
        '系统门型锁定、参考图边界、颜色分层和背景边界继续有效，不能因为继续修改而放宽。',
        '最高原则：只有系统自动任务或用户明确说可以改的属性，才允许改；没有进入本次任务的属性，一律默认不改。',
        '最高原则：宁可少改，也不可多改；宁可保留原状，也不要擅自新增变化。',
        '除非用户这次明确要求改变门把手样式、颜色、材质、底座、轮廓、结构、纹理或装饰细节，否则这些内容都必须保持与当前输入图一致，不得擅自修改。',
        '如果用户明确要求改变其中某一项（例如只改颜色、只去掉底座），则只允许改那一项，其他把手属性仍保持不变。',
        '你必须自己判断用户点名允许改动的是哪一项属性，并把未点名属性视为冻结状态。',
        '除用户点名要改的局部外，其他门体、门框、玻璃、墙面、背景、光影关系和已有把手样式都不要动。',
        '如果用户只要求删除、弱化或调整某个局部，就只处理该局部，不要顺带优化、重绘、替换、美化或修正其他部分。',
        '当用户要求与把手有关的局部调整时，默认先保留现有把手款式、颜色、材质、结构、纹理和细节，只修改被明确点名的那一部分。',
        '如果对用户意图存在歧义，默认选择修改更少、保留更多原始内容的方案。'
      ].join('\n')
    : [
        '高优先级指令：本次只允许围绕系统自动任务（已上传参考图、背景信息）和客户补充要求出图，不要主动扩大发挥范围。',
        '客户补充要求只是一段简单偏好或额外说明，不需要客户自己写“保留门型、识别包边、不要重画、颜色分层”等专业约束；这些由系统自动任务负责。',
        '最高原则：只有系统自动任务或客户明确说可以改的属性，才允许改；没有进入本次任务的属性，一律默认不改。',
        '最高原则：宁可少改，也不可多改；宁可局部不完美，也不要擅自改变未被点名的内容。',
        '如果某个部分没有对应的上传参考图、背景信息或客户明确要求，就不要擅自修改该部分的样式、颜色、材质、结构、纹理、底座、轮廓或细节。',
        '你必须自己判断用户点名允许改动的是哪一项属性，并把未点名属性视为冻结状态。',
        '除目标部件及其必要衔接区域外，其他门体、门框、玻璃、墙面、背景和光影关系都应尽量保持原样。',
        '不要为了追求整体效果而主动重绘、替换、美化、优化、补全或修正未被点名的内容。',
        '如果某种改动会导致目标部件以外的区域发生明显变化，则应优先缩小改动范围，而不是扩大改动。',
        '如果无法同时满足所有要求，应优先保证未进入系统自动任务和补充要求的区域保持不变，其次再完成目标部件修改。'
      ].join('\n');
  const userRequirementInstruction = [
    `客户补充要求：${requirementText.trim() || '未填写'}`,
    '客户补充要求只用于表达简单偏好、额外文字说明或特殊例外，不要求客户写专业提示词。',
    '门型锁定、参考图自动识别、包边独立替换、颜色分层、背景边界和未点名区域冻结都由系统提示词自动处理。',
    '除非客户非常明确地点名要覆盖某个部件的颜色、样式或背景，否则补充要求不能削弱已上传参考图对应的自动任务。'
  ].join('\n');
  const frontDimensionSpanInstruction = isDimensionAnnotationTask && dimensionAnnotationData.viewSide === 'front'
    ? (dimensionAnnotationData.hasDoorOpeningRequest && dimensionAnnotationData.hasVisibleOpeningRequest
      ? '正面图门洞/见光尺寸取线规则：客户同时要求标注门洞尺寸和见光尺寸时，横向宽度必须形成三层清晰边界：含包边宽标最外侧包边外沿；门洞宽标包边厚度中线/半包边位置；见光宽标不含包边的净可见开口边界。竖向高度的底部如果没有下槛、气窗、门头或其他额外部件，应共用门底同一个下边界；不要为了分层把底部画到不同位置。竖向高度只通过上边界区分：含包边高的上边界取最外侧上包边外沿，门洞高的上边界取上包边厚度中线/半包边位置，见光高的上边界取不含包边的净可见开口上边界。'
      : dimensionAnnotationData.hasDoorOpeningRequest
        ? '正面图门洞尺寸取线规则：客户要求标注门洞尺寸且未要求标注见光尺寸时，门洞宽按不含包边的那部分取线，标到净开口/可见洞口边界，不把包边厚度算进去；门洞高的下边界取门底，门洞高的上边界取不含包边的净开口/可见洞口上边界；此时不要再额外画见光尺寸线。'
        : dimensionAnnotationData.hasVisibleOpeningRequest
          ? '正面图见光尺寸取线规则：客户未要求标注门洞尺寸但要求标注见光尺寸时，见光宽按不包含门洞洞口外扩部分的可见范围取线；见光高的下边界取门底，见光高的上边界取净可见开口上边界；此时不要再额外画门洞尺寸线。'
          : '')
    : '';
  const dimensionBoxInstruction = isDimensionAnnotationTask ? buildDimensionBoxInstruction(dimensionBoxes) : '';
  const dimensionAnnotationInstruction = isDimensionAnnotationTask
    ? [
        '尺寸标注任务：本次用途是“尺寸标注图”，输出应是在第一张整门照上叠加清晰、工整、可读的尺寸辅助线、箭头、引线和文字标注。',
        `尺寸标注门类：${dimensionAnnotationData.doorType}。不同门类只影响门洞、见光、含包边、含气窗、含门头等统一尺寸项的取线边界，不得额外标注门扇分段、中缝或五金尺寸。`,
        `尺寸标注图面方向：${dimensionAnnotationData.viewSideLabel}。必须按这张图的实际可见面标注，不要把正面和背面的五金、合页、开启方向、左右关系混用。`,
        dimensionAnnotationData.viewSide === 'back'
          ? '背面图标注规则：以客户从背面看到的左右为准；只标注客户在结构化输入里选择/填写的尺寸项。未出现在可选输入项里的五金、合页和玻璃类尺寸不要主动标注。'
          : '正面图标注规则：以客户从正面看到的左右为准；只标注客户在结构化输入里选择/填写的尺寸项。未出现在可选输入项里的五金、合页和玻璃类尺寸不要主动标注。',
        dimensionBoxInstruction,
        frontDimensionSpanInstruction,
        '墙体厚度标注规则：如果客户填写墙体厚度，不要画尺寸线；只在画面右下角空白处单独写两行文字，格式必须为“墙体厚度：”换行“xxxmm”。',
        '含气窗高取线规则：从气窗最上沿标到门的最下沿，包含气窗和门体整体高度；不要标气窗自身净高。',
        '含门头宽/含门头高取线规则：含门头宽标整套门与门头、门柱合在一起的最外侧总宽；含门头高标整套门与门头、门柱合在一起的最上沿到最下沿总高。',
        '尺寸线边界硬约束：每个被填写的尺寸只画对应一条横向或竖向尺寸线；没有被填写/选择的项目不要补线。横向尺寸线必须贴近对应左右边界，竖向尺寸线必须贴近对应上下边界；不要为了排版把门洞线、见光线、含包边线画到错误层级。',
        `本门类可选尺寸输入项：${dimensionAnnotationData.fields.map((field) => `${field.label}(${field.unit})`).join('、')}。这些项目都是前端可给客户填写的数字输入框，单位固定为 mm。`,
        dimensionAnnotationData.provided.length
          ? `客户已选择/填写的尺寸项：${dimensionAnnotationData.provided.map((field) => `${field.annotationLabel}${field.valueText ? `：${field.valueText}` : '：待测'}`).join('；')}。最终图必须优先标注这些项目。`
          : '客户未填写结构化尺寸数值；可以根据补充要求中的明确尺寸做标注，否则只标项目名称或“待测”。',
        '所有尺寸单位必须显示为 mm。客户输入字段只表示数字，但最终图中文字必须补上 mm，例如输入 2050 时标为 2050mm。',
        '标注优先级：优先标注客户结构化输入的尺寸值，其次标注客户补充要求中给出的具体尺寸值；只允许标注门洞宽、门洞高、见光宽、见光高、含包边宽、含包边高、墙体厚度、含气窗高、含门头宽、含门头高。',
        '严禁编造尺寸：如果客户没有提供某个具体数值，不要凭空写 900mm、2100mm 等数字；可以只标注项目名称，如“门洞宽”“含包边高”“含气窗高”，或使用“待测”提示。',
        '尺寸标注必须像施工沟通图：线条沿门洞、门扇、包边或五金对应边缘摆放，文字不要遮挡门体关键细节；标注应横平竖直、层级清楚、中文可读。',
        '尺寸标注不是重新设计门。除叠加标注线、箭头和文字外，必须保持原门、包边、把手、锁体、玻璃、背景、颜色、材质、光影和构图不变。',
        '如果客户同时上传了包边、颜色、锁体、门板造型、气窗或材质纹理参考图，先按对应任务完成局部编辑，再在最终图上叠加尺寸标注；尺寸标注不能覆盖或削弱这些局部任务。'
      ].filter(Boolean).join('\n')
    : '';
  const backgroundInputOrderInstruction = hasBackgroundReference
    ? [
        maskBox
          ? '输入顺序强约束：本次为了启用背景门位 mask，输入图1是背景参考图，也是最终画布底图；输入图2是整门上下文图，也是唯一门体/门型/门色/五金来源。'
          : '输入顺序强约束：输入图1是背景参考图，也是最终画布底图；输入图2是整门上下文图，也是唯一门体/门型/门色/五金来源。',
        '后文所有“第一张整门图”“整门上下文图”“主门图”“原门”都指输入图2这张整门图，绝不指输入图1背景图中的旧门。',
        '输入图1中的旧门、门洞或预留门位只用于定位、透视、尺寸、接地和遮挡关系；不得把输入图1里的旧门款式、颜色、包边、把手、锁体、玻璃或材质迁移到结果门上。',
        '最终结果应等于：输入图1背景底图 + 输入图2整门抠图贴入输入图1的 mask 门位区域；不是重新画一张室内效果图。'
      ].join('\n')
    : '';

  return [
    backgroundInputOrderInstruction,
    immutableBaseDoorInstruction,
    hasBackgroundReference
      ? '请把输入图1背景参考图当作最终画布底图，把输入图2整门上下文图当作门体抠图来源；最终图应是“输入图1背景空间中安装了输入图2的门”。'
      : '请把第一张整门上下文图当作底图，在保留原始拍摄角度和整体构图的前提下做局部编辑。',
    hasBackgroundReference
      ? '输出必须是一张基于输入图1背景参考图合成后的完整场景效果图，不能返回输入图2整门图的原背景，不能返回单独门体、局部裁切图、拼贴参考图，也不能重新设计新门或新背景。'
      : '输出必须是一张基于第一张整门图编辑后的完整整门效果图，不能返回单独的门把手参考图、局部裁切图、拼贴参考图、仅展示局部的图片，也不能返回一张重新设计的新门。',
    '禁止从零生成新门款；禁止把其他参考图中的整门样式迁移到第一张整门图上；禁止把第一张整门图替换成看起来相似但线条、比例、门芯或把手位置不同的新门。',
    `用途：${job.templateType || '门业展示'}`,
    `任务类型：${taskType || '未指定'}`,
    `门类型：${job.doorType || '未指定'}`,
    `目标部件：${targetPartText}`,
    dimensionAnnotationInstruction,
    backgroundInstruction,
    doorSurfaceColorFreezeInstruction,
    userRequirementInstruction,
    imageLines.length ? imageLines.join('\n') : '参考图：未提供多图标记',
    maskInstruction,
    doorIdentityLockInstruction,
    cutoutPreservationInstruction,
    handleStyleInstruction,
    handleReferenceSmartLockFreezeInstruction,
    lockDetailMustApplyInstruction,
    multiLeafDoorLockInstruction,
    headerColumnOverridesEdgeTrimInstruction,
    referenceStyleInstruction,
    requiredReferenceTaskInstruction,
    edgeTrimIndependentColorInstruction,
    layeredTaskOrderInstruction,
    edgeTrimStrictInstruction,
    auxiliaryReferenceInstruction,
    colorSampleStrictInstruction,
    headerColumnColorUnificationInstruction,
    singleDoorAdditionalPartInstruction,
    additionalPartConflictResolutionInstruction,
    finalColorCoverageInstruction,
    textColorInstruction,
    edgeTrimOnlyFreezeInstruction,
    structuredReferenceInstruction,
    modifyScopeInstruction,
    !hasHandleDetail && !hasEdgeTrimDetail && !hasColorSample && !hasLockDetail && !hasPanelStyleDetail && !hasGlassGrilleDetail && !hasHeaderColumnDetail && !hasTextureReference && !hasBackgroundReference
      ? '当前没有门把手细节照，请先在整门图中识别门把手区域，仅围绕门把手及必要衔接区域做处理，不要改变原门的材质、颜色、纹理、漆面和整体结构。'
      : !hasHandleDetail
        ? (lockReferenceIsHandleIntegrated
          ? '当前没有单独上传门把手细节照，但已上传的锁体/智能锁参考图被识别为把手一体式智能锁；因此不能套用“保持现有门把手”的规则，必须把参考图中的一体式把手智能锁整体替换到整门图上。'
          : '当前没有门把手细节照，请保持整门图中的现有门把手，不要擅自改变门把手款式、颜色、材质或底座；本次应优先执行已上传参考图对应的包边、颜色、锁体、门板造型、气窗、门头/门柱、材质纹理或背景任务。')
        : [
          '高优先级指令：只要输入中包含门把手细节图，本次任务就默认必须执行“把该门把手融合到整门照中”的操作；这是强制目标，不需要等待客户额外说明。',
          '高优先级指令：整门上下文图是最终输出的唯一基底图，必须保留其门扇、门框、材质、颜色、纹理、漆面、表面工艺、光影和整体结构，不得重绘成其他材质或风格。',
          '高优先级指令：任何不属于门把手及其必要衔接区域的变化，都应视为不合格修改，必须避免。',
          '高优先级指令：门把手细节图是门把手款式的唯一参考来源，请先准确识别并提取该门把手主体，不要自行设计、替换或脑补其他把手款式。',
          '任务目标：必须在整门照中原门把手所在位置完成门把手的替换或融合，可理解为把细节图中的门把手直接贴合到整门照中，并输出已经上把手后的最终效果图。',
          '如果整门照中的原把手与细节图不一致，应以细节图中的门把手为准完成替换，而不是保留原把手。',
          '融合时必须优先保持门把手的材质、造型、颜色、纹理、边界、底座结构、边角转折和关键细节一致，再匹配整门图中的位置、比例、透视、光照、阴影与遮挡关系。',
          '除门把手及其必要衔接区域外，禁止修改门板、门框、玻璃、墙面和背景；不要改变原门的材质、颜色、纹理和表面质感。',
          '如果无法同时满足全部要求，也必须优先保证整门材质不变，并且最终成图里明确出现来自细节图款式的门把手；宁可保留细节图中的底座、轮廓、线条、转角和装饰特征，也不要生成一个只有大体相似轮廓的新把手。'
        ].join('\n'),
    '优先围绕目标部件和门体关系做优化，不要把整门上下文误解为所有部件都需要大改。'
  ].join('\n');
}

function getFileExtensionFromPath(value, fallback) {
  const matched = /\.([a-zA-Z0-9]+)(?:$|\?)/.exec(value || '');
  return matched ? matched[1].toLowerCase() : (fallback || 'png');
}

function getMimeType(extension) {
  switch ((extension || '').toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'png':
    default:
      return 'image/png';
  }
}

function getResultCloudPath(jobId, version, extension) {
  const ext = extension || 'png';
  return `ai-jobs/result/${jobId}/v${version || 1}-${Date.now()}.${ext}`;
}

function downloadRemoteBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = /^https:/i.test(url) ? https : http;
    const request = client.get(url, (response) => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        resolve(downloadRemoteBuffer(response.headers.location));
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`下载结果图片失败：${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });

    request.on('error', reject);
  });
}

async function getJob(jobId) {
  const detail = await withTimeout(
    collection.doc(jobId).get(),
    CLOUDBASE_TIMEOUT_MS,
    '读取任务'
  );
  const data = detail && detail.data;
  if (Array.isArray(data)) {
    return data[0] || null;
  }
  return data || null;
}

async function updateJob(jobId, data) {
  await withTimeout(
    collection.doc(jobId).update(data),
    CLOUDBASE_TIMEOUT_MS,
    '更新任务'
  );
}

async function downloadOriginalImage(fileID) {
  const result = await withTimeout(
    app.downloadFile({
      fileID
    }),
    CLOUDBASE_TIMEOUT_MS,
    '下载原图'
  );
  return result.fileContent;
}

async function uploadResult(jobId, version, buffer) {
  const cloudPath = getResultCloudPath(jobId, version, 'png');
  console.log('[worker] uploading result image', {
    jobId,
    cloudPath,
    bytes: buffer ? buffer.length : 0,
    timeoutMs: CLOUDBASE_UPLOAD_TIMEOUT_MS,
    maxAttempts: 2,
    totalTimeoutMs: CLOUDBASE_UPLOAD_TIMEOUT_MS * 2
  });
  const result = await retryOperation('上传结果图', () => withTimeout(
    app.uploadFile({
      cloudPath,
      fileContent: buffer
    }),
    CLOUDBASE_UPLOAD_TIMEOUT_MS,
    '上传结果图'
  ), 2);
  return result.fileID;
}

function shouldUseNewDimensionPipeline(job) {
  return USE_NEW_DIMENSION_PIPELINE && normalizeTaskType(job) === TaskType.DIMENSION_ANNOTATION;
}

function getSourceImageFileID(job) {
  const primaryImage = getPrimaryReferenceImage(job);
  return (primaryImage && primaryImage.originalImageFileID) ||
    job.primaryImageFileID ||
    job.originalImageFileID ||
    '';
}

function getResultBufferArtifact(jobView) {
  const artifacts = jobView && jobView.result && Array.isArray(jobView.result.artifacts)
    ? jobView.result.artifacts
    : [];
  const resultBufferRef = artifacts.find((artifact) => artifact && artifact.type === 'resultBuffer');
  if (!resultBufferRef) {
    return null;
  }
  return getArtifact(resultBufferRef.artifactId);
}

function normalizeDimensionWhiteBackground(job) {
  if (typeof (job && job.whiteBackground) === 'boolean') {
    return job.whiteBackground;
  }
  if (typeof (job && job.dimensionWhiteBackground) === 'boolean') {
    return job.dimensionWhiteBackground;
  }
  const backgroundInfo = String(job && job.backgroundInfo ? job.backgroundInfo : '');
  const requirement = String(job && job.requirement ? job.requirement : '');
  return /白板|白底|纯白|改白/.test(`${backgroundInfo} ${requirement}`);
}

async function processDimensionAnnotationJobWithNewPipeline(jobId, job) {
  const sourceImageFileID = getSourceImageFileID(job);
  if (!sourceImageFileID) {
    throw new Error('缺少原始图片');
  }

  await updateJob(jobId, {
    status: 'processing',
    provider: 'structured-worker',
    providerStatus: 'processing',
    errorMessage: '',
    updatedAt: Date.now()
  });

  const sourceBuffer = await downloadOriginalImage(sourceImageFileID);
  const imageSize = getImageSize(sourceBuffer, sourceImageFileID);
  const structuredJob = createStructuredJob({
    taskType: TaskType.DIMENSION_ANNOTATION,
    doorType: job.doorType,
    viewSide: job.dimensionViewSide || job.viewSide,
    inputs: getDimensionInputMap(job),
    image: sourceBuffer,
    imageSize,
    whiteBackground: normalizeDimensionWhiteBackground(job),
    metadata: {
      legacyJobId: jobId,
      sourceImageFileID
    }
  });

  const structuredResult = await runStructuredJob(structuredJob.jobId);
  if (structuredResult.status !== 'succeeded') {
    await updateJob(jobId, {
      status: 'failed',
      provider: 'structured-worker',
      providerStatus: structuredResult.status,
      errorMessage: structuredResult.error && structuredResult.error.message
        ? structuredResult.error.message
        : '尺寸标注结构化流程失败',
      structuredPipelineJobId: structuredJob.jobId,
      structuredPipelineStatus: structuredResult.status,
      structuredPipelineError: structuredResult.error || null,
      needsManualReview: structuredResult.status === 'needs_user_adjustment',
      updatedAt: Date.now()
    });
    return;
  }

  const resultBufferArtifact = getResultBufferArtifact(structuredResult);
  const resultBuffer = resultBufferArtifact && resultBufferArtifact.value;
  if (!Buffer.isBuffer(resultBuffer)) {
    throw new Error('尺寸标注结构化流程未生成可上传图片');
  }

  const resultImageFileID = await uploadResult(jobId, job.version || 1, resultBuffer);
  const time = Date.now();
  const nextVersions = (job.versions || []).concat({
    resultImageFileID,
    text: job.requirement || '尺寸标注图',
    time,
    imageUrl: ''
  });

  await updateJob(jobId, {
    status: 'success',
    provider: 'structured-worker',
    providerStatus: 'success',
    resultImageFileID,
    errorMessage: '',
    structuredPipelineJobId: structuredJob.jobId,
    structuredPipelineStatus: structuredResult.status,
    structuredPipelineMetadata: structuredResult.metadata || {},
    updatedAt: time,
    versions: nextVersions
  });
}

async function createInputImage(fileID, sourceBuffer, fallbackName) {
  const extension = getFileExtensionFromPath(fileID, 'png');
  return toFile(sourceBuffer, fallbackName || `door-source.${extension}`, {
    type: getMimeType(extension)
  });
}

async function createMaskFile(maskBuffer) {
  return toFile(maskBuffer, 'edit-mask.png', {
    type: 'image/png'
  });
}

async function buildEditArtifacts(job) {
  const primaryImage = getPrimaryReferenceImage(job);
  if (!primaryImage) {
    if (!job.originalImageFileID) {
      throw new Error('缺少原始图片');
    }
    const sourceBuffer = await downloadOriginalImage(job.originalImageFileID);
    console.log('[worker] downloaded source image', job._id || job.jobId, sourceBuffer.length);
    return {
      inputImages: [await createInputImage(job.originalImageFileID, sourceBuffer, 'door-source.png')],
      maskFile: null,
      maskBox: null,
      detectionMode: 'single-image-fallback',
      primaryBuffer: sourceBuffer,
      primarySize: getImageSize(sourceBuffer, job.originalImageFileID)
    };
  }

  const primaryBuffer = await downloadOriginalImage(primaryImage.originalImageFileID);
  let inputImages = [];
  const referenceBuffers = {};
  const handleDetail = getHandleDetailImage(job);
  const lockDetail = getLockDetailImage(job);
  const backgroundReference = getBackgroundReferenceImage(job);
  let handleBuffer = null;
  let lockBuffer = null;
  const referenceImages = getReferenceImages(job);
  const hasHeaderColumnReference = referenceImages.some((item) => item && item.slotId === 'header-column-detail');
  const effectiveReferenceImages = hasHeaderColumnReference
    ? referenceImages.filter((item) => !(item && item.slotId === 'edge-trim-detail'))
    : referenceImages;
  for (const referenceImage of referenceImages) {
    if (!referenceImage || !referenceImage.originalImageFileID || referenceImage.slotId === 'full-door') {
      continue;
    }
    const referenceBuffer = await downloadOriginalImage(referenceImage.originalImageFileID);
    referenceBuffers[referenceImage.slotId || referenceImage.originalImageFileID] = referenceBuffer;
    if (handleDetail && referenceImage.slotId === handleDetail.slotId) {
      handleBuffer = referenceBuffer;
    }
    if (lockDetail && referenceImage.slotId === lockDetail.slotId) {
      lockBuffer = referenceBuffer;
    }
  }

  const primarySize = getImageSize(primaryBuffer, primaryImage.originalImageFileID);
  if (!primarySize || !primarySize.width || !primarySize.height) {
    throw new Error('无法识别整门照尺寸，暂时不能生成门把手编辑区域');
  }
  let maskBox = null;
  let maskFile = null;
  let detectionMode = 'none';
  let handleStyle = null;
  let directCompositeBuffer = null;
  let directCompositePlacement = null;
  let dimensionBoxes = null;
  const referenceStyles = [];
  const detectableReferenceSlotIds = getDetectableReferenceSlotIds();
  const hasMultiPartReference = effectiveReferenceImages.some((item) => item && detectableReferenceSlotIds.includes(item.slotId));
  const effectiveDetailReferences = effectiveReferenceImages
    .filter((item) => item && item.slotId && item.slotId !== 'full-door' && item.slotId !== 'background-reference');
  const shouldBuildLockMask = !handleDetail && !!lockDetail && !backgroundReference &&
    effectiveDetailReferences.length === 1 && effectiveDetailReferences[0].slotId === 'lock-detail';
  if (normalizeTaskType(job) === 'dimension-annotation') {
    try {
      dimensionBoxes = await detectDimensionBoxes(
        primaryBuffer,
        primaryImage.originalImageFileID,
        primarySize,
        job
      );
    } catch (error) {
      console.warn('[worker] vision dimension boundary detection failed', {
        jobId: job._id || job.jobId,
        message: error && error.message ? error.message : error
      });
    }
  }
  if (handleDetail) {
    try {
      handleStyle = await detectHandleStyle(
        primaryBuffer,
        primaryImage.originalImageFileID,
        handleBuffer,
        handleDetail.originalImageFileID
      );
    } catch (error) {
      console.warn('[worker] vision handle style detection failed', job._id || job.jobId, error && error.message ? error.message : error);
    }
    if (hasMultiPartReference) {
      detectionMode = 'multi-part-reference-no-mask';
    } else {
      try {
        maskBox = await detectHandleMaskBox(
          primaryBuffer,
          primaryImage.originalImageFileID,
          handleBuffer,
          handleDetail.originalImageFileID,
          primarySize,
          job
        );
      } catch (error) {
        console.warn('[worker] vision handle detection failed', job._id || job.jobId, error && error.message ? error.message : error);
      }
      if (!maskBox) {
        maskBox = inferHandleMaskBox(primarySize, handleBuffer, job);
      }
      if (!maskBox) {
        throw new Error('未能确定门把手编辑区域');
      }
      const maskBuffer = buildHandleMaskBuffer(primarySize.width, primarySize.height, maskBox);
      maskFile = await createMaskFile(maskBuffer);
      detectionMode = maskBox.source || 'heuristic';
    }
  }
  if (shouldBuildLockMask) {
    try {
      maskBox = await detectLockMaskBox(
        primaryBuffer,
        primaryImage.originalImageFileID,
        lockBuffer,
        lockDetail.originalImageFileID,
        primarySize,
        job
      );
    } catch (error) {
      console.warn('[worker] vision lock mask detection failed', {
        jobId: job._id || job.jobId,
        message: error && error.message ? error.message : error
      });
    }
    if (!maskBox) {
      maskBox = inferLockMaskBox(primarySize, lockBuffer, job);
    }
    if (maskBox) {
      const maskBuffer = buildHandleMaskBuffer(primarySize.width, primarySize.height, maskBox);
      maskFile = await createMaskFile(maskBuffer);
      detectionMode = maskBox.source || 'lock-heuristic';
    }
  }
  for (const referenceImage of effectiveReferenceImages) {
    if (!referenceImage || !detectableReferenceSlotIds.includes(referenceImage.slotId)) {
      continue;
    }
    try {
      const style = await detectReferenceStyle(
        referenceImage,
        referenceBuffers[referenceImage.slotId],
        job
      );
      if (style) {
        try {
          style.sampledColor = await sampleVisibleMedianColor(
            referenceImage,
            referenceBuffers[referenceImage.slotId],
            style
          );
        } catch (error) {
          console.warn('[worker] reference color sampling failed', {
            jobId: job._id || job.jobId,
            slotId: referenceImage.slotId,
            message: error && error.message ? error.message : error
          });
        }
        referenceStyles.push(style);
      }
    } catch (error) {
      console.warn('[worker] vision reference style detection failed', {
        jobId: job._id || job.jobId,
        slotId: referenceImage.slotId,
        message: error && error.message ? error.message : error
      });
    }
  }
  if (backgroundReference) {
    const backgroundBuffer = referenceBuffers[backgroundReference.slotId];
    const backgroundStyle = referenceStyles.find((style) => style && style.slotId === 'background-reference');
    const backgroundSize = getImageSize(backgroundBuffer, backgroundReference.originalImageFileID);
    if (backgroundBuffer && backgroundSize && backgroundSize.width && backgroundSize.height) {
      const targetDoorwayBox = backgroundStyle && backgroundStyle.sampleBox
        ? backgroundStyle.sampleBox
        : { left: 0.24, top: 0.08, right: 0.76, bottom: 0.96 };
      const backgroundMaskBox = sampleBoxToMaskBox(
        targetDoorwayBox,
        backgroundSize,
        backgroundStyle && backgroundStyle.sampleBox
          ? 'background-doorway-vision-sample-box'
          : 'background-doorway-fallback-center-box'
      );
      if (backgroundMaskBox) {
        const maskBuffer = buildHandleMaskBuffer(backgroundSize.width, backgroundSize.height, backgroundMaskBox);
        maskFile = await createMaskFile(maskBuffer);
        maskBox = backgroundMaskBox;
        detectionMode = backgroundStyle && backgroundStyle.sampleBox
          ? 'background-reference-mask'
          : 'background-reference-mask-fallback';
      }
      if (sharp && ENABLE_DIRECT_BACKGROUND_COMPOSITE) {
        try {
          directCompositePlacement = await detectDoorPlacement(
            primaryBuffer,
            primaryImage.originalImageFileID,
            backgroundBuffer,
            backgroundReference.originalImageFileID,
            primarySize,
            backgroundSize,
            job
          );
        } catch (error) {
          console.warn('[worker] vision door placement detection failed', {
            jobId: job._id || job.jobId,
            message: error && error.message ? error.message : error
          });
        }
        if (!directCompositePlacement && maskBox) {
          directCompositePlacement = {
            sourceDoorBox: normalizeMaskBox({
              left: primarySize.width * 0.03,
              top: primarySize.height * 0.02,
              right: primarySize.width * 0.97,
              bottom: primarySize.height * 0.98
            }, primarySize, 'fallback-primary-door-box'),
            targetDoorQuad: boxToQuad(maskBox),
            confidence: 'fallback',
            notes: 'fallback from background mask box'
          };
        }
        if (directCompositePlacement) {
          directCompositeBuffer = await composeDoorIntoBackground(
            primaryBuffer,
            backgroundBuffer,
            directCompositePlacement
          );
          if (directCompositeBuffer) {
            detectionMode = 'direct-vision-placement-composite';
          }
        }
      } else if (sharp) {
        console.log('[worker] direct background composite disabled; using image api scene generation', {
          jobId: job._id || job.jobId,
          enableEnv: 'ENABLE_DIRECT_BACKGROUND_COMPOSITE=true'
        });
      }
    }
    if (backgroundBuffer) {
      inputImages.push(await createInputImage(
        backgroundReference.originalImageFileID,
        backgroundBuffer,
        'background-reference.png'
      ));
    }
    inputImages.push(await createInputImage(primaryImage.originalImageFileID, primaryBuffer, `${primaryImage.slotId || 'full-door'}.png`));
    for (const referenceImage of effectiveReferenceImages) {
      if (
        !referenceImage ||
        !referenceImage.originalImageFileID ||
        referenceImage.slotId === 'full-door' ||
        referenceImage.slotId === 'background-reference'
      ) {
        continue;
      }
      inputImages.push(await createInputImage(
        referenceImage.originalImageFileID,
        referenceBuffers[referenceImage.slotId || referenceImage.originalImageFileID],
        `${referenceImage.slotId || 'reference'}.png`
      ));
    }
  } else {
    inputImages = [await createInputImage(primaryImage.originalImageFileID, primaryBuffer, `${primaryImage.slotId || 'full-door'}.png`)];
    for (const referenceImage of effectiveReferenceImages) {
      if (!referenceImage || !referenceImage.originalImageFileID || referenceImage.slotId === 'full-door') {
        continue;
      }
      inputImages.push(await createInputImage(
        referenceImage.originalImageFileID,
        referenceBuffers[referenceImage.slotId || referenceImage.originalImageFileID],
        `${referenceImage.slotId || 'reference'}.png`
      ));
    }
  }

  console.log('[worker] downloaded edit artifacts', job._id || job.jobId, {
    inputImageCount: inputImages.length,
    hasHandleDetail: !!handleDetail,
    hasLockDetail: !!lockDetail,
    hasEdgeTrimDetail: effectiveReferenceImages.some((item) => item && item.slotId === 'edge-trim-detail'),
    hasHeaderColumnReference,
    ignoredEdgeTrimBecauseHeaderColumn: hasHeaderColumnReference && referenceImages.some((item) => item && item.slotId === 'edge-trim-detail'),
    hasColorSample: effectiveReferenceImages.some((item) => item && item.slotId === 'color-sample'),
    hasBackgroundReference: effectiveReferenceImages.some((item) => item && item.slotId === 'background-reference'),
    referenceSlots: effectiveReferenceImages.map((item) => item && item.slotId).filter(Boolean),
    inputImageOrder: backgroundReference
      ? ['background-reference', 'full-door'].concat(effectiveReferenceImages
        .map((item) => item && item.slotId)
        .filter((slotId) => slotId && slotId !== 'background-reference' && slotId !== 'full-door'))
      : effectiveReferenceImages.map((item) => item && item.slotId).filter(Boolean),
    referenceOptions: effectiveReferenceImages.map((item) => ({
      slotId: item && item.slotId,
      colorMode: item && item.colorMode,
      textureMode: item && item.textureMode
    })).filter((item) => item.slotId),
    primarySize,
    detectionMode,
    maskBox,
    directComposite: directCompositeBuffer ? {
      enabled: true,
      bytes: directCompositeBuffer.length,
      placement: directCompositePlacement
    } : null,
    handleStyle,
    referenceStyles,
    dimensionBoxes
  });

  return {
    inputImages,
    maskFile,
    maskBox,
    detectionMode,
    primaryBuffer,
    primarySize,
    handleDetail,
    handleBuffer,
    lockDetail,
    lockBuffer,
    referenceBuffers,
    handleStyle,
    referenceStyles,
    dimensionBoxes,
    directCompositeBuffer,
    directCompositePlacement
  };
}

async function readImageResponseBody(response) {
  if (!response || !response.data || !response.data[0]) {
    throw new Error('没有拿到处理结果');
  }
  const first = response.data[0];
  if (first.b64_json) {
    return Buffer.from(first.b64_json, 'base64');
  }
  if (first.url) {
    return downloadRemoteBuffer(first.url);
  }
  throw new Error('暂时无法识别返回图片');
}

function shouldRetryImageApi(error) {
  if (!error) {
    return false;
  }
  if (error.status === 408 || error.status === 409 || error.status === 429) {
    return true;
  }
  if (error.status >= 500) {
    return true;
  }
  return /timeout|timed out|socket hang up|ECONNRESET|ETIMEDOUT|fetch failed/i.test(error.message || '');
}

function shouldTryNextImageModel(error, modelIndex, modelCandidates) {
  if (!modelCandidates || modelIndex >= modelCandidates.length - 1) {
    return false;
  }
  const message = error && error.message ? error.message : '';
  if (/upstream access forbidden|access forbidden|unsupported model|model.*not.*found|does not exist/i.test(message)) {
    return true;
  }
  return !!(error && [500, 502, 503, 504].includes(Number(error.status)));
}

function isLegacySingleImageEditModel(model) {
  return /^dall-e-2$/i.test(String(model || '').trim());
}

function getImageInputForModel(model, inputImages) {
  if (isLegacySingleImageEditModel(model) && Array.isArray(inputImages)) {
    return inputImages[0];
  }
  return inputImages;
}

function buildLegacyImageEditPrompt(prompt) {
  const sourceText = String(prompt || '').replace(/\r/g, '\n');
  const importantLines = sourceText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      return /用途|任务类型|门类型|目标部件|客户补充要求|结构化强制任务清单|颜色执行描述|包边执行描述|背景要求|把手|智能锁|锁体|包边|门头|门柱|玻璃|气窗|颜色|材质|纹理|白板/.test(line);
    });
  const condensed = importantLines.slice(0, 18).join('；');
  const fallbackPrompt = [
    '请对输入门图做局部真实图片编辑，保持门体比例、构图、透视、背景和未点名区域不变。',
    '只改客户指定的门部件、颜色、材质、把手、锁体、包边、门头、门柱、玻璃或背景区域。',
    '不要生成尺寸线、不要加文字、不要重画整张图。',
    condensed || sourceText.replace(/\s+/g, ' ').slice(0, 700)
  ].join(' ');
  return fallbackPrompt.slice(0, 950);
}

function getPromptForImageModel(model, prompt) {
  if (isLegacySingleImageEditModel(model)) {
    return buildLegacyImageEditPrompt(prompt);
  }
  return prompt;
}

function summarizeOpenAIError(error) {
  return {
    name: error && error.name ? error.name : '',
    status: error && error.status ? error.status : '',
    type: error && error.type ? error.type : '',
    code: error && error.code ? error.code : '',
    requestID: error && error.requestID ? error.requestID : '',
    message: error && error.message ? error.message : String(error || '')
  };
}

function getProviderErrorMessage(error) {
  return error && error.message ? error.message : String(error || '');
}

function getWorkerErrorCode(error) {
  const message = getProviderErrorMessage(error);
  if (/upstream access forbidden|access forbidden/i.test(message)) {
    return 'IMAGE_PROVIDER_UNAVAILABLE';
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message)) {
    return 'IMAGE_PROVIDER_TIMEOUT';
  }
  return 'IMAGE_PROCESS_FAILED';
}

function getPublicWorkerErrorMessage(error) {
  const message = getProviderErrorMessage(error);
  if (/upstream access forbidden|access forbidden/i.test(message)) {
    return 'AI 图片编辑服务暂时不可用，请稍后重试。';
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message)) {
    return 'AI 图片编辑服务响应超时，请稍后重试。';
  }
  return message || '处理失败，请稍后再试';
}

async function requestEditedImage(jobId, inputImages, prompt, options) {
  const requestOptions = options || {};
  const modelCandidates = [OPENAI_IMAGE_MODEL].concat(OPENAI_IMAGE_FALLBACK_MODELS).filter((model, index, list) => (
    model && list.indexOf(model) === index
  ));
  let lastError = null;

  for (let modelIndex = 0; modelIndex < modelCandidates.length; modelIndex += 1) {
    const imageModel = modelCandidates[modelIndex];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const startedAt = Date.now();
      try {
        console.log('[worker] calling image api', {
          jobId,
          attempt,
          imageCount: inputImages.length,
          hasMask: !!requestOptions.mask,
          baseURL: getSanitizedBaseUrl(OPENAI_BASE_URL),
          model: imageModel,
          primaryModel: OPENAI_IMAGE_MODEL,
          fallbackModels: OPENAI_IMAGE_FALLBACK_MODELS,
          legacySingleImageInput: isLegacySingleImageEditModel(imageModel),
          visionModel: OPENAI_VISION_MODEL,
          visionReasoningEffort: OPENAI_VISION_REASONING_EFFORT || 'none',
          timeoutMs: OPENAI_IMAGE_TIMEOUT_MS
        });
        const response = await withTimeout(openai.images.edit({
          model: imageModel,
          image: getImageInputForModel(imageModel, inputImages),
          ...(requestOptions.mask ? { mask: requestOptions.mask } : {}),
          prompt: getPromptForImageModel(imageModel, prompt),
          size: '1024x1024'
        }, {
          timeout: OPENAI_IMAGE_TIMEOUT_MS
        }), OPENAI_IMAGE_TIMEOUT_MS + 5000, '图片编辑接口');
        console.log('[worker] image api returned', {
          jobId,
          attempt,
          model: imageModel,
          elapsedMs: Date.now() - startedAt
        });
        return response;
      } catch (error) {
        lastError = error;
        const errorSummary = summarizeOpenAIError(error);
        console.warn('[worker] image api failed', {
          jobId,
          attempt,
          elapsedMs: Date.now() - startedAt,
          baseURL: getSanitizedBaseUrl(OPENAI_BASE_URL),
          model: imageModel,
          ...errorSummary
        });
        if (attempt === 1 && shouldRetryImageApi(error)) {
          console.warn('[worker] retrying image api after retryable error', {
            jobId,
            model: imageModel,
            requestID: errorSummary.requestID,
            message: errorSummary.message
          });
          continue;
        }
        if (shouldTryNextImageModel(error, modelIndex, modelCandidates)) {
          console.warn('[worker] retrying image api with fallback model', {
            jobId,
            failedModel: imageModel,
            fallbackModel: modelCandidates[modelIndex + 1],
            requestID: errorSummary.requestID,
            message: errorSummary.message
          });
          break;
        }
        throw error;
      }
    }
  }
  throw lastError || new Error('图片生成失败');
}

async function processJob(jobId) {
  assertConfigured();
  console.log('[worker] start processJob', jobId);

  const job = await getJob(jobId);
  console.log('[worker] fetched job', jobId, !!job, job ? Object.keys(job) : [], job && (job.primaryImageFileID || job.originalImageFileID));
  if (!job) {
    throw new Error('未找到任务');
  }
  if (!(job.primaryImageFileID || job.originalImageFileID)) {
    throw new Error('缺少原始图片');
  }

  if (shouldUseNewDimensionPipeline(job)) {
    console.log('[worker] using structured dimension pipeline', {
      jobId,
      featureFlag: 'USE_NEW_DIMENSION_PIPELINE'
    });
    await processDimensionAnnotationJobWithNewPipeline(jobId, job);
    console.log('[worker] completed structured dimension job', jobId);
    return;
  }

  await updateJob(jobId, {
    status: 'processing',
    provider: 'openai-worker',
    providerStatus: 'processing',
    errorMessage: '',
    updatedAt: Date.now()
  });
  console.log('[worker] updated job to processing', jobId);

  const editArtifacts = await buildEditArtifacts(job);
  console.log('[worker] prepared input images', jobId, {
    imageCount: editArtifacts.inputImages.length,
    hasMask: !!editArtifacts.maskFile,
    maskBox: editArtifacts.maskBox,
    detectionMode: editArtifacts.detectionMode,
    hasDirectComposite: !!editArtifacts.directCompositeBuffer
  });
  const prompt = buildDoorImageInstruction(
    job,
    editArtifacts.maskBox,
    editArtifacts.handleStyle,
    editArtifacts.referenceStyles,
    editArtifacts.dimensionBoxes
  );
  console.log('[worker] built prompt', {
    jobId,
    hasHandleDetail: !!getHandleDetailImage(job),
    hasLockDetail: !!getLockDetailImage(job),
    hasEdgeTrimDetail: getReferenceImages(job).some((item) => item && item.slotId === 'edge-trim-detail'),
    hasColorSample: getReferenceImages(job).some((item) => item && item.slotId === 'color-sample'),
    hasBackgroundReference: getReferenceImages(job).some((item) => item && item.slotId === 'background-reference'),
    referenceSlots: getReferenceImages(job).map((item) => item && item.slotId).filter(Boolean),
    inputImageOrder: getReferenceImages(job).some((item) => item && item.slotId === 'background-reference')
      ? ['background-reference', 'full-door'].concat(getReferenceImages(job)
        .map((item) => item && item.slotId)
        .filter((slotId) => slotId && slotId !== 'background-reference' && slotId !== 'full-door'))
      : getReferenceImages(job).map((item) => item && item.slotId).filter(Boolean),
    referenceImageCount: getReferenceImages(job).length,
    referenceOptions: getReferenceImages(job).map((item) => ({
      slotId: item && item.slotId,
      colorMode: item && item.colorMode,
      textureMode: item && item.textureMode
    })).filter((item) => item.slotId),
    sceneId: job.sceneId || '',
    taskType: normalizeTaskType(job),
    promptDecision: getPromptDecisionSummary(job),
    hasMask: !!editArtifacts.maskFile,
    detectionMode: editArtifacts.detectionMode,
    maskBox: editArtifacts.maskBox,
    handleStyle: editArtifacts.handleStyle,
    dimensionBoxes: editArtifacts.dimensionBoxes,
    referenceStyles: editArtifacts.referenceStyles
  });
  let resultBuffer = editArtifacts.directCompositeBuffer || null;
  if (resultBuffer) {
    console.log('[worker] using direct vision placement composite', {
      jobId,
      bytes: resultBuffer.length,
      placement: editArtifacts.directCompositePlacement
    });
    try {
      const repairedBuffer = await blendBottomResiduesWithFloor(resultBuffer, editArtifacts.directCompositePlacement);
      if (repairedBuffer !== resultBuffer) {
        resultBuffer = repairedBuffer;
        console.log('[worker] blended AI-detected bottom residues with floor', {
          jobId,
          bytes: resultBuffer.length
        });
      }
    } catch (error) {
      console.warn('[worker] AI-detected bottom residue blend failed', {
        jobId,
        message: error && error.message ? error.message : error
      });
    }
  } else {
    try {
      const response = await requestEditedImage(jobId, editArtifacts.inputImages, prompt, {
        mask: editArtifacts.maskFile
      });
      console.log('[worker] received openai response', jobId);
      resultBuffer = await readImageResponseBody(response);
      console.log('[worker] parsed result buffer', jobId, resultBuffer.length);
    } catch (error) {
      resultBuffer = await buildDirectHandleCompositeFallback(job, editArtifacts, error);
      if (!resultBuffer) {
        throw error;
      }
    }
  }
  const resultImageFileID = await uploadResult(jobId, job.version || 1, resultBuffer);
  console.log('[worker] uploaded result image', jobId, resultImageFileID);
  const time = Date.now();
  const nextVersions = (job.versions || []).concat({
    resultImageFileID,
    text: job.requirement || '生成结果',
    time,
    imageUrl: ''
  });

  await updateJob(jobId, {
    status: 'success',
    provider: 'openai-worker',
    providerStatus: 'success',
    resultImageFileID,
    errorMessage: '',
    updatedAt: time,
    versions: nextVersions
  });
  console.log('[worker] completed job', jobId);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(body));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? JSON.parse(text) : {});
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      success: true,
      configured: isConfigured,
      missingEnvKeys,
      featureFlags: {
        useNewDimensionPipeline: USE_NEW_DIMENSION_PIPELINE
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/dimension-annotation/options')) {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const doorType = normalizeDimensionDoorType(requestUrl.searchParams.get('doorType') || '');
    sendJson(res, 200, {
      success: true,
      unit: 'mm',
      inputMode: 'number',
      doorTypes: DIMENSION_DOOR_TYPES,
      viewSides: [
        { value: 'front', label: '正面图' },
        { value: 'back', label: '背面图' }
      ],
      doorType,
      fields: getDimensionFieldOptions(doorType, requestUrl.searchParams.get('viewSide') || '').map((field) => ({
        key: field.key,
        label: field.label,
        annotationLabel: field.annotationLabel,
        unit: field.unit,
        placeholder: '只填数字'
      }))
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/jobs/process') {
    try {
      if (!isConfigured) {
        sendJson(res, 500, {
          success: false,
          errorMessage: `缺少环境变量：${missingEnvKeys.join(', ')}`
        });
        return;
      }

      const body = await readRequestBody(req);
      if (!verifySignature(body)) {
        sendJson(res, 401, { success: false, errorMessage: '签名无效' });
        return;
      }

      sendJson(res, 200, { success: true, accepted: true });

      processJob(body.jobId).catch(async (error) => {
        console.error('[worker] processJob failed:', body.jobId, error);
        try {
          const providerErrorMessage = getProviderErrorMessage(error);
          await updateJob(body.jobId, {
            status: 'failed',
            provider: 'openai-worker',
            providerStatus: 'failed',
            errorCode: getWorkerErrorCode(error),
            errorMessage: getPublicWorkerErrorMessage(error),
            providerErrorMessage,
            needsManualReview: /编辑区域|门把手/.test(providerErrorMessage),
            updatedAt: Date.now()
          });
        } catch (updateError) {
          console.error('update job failed:', updateError);
        }
      });
      return;
    } catch (error) {
      sendJson(res, 500, {
        success: false,
        errorMessage: error && error.message ? error.message : '请求处理失败'
      });
      return;
    }
  }

  sendJson(res, 404, { success: false, errorMessage: '未找到接口' });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`menye-ai-worker listening on ${PORT}`);
    if (!isConfigured) {
      console.warn(`missing env keys: ${missingEnvKeys.join(', ')}`);
    }
  });
}

module.exports = {
  buildDoorImageInstruction,
  getPromptDecisionSummary,
  normalizeTaskType
};
