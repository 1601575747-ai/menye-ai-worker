'use strict';

const TaskType = Object.freeze({
  DIMENSION_ANNOTATION: 'dimension-annotation',
  PARTS_COMPOSE: 'parts-compose',
  LOCK_REPLACEMENT: 'lock-replacement',
  HANDLE_REPLACEMENT: 'handle-replacement',
  COLOR_CHANGE: 'color-change',
  BACKGROUND_REPLACE: 'background-replace',
  CLEANUP: 'cleanup'
});

const DimensionField = Object.freeze({
  OPENING_WIDTH: 'openingWidth',
  OPENING_HEIGHT: 'openingHeight',
  VISIBLE_OPENING_WIDTH: 'visibleOpeningWidth',
  VISIBLE_OPENING_HEIGHT: 'visibleOpeningHeight',
  WITH_EDGE_TRIM_WIDTH: 'withEdgeTrimWidth',
  WITH_EDGE_TRIM_HEIGHT: 'withEdgeTrimHeight',
  WALL_THICKNESS: 'wallThickness',
  TRANSOM_HEIGHT: 'transomHeight',
  HEADER_WIDTH: 'headerWidth',
  HEADER_HEIGHT: 'headerHeight'
});

const dimensionFieldLabels = Object.freeze({
  [DimensionField.OPENING_WIDTH]: '门洞宽',
  [DimensionField.OPENING_HEIGHT]: '门洞高',
  [DimensionField.VISIBLE_OPENING_WIDTH]: '见光宽',
  [DimensionField.VISIBLE_OPENING_HEIGHT]: '见光高',
  [DimensionField.WITH_EDGE_TRIM_WIDTH]: '含包边宽',
  [DimensionField.WITH_EDGE_TRIM_HEIGHT]: '含包边高',
  [DimensionField.WALL_THICKNESS]: '墙体厚度',
  [DimensionField.TRANSOM_HEIGHT]: '含气窗高',
  [DimensionField.HEADER_WIDTH]: '含门头宽',
  [DimensionField.HEADER_HEIGHT]: '含门头高'
});

const DimensionFieldMeta = Object.freeze(Object.values(DimensionField).reduce((result, key) => {
  result[key] = Object.freeze({
    key,
    label: dimensionFieldLabels[key],
    unit: 'mm',
    type: 'number',
    textOnly: key === DimensionField.WALL_THICKNESS
  });
  return result;
}, {}));

/**
 * DoorStructure is the normalized structure recognized from a door image.
 * Coordinates should use stable English keys and image-pixel values. Chinese
 * labels are display-only metadata and must not be used for logic branching.
 */
const DoorStructureShape = Object.freeze({
  doorType: '',
  viewSide: 'front',
  boxes: Object.freeze({
    outerTrim: null,
    opening: null,
    visibleOpening: null,
    doorLeaf: null,
    handle: null,
    lock: null,
    transom: null,
    header: null,
    shadowRegions: []
  }),
  keypoints: Object.freeze({
    doorBottomY: null
  }),
  modes: Object.freeze({
    heightBottomMode: 'shared'
  }),
  confidence: Object.freeze({}),
  notes: ''
});

const ValidationResultShape = Object.freeze({
  passed: false,
  issues: [],
  retryable: false,
  retryPrompt: '',
  needsUserAdjustment: false
});

module.exports = {
  TaskType,
  DimensionField,
  DimensionFieldMeta,
  DoorStructureShape,
  ValidationResultShape
};
