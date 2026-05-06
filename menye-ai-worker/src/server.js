const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const cloudbase = require('@cloudbase/node-sdk');
const openaiModule = require('openai');

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const SECRET_ID = process.env.CLOUDBASE_SECRET_ID;
const SECRET_KEY = process.env.CLOUDBASE_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || '';
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

function assertConfigured() {
  if (!isConfigured) {
    throw new Error(`缺少环境变量：${missingEnvKeys.join(', ')}`);
  }
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
  return Array.isArray(job.referenceImages) ? job.referenceImages.filter((item) => item && item.originalImageFileID) : [];
}

function getPrimaryReferenceImage(job) {
  const referenceImages = getReferenceImages(job);
  return referenceImages.find((item) => item.slotId === 'full-door') || referenceImages[0] || null;
}

function getHandleDetailImage(job) {
  const referenceImages = getReferenceImages(job);
  return referenceImages.find((item) => item.slotId === 'handle-detail') || null;
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
  const response = await openai.responses.create({
    model: OPENAI_VISION_MODEL,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '请识别第二张门把手细节图中的门把手外观特征，只返回 JSON。',
              'JSON 格式必须为：{"color":"...","material":"...","finish":"...","shape":"...","base":"...","details":"..."}。',
              '其中 color 表示可见主颜色，material 表示材质，finish 表示表面工艺或质感，shape 表示主体造型，base 表示把手底座/面板特征，details 表示纹路、转角、装饰、镂空、线条等关键细节。',
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
    ]
  });
  const parsed = extractJsonObject(response.output_text || '');
  if (!parsed) {
    return null;
  }
  return {
    color: parsed.color || '',
    material: parsed.material || '',
    finish: parsed.finish || '',
    shape: parsed.shape || '',
    base: parsed.base || '',
    details: parsed.details || ''
  };
}

async function detectHandleMaskBox(primaryBuffer, primaryFileID, handleBuffer, handleFileID, size, job) {
  if (!primaryBuffer || !handleBuffer || !size) {
    return null;
  }
  const response = await openai.responses.create({
    model: OPENAI_VISION_MODEL,
    input: [
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
    ]
  });
  const text = response.output_text || '';
  const parsed = extractJsonObject(text);
  return normalizeMaskBox(parsed, size, 'vision-detected');
}

function buildDoorImageInstruction(job, maskBox, handleStyle) {
  const targetParts = Array.isArray(job.targetParts)
    ? job.targetParts.map((item) => (item === 'handle' ? '门把手' : item)).filter(Boolean)
    : [];
  const targetPartText = targetParts.length ? targetParts.join('、') : '门体';
  const referenceImages = getReferenceImages(job);
  const imageLines = referenceImages.map((item, index) => {
    const label = item.slotId === 'full-door'
      ? '整门上下文图'
      : item.slotId === 'handle-detail'
        ? '门把手细节图'
        : (item.slotId || `参考图${index + 1}`);
    return `参考图${index + 1}：${label}`;
  });
  const hasHandleDetail = referenceImages.some((item) => item.slotId === 'handle-detail');
  const onlyFullDoor = referenceImages.length > 0 && !hasHandleDetail;
  const maskInstruction = maskBox
    ? `系统检测到门把手编辑区域：left=${maskBox.left}, top=${maskBox.top}, right=${maskBox.right}, bottom=${maskBox.bottom}。本次只允许在该区域及极小衔接边缘内编辑。`
    : '本次未启用区域 mask，请尽量仅围绕门把手及必要衔接区域做处理。';
  const handleStyleInstruction = handleStyle && (handleStyle.color || handleStyle.material || handleStyle.finish || handleStyle.shape || handleStyle.base || handleStyle.details)
    ? `系统识别到门把手细节特征：颜色=${handleStyle.color || '未识别'}；材质=${handleStyle.material || '未识别'}；表面质感=${handleStyle.finish || '未识别'}；主体造型=${handleStyle.shape || '未识别'}；底座/面板=${handleStyle.base || '未识别'}；关键细节=${handleStyle.details || '未识别'}。最终成图中的门把手必须优先保持这些特征，尤其要以细节图中的颜色、主体造型、底座结构、边角转折和装饰细节为准，不要因为环境光或门体配色自动改成其他颜色，也不要把细节简化成相似但不同的款式。`
    : '门把手颜色、材质、主体造型、底座结构和关键细节都必须以门把手细节图为准，不要自动偏色，也不要简化细节。';
  const modifyScopeInstruction = job && job.actionType === 'modify'
    ? [
        '高优先级指令：本次任务是继续修改，只允许执行用户这一次明确提出的修改要求。',
        '最高原则：宁可少改，也不可多改；宁可保留原状，也不要擅自新增变化。',
        '除非用户这次明确要求改变门把手样式、颜色、材质、底座、轮廓或结构，否则这些内容都必须保持与当前输入图一致，不得擅自修改。',
        '除用户点名要改的局部外，其他门体、门框、玻璃、墙面、背景、光影关系和已有把手样式都不要动。',
        '如果用户只要求删除、弱化或调整某个局部，就只处理该局部，不要顺带优化、重绘、替换、美化或修正其他部分。',
        '当用户要求与把手有关的局部调整时，默认先保留现有把手款式、颜色、材质和结构，只修改被明确点名的那一部分。',
        '如果对用户意图存在歧义，默认选择修改更少、保留更多原始内容的方案。'
      ].join('\n')
    : [
        '高优先级指令：本次只允许围绕用户明确要求的目标部件和修改目标出图，不要主动扩大发挥范围。',
        '最高原则：宁可少改，也不可多改；宁可局部不完美，也不要擅自改变未被点名的内容。',
        '如果用户没有明确要求改变某个部分，就不要擅自修改该部分的样式、颜色、材质、结构、纹理或细节。',
        '除目标部件及其必要衔接区域外，其他门体、门框、玻璃、墙面、背景和光影关系都应尽量保持原样。',
        '不要为了追求整体效果而主动重绘、替换、美化、优化、补全或修正未被点名的内容。',
        '如果某种改动会导致目标部件以外的区域发生明显变化，则应优先缩小改动范围，而不是扩大改动。',
        '如果无法同时满足所有要求，应优先保证未被点名区域保持不变，其次再完成目标部件修改。'
      ].join('\n');

  return [
    '请在保留原始拍摄角度和整体构图的前提下处理这组门业参考图片。',
    `用途：${job.templateType || '门业展示'}`,
    `门类型：${job.doorType || '未指定'}`,
    `目标部件：${targetPartText}`,
    `风格：${job.style || '未指定'}`,
    `补充要求：${job.requirement || '按当前图片处理'}`,
    imageLines.length ? imageLines.join('\n') : '参考图：未提供多图标记',
    maskInstruction,
    handleStyleInstruction,
    modifyScopeInstruction,
    onlyFullDoor
      ? '当前没有门把手细节照，请先在整门图中识别门把手区域，仅围绕门把手及必要衔接区域做处理，不要改变原门的材质、颜色、纹理、漆面和整体结构。'
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
  const detail = await collection.doc(jobId).get();
  const data = detail && detail.data;
  if (Array.isArray(data)) {
    return data[0] || null;
  }
  return data || null;
}

async function updateJob(jobId, data) {
  await collection.doc(jobId).update(data);
}

async function downloadOriginalImage(fileID) {
  const result = await app.downloadFile({
    fileID
  });
  return result.fileContent;
}

async function uploadResult(jobId, version, buffer) {
  const cloudPath = getResultCloudPath(jobId, version, 'png');
  const result = await app.uploadFile({
    cloudPath,
    fileContent: buffer
  });
  return result.fileID;
}

async function createInputImage(fileID, sourceBuffer, fallbackName) {
  const extension = getFileExtensionFromPath(fileID, 'png');
  return toFile(sourceBuffer, fallbackName || `door-source.${extension}`, {
    type: getMimeType(extension)
  });
}

async function createMaskFile(maskBuffer) {
  return toFile(maskBuffer, 'handle-mask.png', {
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
      detectionMode: 'single-image-fallback'
    };
  }

  const primaryBuffer = await downloadOriginalImage(primaryImage.originalImageFileID);
  const inputImages = [await createInputImage(primaryImage.originalImageFileID, primaryBuffer, `${primaryImage.slotId || 'full-door'}.png`)];
  const handleDetail = getHandleDetailImage(job);
  let handleBuffer = null;
  if (handleDetail) {
    handleBuffer = await downloadOriginalImage(handleDetail.originalImageFileID);
    inputImages.push(await createInputImage(handleDetail.originalImageFileID, handleBuffer, `${handleDetail.slotId || 'handle-detail'}.png`));
  }

  const primarySize = getImageSize(primaryBuffer, primaryImage.originalImageFileID);
  if (!primarySize || !primarySize.width || !primarySize.height) {
    throw new Error('无法识别整门照尺寸，暂时不能生成门把手编辑区域');
  }
  let maskBox = null;
  let maskFile = null;
  let detectionMode = 'none';
  let handleStyle = null;
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

  console.log('[worker] downloaded edit artifacts', job._id || job.jobId, {
    inputImageCount: inputImages.length,
    hasHandleDetail: !!handleDetail,
    primarySize,
    detectionMode,
    maskBox,
    handleStyle
  });

  return {
    inputImages,
    maskFile,
    maskBox,
    detectionMode,
    handleStyle
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
  return !!(error && error.status === 502 && error.type === 'upstream_error');
}

async function requestEditedImage(jobId, inputImages, prompt, options) {
  const requestOptions = options || {};
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      console.log('[worker] calling image api', {
        jobId,
        attempt,
        imageCount: inputImages.length,
        hasMask: !!requestOptions.mask,
        baseURL: getSanitizedBaseUrl(OPENAI_BASE_URL),
        model: OPENAI_IMAGE_MODEL,
        visionModel: OPENAI_VISION_MODEL
      });
      return await openai.images.edit({
        model: OPENAI_IMAGE_MODEL,
        image: inputImages,
        ...(requestOptions.mask ? { mask: requestOptions.mask } : {}),
        prompt,
        size: '1024x1024'
      });
    } catch (error) {
      if (attempt === 1 && shouldRetryImageApi(error)) {
        console.warn('[worker] retrying image api after upstream 502', {
          jobId,
          requestID: error.requestID || '',
          message: error.message
        });
        continue;
      }
      throw error;
    }
  }
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
    detectionMode: editArtifacts.detectionMode
  });
  const prompt = buildDoorImageInstruction(job, editArtifacts.maskBox, editArtifacts.handleStyle);
  console.log('[worker] built prompt', {
    jobId,
    hasHandleDetail: !!getHandleDetailImage(job),
    referenceImageCount: getReferenceImages(job).length,
    hasMask: !!editArtifacts.maskFile,
    detectionMode: editArtifacts.detectionMode,
    maskBox: editArtifacts.maskBox,
    handleStyle: editArtifacts.handleStyle
  });
  const response = await requestEditedImage(jobId, editArtifacts.inputImages, prompt, {
    mask: editArtifacts.maskFile
  });
  console.log('[worker] received openai response', jobId);

  const resultBuffer = await readImageResponseBody(response);
  console.log('[worker] parsed result buffer', jobId, resultBuffer.length);
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
      missingEnvKeys
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
          await updateJob(body.jobId, {
            status: 'failed',
            provider: 'openai-worker',
            providerStatus: 'failed',
            errorMessage: error && error.message ? error.message : '处理失败，请稍后再试',
            needsManualReview: /编辑区域|门把手/.test(error && error.message ? error.message : ''),
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

server.listen(PORT, () => {
  console.log(`menye-ai-worker listening on ${PORT}`);
  if (!isConfigured) {
    console.warn(`missing env keys: ${missingEnvKeys.join(', ')}`);
  }
});
