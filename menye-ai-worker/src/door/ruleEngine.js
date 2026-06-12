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
  if (heightBottomMode === 'shared') {
    return doorStructure && doorStructure.keypoints ? doorStructure.keypoints.doorBottomY : undefined;
  }
  return box.bottom;
}

function cloneBox(box) {
  if (!box) {
    return null;
  }
  return Object.freeze({
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom
  });
}

function makeOpeningEdgeTrimMidlineBox(doorStructure) {
  const outerTrim = getBox(doorStructure, 'outerTrim');
  const opening = getBox(doorStructure, 'opening');
  const visibleOpening = getBox(doorStructure, 'visibleOpening');
  if (!outerTrim || !visibleOpening) {
    return null;
  }
  const requiredValues = [
    outerTrim.left,
    outerTrim.top,
    outerTrim.right,
    outerTrim.bottom,
    opening && opening.top,
    visibleOpening.left,
    visibleOpening.top,
    visibleOpening.right,
    visibleOpening.bottom
  ];
  if (!requiredValues.every(hasNumber)) {
    return null;
  }
  const outerHeight = outerTrim.bottom - outerTrim.top;
  const openingTopGap = opening.top - outerTrim.top;
  const hasDistinctHeaderOrTransom = openingTopGap > Math.max(24, outerHeight * 0.12);
  const verticalOuterTop = hasDistinctHeaderOrTransom ? opening.top : outerTrim.top;
  return Object.freeze({
    left: (outerTrim.left + visibleOpening.left) / 2,
    top: (verticalOuterTop + visibleOpening.top) / 2,
    right: (outerTrim.right + visibleOpening.right) / 2,
    bottom: visibleOpening.bottom
  });
}

function getOpeningBoundaryBox({ field, doorStructure, hasVisibleOpeningRequest }) {
  if (field !== DimensionField.OPENING_WIDTH && field !== DimensionField.OPENING_HEIGHT) {
    const boundaryConfig = FIELD_BOUNDARY_MAP[field];
    const primaryBox = boundaryConfig ? getBox(doorStructure, boundaryConfig.boxKey) : null;
    return {
      box: primaryBox,
      sourceBoxKey: boundaryConfig ? boundaryConfig.boxKey : '',
      sourceBoxes: boundaryConfig ? [boundaryConfig.boxKey] : [],
      boundaryMode: 'profileBox'
    };
  }

  if (hasVisibleOpeningRequest) {
    const midlineBox = makeOpeningEdgeTrimMidlineBox(doorStructure);
    if (midlineBox) {
      return {
        box: midlineBox,
        sourceBoxKey: 'openingEdgeTrimMidline',
        sourceBoxes: ['outerTrim', 'visibleOpening'],
        boundaryMode: 'edgeTrimMidline'
      };
    }
    const openingBox = getBox(doorStructure, 'opening');
    return {
      box: openingBox,
      sourceBoxKey: 'opening',
      sourceBoxes: ['opening'],
      boundaryMode: 'edgeTrimMidlineFallback'
    };
  }

  const connectionBox = getBox(doorStructure, 'visibleOpening');
  if (connectionBox) {
    return {
      box: connectionBox,
      sourceBoxKey: 'visibleOpening',
      sourceBoxes: ['visibleOpening'],
      boundaryMode: 'doorTrimConnection'
    };
  }

  const openingBox = getBox(doorStructure, 'opening');
  return {
    box: openingBox,
    sourceBoxKey: 'opening',
    sourceBoxes: ['opening'],
    boundaryMode: 'doorTrimConnectionFallback'
  };
}

function buildLineBoundary({ field, doorStructure, hasSameAxisVisibleOpeningRequest }) {
  const boundaryConfig = FIELD_BOUNDARY_MAP[field];
  if (!boundaryConfig) {
    return {
      issue: makeIssue(ErrorCode.DIMENSION_RULE_INVALID, field, 'Missing dimension boundary mapping')
    };
  }

  const boxKey = boundaryConfig.boxKey;
  const openingBoundary = getOpeningBoundaryBox({
    field,
    doorStructure,
    hasVisibleOpeningRequest: hasSameAxisVisibleOpeningRequest
  });
  let box = openingBoundary.box;
  let sourceBoxKey = openingBoundary.sourceBoxKey || boxKey;
  let sourceBoxes = openingBoundary.sourceBoxes || [sourceBoxKey];
  let boundaryMode = openingBoundary.boundaryMode || 'profileBox';
  if (!box && boundaryConfig.fallbackBoxKey) {
    box = getBox(doorStructure, boundaryConfig.fallbackBoxKey);
    sourceBoxKey = boundaryConfig.fallbackBoxKey;
    sourceBoxes = [sourceBoxKey];
    boundaryMode = 'fallbackBox';
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
        boxRect: cloneBox(box),
        sourceBoxes: Object.freeze(sourceBoxes),
        boundaryMode,
        from: Object.freeze({ key: 'left', value: box.left }),
        to: Object.freeze({ key: 'right', value: box.right })
      }),
      orientation: 'horizontal',
      constraints: Object.freeze({
        ignoreShadowRegions: true,
        shadowRegionsExcluded: Array.isArray(doorStructure && doorStructure.boxes && doorStructure.boxes.shadowRegions),
        heightBottomMode,
        openingBoundaryMode: field === DimensionField.OPENING_WIDTH ? boundaryMode : null
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
      boxRect: cloneBox(box),
      sourceBoxes: Object.freeze(sourceBoxes),
      boundaryMode,
      from: Object.freeze({ key: 'top', value: top }),
      to: Object.freeze({
        key: heightBottomMode === 'shared' ? 'doorBottomY' : 'bottom',
        value: bottom
      })
    }),
    orientation: 'vertical',
    constraints: Object.freeze({
      ignoreShadowRegions: true,
      shadowRegionsExcluded: Array.isArray(doorStructure && doorStructure.boxes && doorStructure.boxes.shadowRegions),
      heightBottomMode,
      sharedBottomY: heightBottomMode === 'shared' ? bottom : null,
      openingBoundaryMode: field === DimensionField.OPENING_HEIGHT ? boundaryMode : null
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
  const hasVisibleOpeningWidthRequest = Object.prototype.hasOwnProperty.call(
    normalizedInputs.values,
    DimensionField.VISIBLE_OPENING_WIDTH
  );
  const hasVisibleOpeningHeightRequest = Object.prototype.hasOwnProperty.call(
    normalizedInputs.values,
    DimensionField.VISIBLE_OPENING_HEIGHT
  );

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

    const boundary = buildLineBoundary({
      field,
      doorStructure,
      hasSameAxisVisibleOpeningRequest: field === DimensionField.OPENING_WIDTH
        ? hasVisibleOpeningWidthRequest
        : field === DimensionField.OPENING_HEIGHT
          ? hasVisibleOpeningHeightRequest
          : false
    });
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
