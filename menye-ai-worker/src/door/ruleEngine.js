'use strict';

const {
  DimensionField,
  DimensionFieldMeta
} = require('./schema');
const {
  getDoorTypeProfile,
  isDimensionFieldAllowed
} = require('./profiles');
const {
  normalizeDimensionInputs
} = require('./dimensions');
const { JobStatus } = require('../jobs/status');
const { ErrorCode } = require('../utils/errors');

const FIELD_BOUNDARY_MAP = Object.freeze({
  [DimensionField.OPENING_WIDTH]: Object.freeze({
    boxKey: 'opening',
    orientation: 'horizontal',
    startKey: 'left',
    endKey: 'right'
  }),
  [DimensionField.OPENING_HEIGHT]: Object.freeze({
    boxKey: 'opening',
    orientation: 'vertical',
    startKey: 'top',
    endKey: 'bottom'
  }),
  [DimensionField.VISIBLE_OPENING_WIDTH]: Object.freeze({
    boxKey: 'visibleOpening',
    orientation: 'horizontal',
    startKey: 'left',
    endKey: 'right'
  }),
  [DimensionField.VISIBLE_OPENING_HEIGHT]: Object.freeze({
    boxKey: 'visibleOpening',
    orientation: 'vertical',
    startKey: 'top',
    endKey: 'bottom'
  }),
  [DimensionField.WITH_EDGE_TRIM_WIDTH]: Object.freeze({
    boxKey: 'outerTrim',
    orientation: 'horizontal',
    startKey: 'left',
    endKey: 'right'
  }),
  [DimensionField.WITH_EDGE_TRIM_HEIGHT]: Object.freeze({
    boxKey: 'outerTrim',
    orientation: 'vertical',
    startKey: 'top',
    endKey: 'bottom'
  }),
  [DimensionField.TRANSOM_HEIGHT]: Object.freeze({
    boxKey: 'transom',
    fallbackBoxKey: 'outerTrim',
    orientation: 'vertical',
    startKey: 'top',
    endKey: 'bottom'
  }),
  [DimensionField.HEADER_WIDTH]: Object.freeze({
    boxKey: 'header',
    orientation: 'horizontal',
    startKey: 'left',
    endKey: 'right'
  }),
  [DimensionField.HEADER_HEIGHT]: Object.freeze({
    boxKey: 'header',
    orientation: 'vertical',
    startKey: 'top',
    endKey: 'bottom'
  })
});

function hasNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function getBox(doorStructure, boxKey) {
  return doorStructure && doorStructure.boxes ? doorStructure.boxes[boxKey] : null;
}

function getConfidence(doorStructure, field, boxKey) {
  const confidence = doorStructure && doorStructure.confidence ? doorStructure.confidence : {};
  return confidence[field] || confidence[boxKey] || confidence.overall || 'unknown';
}

function makeIssue(code, field, message, details = {}) {
  return Object.freeze({
    code,
    field,
    message,
    ...details
  });
}

function buildTextOnlyRule(field, normalizedInput) {
  const meta = DimensionFieldMeta[field];
  return Object.freeze({
    field,
    label: meta.label,
    value: normalizedInput.value,
    unit: normalizedInput.unit,
    type: 'textOnly',
    orientation: null,
    sourceBoundary: null,
    constraints: Object.freeze({
      placement: 'bottomRight',
      textOnly: true
    }),
    confidence: 'not_applicable'
  });
}

function getVerticalBottom({ field, box, doorStructure, heightBottomMode }) {
  const isHeaderHeight = field === DimensionField.HEADER_HEIGHT;
  if (isHeaderHeight) {
    return box.bottom;
  }
  if (heightBottomMode === 'shared') {
    return doorStructure && doorStructure.keypoints ? doorStructure.keypoints.doorBottomY : undefined;
  }
  return box.bottom;
}

function buildLineBoundary({ field, doorStructure }) {
  const boundaryConfig = FIELD_BOUNDARY_MAP[field];
  if (!boundaryConfig) {
    return {
      issue: makeIssue(ErrorCode.DIMENSION_RULE_INVALID, field, 'Missing dimension boundary mapping')
    };
  }

  const boxKey = boundaryConfig.boxKey;
  let box = getBox(doorStructure, boxKey);
  let sourceBoxKey = boxKey;
  if (!box && boundaryConfig.fallbackBoxKey) {
    box = getBox(doorStructure, boundaryConfig.fallbackBoxKey);
    sourceBoxKey = boundaryConfig.fallbackBoxKey;
  }
  if (!box) {
    return {
      issue: makeIssue(ErrorCode.MISSING_REQUIRED_BOUNDARY, field, `Missing required boundary box: ${boxKey}`, {
        boundary: boxKey
      })
    };
  }

  const heightBottomMode = doorStructure && doorStructure.modes && doorStructure.modes.heightBottomMode === 'separate'
    ? 'separate'
    : 'shared';

  if (boundaryConfig.orientation === 'horizontal') {
    if (!hasNumber(box.left) || !hasNumber(box.right)) {
      return {
        issue: makeIssue(ErrorCode.MISSING_REQUIRED_BOUNDARY, field, `Missing horizontal boundary values: ${sourceBoxKey}`, {
          boundary: sourceBoxKey
        })
      };
    }
    return {
      sourceBoundary: Object.freeze({
        box: sourceBoxKey,
        from: Object.freeze({ key: 'left', value: box.left }),
        to: Object.freeze({ key: 'right', value: box.right })
      }),
      orientation: 'horizontal',
      constraints: Object.freeze({
        ignoreShadowRegions: true,
        shadowRegionsExcluded: Array.isArray(doorStructure && doorStructure.boxes && doorStructure.boxes.shadowRegions),
        heightBottomMode
      })
    };
  }

  const top = box.top;
  const bottom = getVerticalBottom({
    field,
    box,
    doorStructure,
    heightBottomMode
  });
  if (!hasNumber(top) || !hasNumber(bottom)) {
    return {
      issue: makeIssue(ErrorCode.MISSING_REQUIRED_BOUNDARY, field, `Missing vertical boundary values: ${sourceBoxKey}`, {
        boundary: sourceBoxKey,
        needsDoorBottomY: heightBottomMode === 'shared' && field !== DimensionField.HEADER_HEIGHT
      })
    };
  }
  return {
    sourceBoundary: Object.freeze({
      box: sourceBoxKey,
      from: Object.freeze({ key: 'top', value: top }),
      to: Object.freeze({
        key: heightBottomMode === 'shared' && field !== DimensionField.HEADER_HEIGHT ? 'doorBottomY' : 'bottom',
        value: bottom
      })
    }),
    orientation: 'vertical',
    constraints: Object.freeze({
      ignoreShadowRegions: true,
      shadowRegionsExcluded: Array.isArray(doorStructure && doorStructure.boxes && doorStructure.boxes.shadowRegions),
      heightBottomMode,
      sharedBottomY: heightBottomMode === 'shared' && field !== DimensionField.HEADER_HEIGHT ? bottom : null
    })
  };
}

function buildDimensionRules({ doorType, viewSide, inputs, doorStructure } = {}) {
  const profile = getDoorTypeProfile(doorType);
  const normalizedInputs = normalizeDimensionInputs(inputs, {
    doorType: profile.key,
    viewSide
  });
  const issues = normalizedInputs.errors.slice();
  const rules = [];

  for (const [field, normalizedInput] of Object.entries(normalizedInputs.values)) {
    if (!isDimensionFieldAllowed({ doorType: profile.key, viewSide, field })) {
      continue;
    }
    const meta = DimensionFieldMeta[field];
    if (!meta) {
      issues.push(makeIssue(ErrorCode.DIMENSION_RULE_INVALID, field, 'Missing field metadata'));
      continue;
    }
    if (meta.textOnly || field === DimensionField.WALL_THICKNESS) {
      rules.push(buildTextOnlyRule(field, normalizedInput));
      continue;
    }

    const boundary = buildLineBoundary({ field, doorStructure });
    if (boundary.issue) {
      issues.push(boundary.issue);
      continue;
    }
    rules.push(Object.freeze({
      field,
      label: meta.label,
      value: normalizedInput.value,
      unit: normalizedInput.unit,
      type: 'line',
      orientation: boundary.orientation,
      sourceBoundary: boundary.sourceBoundary,
      constraints: boundary.constraints,
      confidence: getConfidence(doorStructure, field, boundary.sourceBoundary.box)
    }));
  }

  const hasBlockingIssue = issues.some((issue) => issue.code === ErrorCode.MISSING_REQUIRED_BOUNDARY);

  return Object.freeze({
    status: hasBlockingIssue ? JobStatus.NEEDS_USER_ADJUSTMENT : JobStatus.RULES_READY,
    doorType: profile.key,
    viewSide: viewSide === 'back' ? 'back' : 'front',
    rules: Object.freeze(rules),
    issues: Object.freeze(issues),
    needsUserAdjustment: hasBlockingIssue
  });
}

module.exports = {
  buildDimensionRules
};
