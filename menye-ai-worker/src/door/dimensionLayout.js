'use strict';

const { DimensionField } = require('./schema');

const HORIZONTAL_FIELD_ORDER = Object.freeze([
  DimensionField.HEADER_WIDTH,
  DimensionField.WITH_EDGE_TRIM_WIDTH,
  DimensionField.OPENING_WIDTH,
  DimensionField.VISIBLE_OPENING_WIDTH
]);

const VERTICAL_FIELD_ORDER = Object.freeze([
  DimensionField.HEADER_HEIGHT,
  DimensionField.TRANSOM_HEIGHT,
  DimensionField.WITH_EDGE_TRIM_HEIGHT,
  DimensionField.OPENING_HEIGHT,
  DimensionField.VISIBLE_OPENING_HEIGHT
]);

const DEFAULT_IMAGE_SIZE = Object.freeze({
  width: 1024,
  height: 1024
});

const LINE_SPACING = 54;
const FIRST_LINE_OFFSET = 52;

function getImageSize(imageSize) {
  return {
    width: Number(imageSize && imageSize.width) || DEFAULT_IMAGE_SIZE.width,
    height: Number(imageSize && imageSize.height) || DEFAULT_IMAGE_SIZE.height
  };
}

function getPointValue(boundary, side) {
  return boundary && boundary[side] && typeof boundary[side].value === 'number'
    ? boundary[side].value
    : null;
}

function hasNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function getBoxForRule(rule, doorStructure) {
  const boundaryBox = rule && rule.sourceBoundary && rule.sourceBoundary.boxRect;
  if (boundaryBox) {
    return boundaryBox;
  }
  const boxKey = rule && rule.sourceBoundary && rule.sourceBoundary.box;
  return boxKey && doorStructure && doorStructure.boxes ? doorStructure.boxes[boxKey] : null;
}

function getRuleText(rule) {
  return `${rule.value}${rule.unit || 'mm'}`;
}

function getTextWithLabel(rule) {
  return `${rule.label}：${getRuleText(rule)}`;
}

function getHorizontalRank(field, fallbackIndex) {
  const rank = HORIZONTAL_FIELD_ORDER.indexOf(field);
  return rank >= 0 ? rank : HORIZONTAL_FIELD_ORDER.length + fallbackIndex;
}

function getVerticalRank(field, fallbackIndex) {
  const rank = VERTICAL_FIELD_ORDER.indexOf(field);
  return rank >= 0 ? rank : VERTICAL_FIELD_ORDER.length + fallbackIndex;
}

function getOrderedSlotMap(rules, orientation) {
  const order = orientation === 'horizontal' ? HORIZONTAL_FIELD_ORDER : VERTICAL_FIELD_ORDER;
  const seen = new Set();
  const fields = [];
  for (const rule of rules) {
    if (!rule || rule.orientation !== orientation || seen.has(rule.field)) {
      continue;
    }
    seen.add(rule.field);
    fields.push(rule.field);
  }
  fields.sort((a, b) => {
    const rankA = orientation === 'horizontal'
      ? getHorizontalRank(a, fields.length)
      : getVerticalRank(a, fields.length);
    const rankB = orientation === 'horizontal'
      ? getHorizontalRank(b, fields.length)
      : getVerticalRank(b, fields.length);
    return rankA - rankB || order.indexOf(a) - order.indexOf(b);
  });
  return Object.freeze({
    count: fields.length,
    indexByField: Object.freeze(fields.reduce((acc, field, index) => {
      acc[field] = index;
      return acc;
    }, {}))
  });
}

function makeArrow(lineId, field, point, direction, index) {
  return Object.freeze({
    id: `${lineId}-arrow-${index}`,
    lineId,
    field,
    position: Object.freeze(point),
    direction
  });
}

function makeExtensionLine(lineId, field, from, to, index) {
  return Object.freeze({
    id: `${lineId}-extension-${index}`,
    lineId,
    field,
    from: Object.freeze(from),
    to: Object.freeze(to)
  });
}

function getHorizontalBaseTop(rules, doorStructure) {
  const topValues = [];
  for (const rule of rules) {
    if (!rule || rule.orientation !== 'horizontal') {
      continue;
    }
    const box = getBoxForRule(rule, doorStructure);
    if (box && hasNumber(box.top)) {
      topValues.push(box.top);
    }
  }
  const outerTrim = doorStructure && doorStructure.boxes ? doorStructure.boxes.outerTrim : null;
  if (outerTrim && hasNumber(outerTrim.top)) {
    topValues.push(outerTrim.top);
  }
  return topValues.length > 0 ? Math.min(...topValues) : 0;
}

function expandBounds(bounds, box) {
  if (!box) {
    return bounds;
  }
  const values = [box.left, box.top, box.right, box.bottom];
  if (!values.every(hasNumber)) {
    return bounds;
  }
  if (!bounds) {
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom
    };
  }
  return {
    left: Math.min(bounds.left, box.left),
    top: Math.min(bounds.top, box.top),
    right: Math.max(bounds.right, box.right),
    bottom: Math.max(bounds.bottom, box.bottom)
  };
}

function getDoorContentBox(doorStructure, imageSize) {
  const boxes = doorStructure && doorStructure.boxes ? doorStructure.boxes : {};
  let bounds = null;
  for (const key of ['header', 'outerTrim', 'transom', 'opening', 'visibleOpening', 'doorLeaf']) {
    bounds = expandBounds(bounds, boxes[key]);
  }
  const doorBottomY = doorStructure && doorStructure.keypoints && doorStructure.keypoints.doorBottomY;
  if (bounds && hasNumber(doorBottomY)) {
    bounds.bottom = Math.max(bounds.bottom, doorBottomY);
  }
  if (!bounds) {
    return null;
  }
  const margin = 18;
  return Object.freeze({
    left: Math.max(0, bounds.left - margin),
    top: 0,
    right: Math.min(imageSize.width, bounds.right + margin),
    bottom: imageSize.height
  });
}

function makeLineRule(rule, index, doorStructure, imageSize, slotInfo) {
  const sourceBoundary = rule.sourceBoundary || {};
  const fromValue = getPointValue(sourceBoundary, 'from');
  const toValue = getPointValue(sourceBoundary, 'to');
  if (fromValue === null || toValue === null) {
    return null;
  }

  const id = `line-${rule.field}-${index}`;
  const textId = `text-${rule.field}-${index}`;
  const arrowIds = [`${id}-arrow-0`, `${id}-arrow-1`];
  const sourceBox = getBoxForRule(rule, doorStructure) || {};
  const slotIndex = Number(slotInfo && slotInfo.index) || 0;
  const slotCount = Math.max(1, Number(slotInfo && slotInfo.count) || 1);
  const distanceIndex = Math.max(1, slotCount - slotIndex);

  if (rule.orientation === 'horizontal') {
    const baseTop = hasNumber(slotInfo && slotInfo.horizontalBaseTop)
      ? slotInfo.horizontalBaseTop
      : hasNumber(sourceBox.top) ? sourceBox.top : 0;
    const y = baseTop - FIRST_LINE_OFFSET - (distanceIndex - 1) * LINE_SPACING;
    const extensionY = hasNumber(sourceBox.top) ? sourceBox.top : baseTop;
    const from = Object.freeze({ x: fromValue, y });
    const to = Object.freeze({ x: toValue, y });
    const textPosition = Object.freeze({
      x: (fromValue + toValue) / 2,
      y: y - 10
    });
    return {
      line: Object.freeze({
        id,
        field: rule.field,
        from,
        to,
        orientation: 'horizontal',
        label: rule.label,
        value: rule.value,
        unit: rule.unit,
        textId,
        arrowIds: Object.freeze(arrowIds)
      }),
      text: Object.freeze({
        id: textId,
        field: rule.field,
        text: getTextWithLabel(rule),
        position: textPosition,
        align: 'center',
        baseline: 'bottom'
      }),
      arrows: Object.freeze([
        makeArrow(id, rule.field, from, 'left', 0),
        makeArrow(id, rule.field, to, 'right', 1)
      ]),
      extensionLines: Object.freeze([
        makeExtensionLine(id, rule.field, { x: fromValue, y: extensionY }, { x: fromValue, y }, 0),
        makeExtensionLine(id, rule.field, { x: toValue, y: extensionY }, { x: toValue, y }, 1)
      ]),
      warning: y < 0 ? `Horizontal dimension ${rule.field} extends above image` : ''
    };
  }

  if (rule.orientation === 'vertical') {
    const doorLeft = doorStructure && doorStructure.boxes && doorStructure.boxes.outerTrim
      ? doorStructure.boxes.outerTrim.left
      : Math.min(fromValue, toValue);
    const x = doorLeft - FIRST_LINE_OFFSET - (distanceIndex - 1) * LINE_SPACING;
    const extensionX = hasNumber(sourceBox.left) ? sourceBox.left : doorLeft;
    const from = Object.freeze({ x, y: fromValue });
    const to = Object.freeze({ x, y: toValue });
    const textPosition = Object.freeze({
      x: x - 12,
      y: (fromValue + toValue) / 2
    });
    return {
      line: Object.freeze({
        id,
        field: rule.field,
        from,
        to,
        orientation: 'vertical',
        label: rule.label,
        value: rule.value,
        unit: rule.unit,
        textId,
        arrowIds: Object.freeze(arrowIds)
      }),
      text: Object.freeze({
        id: textId,
        field: rule.field,
        text: getTextWithLabel(rule),
        position: textPosition,
        align: 'center',
        baseline: 'bottom',
        rotation: -90
      }),
      arrows: Object.freeze([
        makeArrow(id, rule.field, from, 'up', 0),
        makeArrow(id, rule.field, to, 'down', 1)
      ]),
      extensionLines: Object.freeze([
        makeExtensionLine(id, rule.field, { x: extensionX, y: fromValue }, { x, y: fromValue }, 0),
        makeExtensionLine(id, rule.field, { x: extensionX, y: toValue }, { x, y: toValue }, 1)
      ]),
      warning: x < 0 ? `Vertical dimension ${rule.field} extends left of image` : ''
    };
  }

  return null;
}

function getTextOnlyPosition(rule, imageSize, index) {
  return Object.freeze({
    x: imageSize.width + 64,
    y: Math.max(96, imageSize.height - 140 - index * 70)
  });
}

function makeTextOnlyAnnotation(rule, imageSize, index) {
  const text = rule.field === DimensionField.WALL_THICKNESS
    ? `${rule.label}：\n${rule.value}${rule.unit || 'mm'}`
    : getTextWithLabel(rule);
  return Object.freeze({
    field: rule.field,
    text,
    positionKey: rule.constraints && rule.constraints.placement ? rule.constraints.placement : 'bottomRight',
    position: getTextOnlyPosition(rule, imageSize, index)
  });
}

function buildDimensionRenderPlan({ rules, doorStructure, imageSize } = {}) {
  const size = getImageSize(imageSize);
  const sourceRules = Array.isArray(rules) ? rules : [];
  const lines = [];
  const extensionLines = [];
  const texts = [];
  const arrows = [];
  const textOnlyAnnotations = [];
  const warnings = [];
  const usedBoundaries = [];
  let horizontalCount = 0;
  let verticalCount = 0;
  let textOnlyCount = 0;
  const lineRules = sourceRules.filter((rule) => rule && rule.type === 'line');
  const horizontalSlots = getOrderedSlotMap(lineRules, 'horizontal');
  const verticalSlots = getOrderedSlotMap(lineRules, 'vertical');
  const horizontalBaseTop = getHorizontalBaseTop(lineRules, doorStructure);

  for (const rule of sourceRules) {
    if (!rule || !rule.field) {
      continue;
    }
    if (rule.type === 'textOnly') {
      textOnlyAnnotations.push(makeTextOnlyAnnotation(rule, size, textOnlyCount));
      textOnlyCount += 1;
      continue;
    }
    if (rule.type !== 'line') {
      continue;
    }
    const slots = rule.orientation === 'horizontal' ? horizontalSlots : verticalSlots;
    const slotInfo = Object.freeze({
      count: slots.count,
      index: hasNumber(slots.indexByField[rule.field])
        ? slots.indexByField[rule.field]
        : rule.orientation === 'horizontal' ? horizontalCount : verticalCount,
      horizontalBaseTop
    });
    const layout = makeLineRule(rule, lines.length, doorStructure, size, slotInfo);
    if (!layout) {
      warnings.push(`Rule ${rule.field} could not be laid out`);
      continue;
    }
    lines.push(layout.line);
    extensionLines.push(...layout.extensionLines);
    texts.push(layout.text);
    arrows.push(...layout.arrows);
    if (layout.warning) {
      warnings.push(layout.warning);
    }
    if (rule.sourceBoundary && rule.sourceBoundary.box) {
      usedBoundaries.push(Object.freeze({
        field: rule.field,
        box: rule.sourceBoundary.box,
        sourceBoxes: rule.sourceBoundary.sourceBoxes || Object.freeze([rule.sourceBoundary.box]),
        boundaryMode: rule.sourceBoundary.boundaryMode || null,
        orientation: rule.orientation,
        from: rule.sourceBoundary.from,
        to: rule.sourceBoundary.to
      }));
    }
    if (rule.orientation === 'horizontal') {
      horizontalCount += 1;
    } else if (rule.orientation === 'vertical') {
      verticalCount += 1;
    }
  }

  return Object.freeze({
    lines: Object.freeze(lines),
    extensionLines: Object.freeze(extensionLines),
    texts: Object.freeze(texts),
    arrows: Object.freeze(arrows),
    textOnlyAnnotations: Object.freeze(textOnlyAnnotations),
    metadata: Object.freeze({
      imageSize: Object.freeze(size),
      contentBox: getDoorContentBox(doorStructure, size)
    }),
    debug: Object.freeze({
      boundaries: Object.freeze(usedBoundaries),
      shadowRegionsIgnored: !!(doorStructure && doorStructure.boxes && Array.isArray(doorStructure.boxes.shadowRegions)),
      warnings: Object.freeze(warnings)
    })
  });
}

module.exports = {
  buildDimensionRenderPlan
};
