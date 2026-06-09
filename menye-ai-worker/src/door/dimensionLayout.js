'use strict';

const { DimensionField } = require('./schema');

const HORIZONTAL_FIELD_ORDER = Object.freeze([
  DimensionField.WITH_EDGE_TRIM_WIDTH,
  DimensionField.OPENING_WIDTH,
  DimensionField.VISIBLE_OPENING_WIDTH,
  DimensionField.HEADER_WIDTH
]);

const VERTICAL_FIELD_ORDER = Object.freeze([
  DimensionField.WITH_EDGE_TRIM_HEIGHT,
  DimensionField.OPENING_HEIGHT,
  DimensionField.VISIBLE_OPENING_HEIGHT,
  DimensionField.TRANSOM_HEIGHT,
  DimensionField.HEADER_HEIGHT
]);

const DEFAULT_IMAGE_SIZE = Object.freeze({
  width: 1024,
  height: 1024
});

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

function makeArrow(lineId, field, point, direction, index) {
  return Object.freeze({
    id: `${lineId}-arrow-${index}`,
    lineId,
    field,
    position: Object.freeze(point),
    direction
  });
}

function makeLineRule(rule, index, doorStructure, imageSize, rank) {
  const sourceBoundary = rule.sourceBoundary || {};
  const fromValue = getPointValue(sourceBoundary, 'from');
  const toValue = getPointValue(sourceBoundary, 'to');
  if (fromValue === null || toValue === null) {
    return null;
  }

  const id = `line-${rule.field}-${index}`;
  const textId = `text-${rule.field}-${index}`;
  const arrowIds = [`${id}-arrow-0`, `${id}-arrow-1`];

  if (rule.orientation === 'horizontal') {
    const baseY = (doorStructure && doorStructure.keypoints && typeof doorStructure.keypoints.doorBottomY === 'number')
      ? doorStructure.keypoints.doorBottomY
      : Math.max(fromValue, toValue);
    const y = baseY + 34 + rank * 34;
    const from = Object.freeze({ x: fromValue, y });
    const to = Object.freeze({ x: toValue, y });
    const textPosition = Object.freeze({
      x: (fromValue + toValue) / 2,
      y: y - 8
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
      warning: y > imageSize.height ? `Horizontal dimension ${rule.field} extends below image` : ''
    };
  }

  if (rule.orientation === 'vertical') {
    const doorLeft = doorStructure && doorStructure.boxes && doorStructure.boxes.outerTrim
      ? doorStructure.boxes.outerTrim.left
      : Math.min(fromValue, toValue);
    const x = doorLeft - 34 - rank * 34;
    const from = Object.freeze({ x, y: fromValue });
    const to = Object.freeze({ x, y: toValue });
    const textPosition = Object.freeze({
      x: x - 8,
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
        align: 'right',
        baseline: 'middle'
      }),
      arrows: Object.freeze([
        makeArrow(id, rule.field, from, 'up', 0),
        makeArrow(id, rule.field, to, 'down', 1)
      ]),
      warning: x < 0 ? `Vertical dimension ${rule.field} extends left of image` : ''
    };
  }

  return null;
}

function getTextOnlyPosition(rule, imageSize, index) {
  const margin = 72;
  return Object.freeze({
    x: Math.max(0, imageSize.width - margin * 2),
    y: Math.max(0, imageSize.height - margin - index * 58)
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
  const texts = [];
  const arrows = [];
  const textOnlyAnnotations = [];
  const warnings = [];
  const usedBoundaries = [];
  let horizontalCount = 0;
  let verticalCount = 0;
  let textOnlyCount = 0;

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
    const rank = rule.orientation === 'horizontal'
      ? getHorizontalRank(rule.field, horizontalCount)
      : getVerticalRank(rule.field, verticalCount);
    const layout = makeLineRule(rule, lines.length, doorStructure, size, rank);
    if (!layout) {
      warnings.push(`Rule ${rule.field} could not be laid out`);
      continue;
    }
    lines.push(layout.line);
    texts.push(layout.text);
    arrows.push(...layout.arrows);
    if (layout.warning) {
      warnings.push(layout.warning);
    }
    if (rule.sourceBoundary && rule.sourceBoundary.box) {
      usedBoundaries.push(Object.freeze({
        field: rule.field,
        box: rule.sourceBoundary.box,
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
    texts: Object.freeze(texts),
    arrows: Object.freeze(arrows),
    textOnlyAnnotations: Object.freeze(textOnlyAnnotations),
    metadata: Object.freeze({
      imageSize: Object.freeze(size)
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
