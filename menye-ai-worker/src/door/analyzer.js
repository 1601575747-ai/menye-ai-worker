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

let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  sharp = null;
}

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
  return sorted[clamp(Math.floor(sorted.length * ratio), 0, sorted.length - 1)];
}

function weightedQuantile(weights, ratio) {
  const total = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) {
    return 0;
  }
  const target = total * ratio;
  let current = 0;
  for (let index = 0; index < weights.length; index += 1) {
    current += Math.max(0, weights[index]);
    if (current >= target) {
      return index;
    }
  }
  return weights.length - 1;
}

function smoothValues(values, radius) {
  const result = new Array(values.length).fill(0);
  for (let index = 0; index < values.length; index += 1) {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const next = index + offset;
      if (next >= 0 && next < values.length) {
        sum += values[next];
        count += 1;
      }
    }
    result[index] = count ? sum / count : values[index];
  }
  return result;
}

function getPixel(raw, width, x, y) {
  const index = (y * width + x) * 3;
  return [raw[index], raw[index + 1], raw[index + 2]];
}

function colorDistance(pixel, background) {
  const dr = pixel[0] - background[0];
  const dg = pixel[1] - background[1];
  const db = pixel[2] - background[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function estimateBorderBackground(raw, width, height) {
  const margin = Math.max(2, Math.floor(Math.min(width, height) * 0.035));
  const step = Math.max(1, Math.floor(Math.min(width, height) / 180));
  const r = [];
  const g = [];
  const b = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const nearBorder = x < margin || x >= width - margin || y < margin || y >= height - margin;
      if (!nearBorder) {
        continue;
      }
      const pixel = getPixel(raw, width, x, y);
      r.push(pixel[0]);
      g.push(pixel[1]);
      b.push(pixel[2]);
    }
  }
  return [median(r), median(g), median(b)];
}

function buildPixelFeatures(raw, width, height) {
  const background = estimateBorderBackground(raw, width, height);
  const gray = new Float32Array(width * height);
  const foreground = new Uint8Array(width * height);
  const verticalEdge = new Float32Array(width * height);
  const horizontalEdge = new Float32Array(width * height);
  const rowCounts = new Int32Array(height);
  let borderSamples = 0;
  let closeBorderSamples = 0;
  const borderMargin = Math.max(2, Math.floor(Math.min(width, height) * 0.035));
  const foregroundBounds = {
    left: width,
    top: height,
    right: 0,
    bottom: 0,
    count: 0
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const pixel = getPixel(raw, width, x, y);
      const max = Math.max(pixel[0], pixel[1], pixel[2]);
      const min = Math.min(pixel[0], pixel[1], pixel[2]);
      const saturation = max - min;
      const luminance = 0.299 * pixel[0] + 0.587 * pixel[1] + 0.114 * pixel[2];
      const distance = colorDistance(pixel, background);
      gray[index] = luminance;
      if (x < borderMargin || x >= width - borderMargin || y < borderMargin || y >= height - borderMargin) {
        borderSamples += 1;
        if (distance < 34) {
          closeBorderSamples += 1;
        }
      }

      const strongForeground = distance > 36 || (saturation > 26 && luminance < 235);
      const likelySoftShadow = distance < 54 && saturation < 18 && luminance > 138;
      if (strongForeground && !likelySoftShadow) {
        foreground[index] = 1;
        rowCounts[y] += 1;
        foregroundBounds.left = Math.min(foregroundBounds.left, x);
        foregroundBounds.top = Math.min(foregroundBounds.top, y);
        foregroundBounds.right = Math.max(foregroundBounds.right, x);
        foregroundBounds.bottom = Math.max(foregroundBounds.bottom, y);
        foregroundBounds.count += 1;
      }
    }
  }

  for (let y = 1; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) {
      const index = y * width + x;
      verticalEdge[index] = Math.abs(gray[index] - gray[y * width + x - 1]);
      horizontalEdge[index] = Math.abs(gray[index] - gray[(y - 1) * width + x]);
    }
  }

  const backgroundBrightness = 0.299 * background[0] + 0.587 * background[1] + 0.114 * background[2];
  const plainBackground = borderSamples > 0 &&
    closeBorderSamples / borderSamples > 0.82 &&
    backgroundBrightness > 175 &&
    foregroundBounds.count > width * height * 0.05;

  return {
    background,
    plainBackground,
    foregroundBounds,
    gray,
    foreground,
    verticalEdge,
    horizontalEdge,
    rowCounts
  };
}

function buildColumnScores(features, width, height) {
  const scores = new Array(width).fill(0);
  const center = width / 2;
  for (let x = 0; x < width; x += 1) {
    let score = 0;
    for (let y = Math.floor(height * 0.03); y < Math.floor(height * 0.98); y += 1) {
      const rowIsWideBackground = features.rowCounts[y] > width * 0.78;
      if (rowIsWideBackground && y > height * 0.22) {
        continue;
      }
      const index = y * width + x;
      if (features.foreground[index]) {
        score += 1;
      }
      if (features.verticalEdge[index] > 16) {
        score += 1.8;
      }
    }
    const centrality = 0.35 + 0.65 * (1 - Math.min(1, Math.abs(x - center) / center));
    scores[x] = score * centrality;
  }
  return smoothValues(scores, Math.max(2, Math.floor(width * 0.012)));
}

function findHorizontalBounds(features, width, height) {
  if (features.plainBackground && features.foregroundBounds && features.foregroundBounds.count) {
    const bounds = features.foregroundBounds;
    const padding = Math.max(3, Math.floor((bounds.right - bounds.left) * 0.015));
    return {
      left: clamp(bounds.left - padding, 0, width - 2),
      right: clamp(bounds.right + padding, 1, width - 1),
      confidence: 'high'
    };
  }
  const scores = buildColumnScores(features, width, height);
  const threshold = Math.max(percentile(scores, 0.58), height * 0.018);
  const filtered = scores.map((score) => (score >= threshold ? score : 0));
  let left = weightedQuantile(filtered, 0.025);
  let right = weightedQuantile(filtered, 0.975);
  if (right - left < width * 0.18) {
    left = Math.floor(width * 0.18);
    right = Math.ceil(width * 0.82);
  }
  const padding = Math.max(4, Math.floor((right - left) * 0.035));
  return {
    left: clamp(left - padding, 0, width - 2),
    right: clamp(right + padding, 1, width - 1),
    confidence: right - left > width * 0.22 ? 'medium' : 'low'
  };
}

function scoreRows(features, width, height, left, right) {
  const rowScores = new Array(height).fill(0);
  const horizontalScores = new Array(height).fill(0);
  const safeLeft = clamp(left, 0, width - 1);
  const safeRight = clamp(right, safeLeft + 1, width);
  const span = Math.max(1, safeRight - safeLeft);
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    let edge = 0;
    for (let x = safeLeft; x < safeRight; x += 1) {
      const index = y * width + x;
      if (features.foreground[index]) {
        count += 1;
      }
      if (features.horizontalEdge[index] > 16) {
        edge += 1;
      }
    }
    rowScores[y] = count / span;
    horizontalScores[y] = edge / span;
  }
  return {
    rowScores: smoothValues(rowScores, Math.max(2, Math.floor(height * 0.006))),
    horizontalScores: smoothValues(horizontalScores, Math.max(2, Math.floor(height * 0.004)))
  };
}

function firstSupportedRow(scores, threshold, start, end) {
  for (let y = start; y <= end; y += 1) {
    let hits = 0;
    for (let offset = 0; offset < 8 && y + offset <= end; offset += 1) {
      if (scores[y + offset] >= threshold) {
        hits += 1;
      }
    }
    if (hits >= 3) {
      return y;
    }
  }
  return start;
}

function strongestLowerHorizontalEdge(horizontalScores, height) {
  const start = Math.floor(height * 0.58);
  const end = Math.floor(height * 0.985);
  let bestY = -1;
  let bestScore = 0;
  for (let y = start; y <= end; y += 1) {
    const lowerBias = 0.65 + 0.35 * ((y - start) / Math.max(1, end - start));
    const score = horizontalScores[y] * lowerBias;
    if (score > bestScore) {
      bestScore = score;
      bestY = y;
    }
  }
  return bestScore > 0.035 ? bestY : -1;
}

function findVerticalBounds(features, width, height, left, right) {
  if (features.plainBackground && features.foregroundBounds && features.foregroundBounds.count) {
    const bounds = features.foregroundBounds;
    const padding = Math.max(2, Math.floor((bounds.bottom - bounds.top) * 0.006));
    return {
      top: clamp(bounds.top - padding, 0, height - 2),
      bottom: clamp(bounds.bottom + padding, bounds.top + 1, height - 1),
      confidence: 'high'
    };
  }
  const { rowScores, horizontalScores } = scoreRows(features, width, height, left, right);
  const rowThreshold = Math.max(percentile(rowScores, 0.56), 0.045);
  const top = firstSupportedRow(rowScores, rowThreshold, 0, Math.floor(height * 0.45));
  const edgeBottom = strongestLowerHorizontalEdge(horizontalScores, height);
  let bottom = edgeBottom;
  if (bottom < 0) {
    for (let y = height - 1; y >= Math.floor(height * 0.45); y -= 1) {
      if (rowScores[y] >= rowThreshold) {
        bottom = y;
        break;
      }
    }
  }
  if (bottom <= top || bottom < height * 0.62) {
    bottom = Math.floor(height * 0.94);
  }
  return {
    top: clamp(top, 0, height - 2),
    bottom: clamp(bottom, top + 1, height - 1),
    confidence: bottom - top > height * 0.45 ? 'medium' : 'low'
  };
}

function scaleBox(box, scaleX, scaleY, maxWidth, maxHeight) {
  return normalizeBox({
    left: clamp(Math.round(box.left * scaleX), 0, maxWidth - 1),
    top: clamp(Math.round(box.top * scaleY), 0, maxHeight - 1),
    right: clamp(Math.round(box.right * scaleX), 1, maxWidth),
    bottom: clamp(Math.round(box.bottom * scaleY), 1, maxHeight)
  });
}

function insetBox(box, insetX, insetTop, insetBottom) {
  return normalizeBox({
    left: box.left + insetX,
    top: box.top + insetTop,
    right: box.right - insetX,
    bottom: box.bottom - insetBottom
  });
}

function makeHeuristicBoxes(outerTrim, imageSize) {
  const width = outerTrim.right - outerTrim.left;
  const height = outerTrim.bottom - outerTrim.top;
  const openingInsetX = Math.max(8, Math.round(width * 0.055));
  const visibleInsetX = Math.max(14, Math.round(width * 0.11));
  const openingTopInset = Math.max(10, Math.round(height * 0.075));
  const visibleTopInset = Math.max(16, Math.round(height * 0.12));
  const lowerInset = Math.max(2, Math.round(height * 0.012));
  const opening = insetBox(outerTrim, openingInsetX, openingTopInset, lowerInset);
  const visibleOpening = insetBox(outerTrim, visibleInsetX, visibleTopInset, lowerInset);
  const leafInsetX = Math.max(18, Math.round(width * 0.14));
  const doorLeaf = insetBox(outerTrim, leafInsetX, Math.max(20, Math.round(height * 0.16)), lowerInset);
  const topBandHeight = Math.max(20, Math.round(height * 0.18));

  return {
    outerTrim,
    opening,
    visibleOpening,
    doorLeaf,
    handle: normalizeBox({
      left: outerTrim.left + width * 0.43,
      top: outerTrim.top + height * 0.48,
      right: outerTrim.left + width * 0.57,
      bottom: outerTrim.top + height * 0.62
    }),
    lock: null,
    transom: normalizeBox({
      left: opening.left,
      top: outerTrim.top,
      right: opening.right,
      bottom: Math.min(outerTrim.bottom, outerTrim.top + topBandHeight)
    }),
    header: normalizeBox({
      left: Math.max(0, outerTrim.left - Math.round(width * 0.035)),
      top: Math.max(0, outerTrim.top - Math.round(height * 0.035)),
      right: Math.min(imageSize.width, outerTrim.right + Math.round(width * 0.035)),
      bottom: outerTrim.bottom
    }),
    shadowRegions: []
  };
}

async function heuristicAnalyzer({ image, imageSize, doorType, viewSide } = {}) {
  if (!sharp || !image) {
    return mockAnalyzer({ doorType, viewSide });
  }

  try {
    const metadata = await sharp(image).metadata();
    const sourceSize = {
      width: Number(imageSize && imageSize.width) || metadata.width,
      height: Number(imageSize && imageSize.height) || metadata.height
    };
    if (!sourceSize.width || !sourceSize.height) {
      return mockAnalyzer({ doorType, viewSide });
    }
    const maxAnalysisWidth = 520;
    const scale = Math.min(1, maxAnalysisWidth / sourceSize.width);
    const analysisSize = {
      width: Math.max(80, Math.round(sourceSize.width * scale)),
      height: Math.max(80, Math.round(sourceSize.height * scale))
    };
    const raw = await sharp(image)
      .resize(analysisSize.width, analysisSize.height, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer();
    const features = buildPixelFeatures(raw, analysisSize.width, analysisSize.height);
    const horizontal = findHorizontalBounds(features, analysisSize.width, analysisSize.height);
    const vertical = findVerticalBounds(features, analysisSize.width, analysisSize.height, horizontal.left, horizontal.right);
    const outerTrim = scaleBox({
      left: horizontal.left,
      top: vertical.top,
      right: horizontal.right,
      bottom: vertical.bottom
    }, sourceSize.width / analysisSize.width, sourceSize.height / analysisSize.height, sourceSize.width, sourceSize.height);
    const boxes = makeHeuristicBoxes(outerTrim, sourceSize);

    return normalizeDoorStructure({
      doorType,
      viewSide,
      boxes,
      keypoints: {
        doorBottomY: outerTrim.bottom
      },
      modes: {
        heightBottomMode: 'shared'
      },
      confidence: {
        overall: horizontal.confidence === 'low' || vertical.confidence === 'low' ? 'low' : 'medium',
        outerTrim: horizontal.confidence === 'low' || vertical.confidence === 'low' ? 'low' : 'medium',
        opening: 'heuristic',
        visibleOpening: 'heuristic',
        doorLeaf: 'heuristic'
      },
      needsUserAdjustment: horizontal.confidence === 'low' || vertical.confidence === 'low',
      notes: 'heuristic door structure from image pixels; excludes soft shadow-like regions by color distance and edge support'
    }, { doorType, viewSide });
  } catch (error) {
    return normalizeDoorStructure({
      doorType,
      viewSide,
      boxes: {},
      keypoints: { doorBottomY: null },
      needsUserAdjustment: true,
      confidence: { overall: 'low' },
      notes: error && error.message ? error.message : 'Heuristic door analyzer failed'
    }, { doorType, viewSide });
  }
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
  if (mode === 'mock') {
    return mockAnalyzer({
      imageUrl,
      doorType,
      viewSide,
      taskType: normalizedTaskType
    });
  }
  if (arguments[0] && arguments[0].image) {
    return heuristicAnalyzer({
      image: arguments[0].image,
      imageSize: arguments[0].imageSize,
      doorType,
      viewSide,
      taskType: normalizedTaskType
    });
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
  heuristicAnalyzer,
  openAIDoorAnalyzer,
  normalizeDoorStructure
};
