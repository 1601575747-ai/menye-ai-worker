'use strict';

const {
  TaskType,
  DimensionField,
  DimensionFieldMeta
} = require('./schema');

const ViewSide = Object.freeze({
  FRONT: 'front',
  BACK: 'back'
});

const DoorTypeKey = Object.freeze({
  SINGLE: 'single',
  DOUBLE: 'double',
  MOTHER_CHILD: 'motherChild',
  FOUR_MOTHER_CHILD: 'fourMotherChild',
  FOUR_EQUAL: 'fourEqual',
  SIX_PANEL: 'sixPanel'
});

const COMMON_DIMENSION_FIELDS = Object.freeze([
  DimensionField.OPENING_WIDTH,
  DimensionField.OPENING_HEIGHT,
  DimensionField.VISIBLE_OPENING_WIDTH,
  DimensionField.VISIBLE_OPENING_HEIGHT,
  DimensionField.WITH_EDGE_TRIM_WIDTH,
  DimensionField.WITH_EDGE_TRIM_HEIGHT,
  DimensionField.WALL_THICKNESS,
  DimensionField.TRANSOM_HEIGHT,
  DimensionField.HEADER_WIDTH,
  DimensionField.HEADER_HEIGHT
]);

const COMMON_ALLOWED_PIPELINES = Object.freeze([
  TaskType.DIMENSION_ANNOTATION,
  TaskType.PARTS_COMPOSE,
  TaskType.LOCK_REPLACEMENT,
  TaskType.HANDLE_REPLACEMENT,
  TaskType.COLOR_CHANGE,
  TaskType.BACKGROUND_REPLACE,
  TaskType.CLEANUP
]);

const FULL_DOOR_SLOT = 'full-door';
const OPTIONAL_REFERENCE_SLOTS = Object.freeze([
  'handle-detail',
  'lock-detail',
  'edge-trim-detail',
  'color-sample',
  'background-reference',
  'door-panel-detail',
  'header-column-detail',
  'transom-detail',
  'texture-detail'
]);

const baseDimensionRules = Object.freeze({
  [DimensionField.OPENING_WIDTH]: Object.freeze({
    axis: 'x',
    from: 'boxes.opening.left',
    to: 'boxes.opening.right'
  }),
  [DimensionField.OPENING_HEIGHT]: Object.freeze({
    axis: 'y',
    from: 'boxes.opening.top',
    to: 'keypoints.doorBottomY'
  }),
  [DimensionField.VISIBLE_OPENING_WIDTH]: Object.freeze({
    axis: 'x',
    from: 'boxes.visibleOpening.left',
    to: 'boxes.visibleOpening.right'
  }),
  [DimensionField.VISIBLE_OPENING_HEIGHT]: Object.freeze({
    axis: 'y',
    from: 'boxes.visibleOpening.top',
    to: 'keypoints.doorBottomY'
  }),
  [DimensionField.WITH_EDGE_TRIM_WIDTH]: Object.freeze({
    axis: 'x',
    from: 'boxes.outerTrim.left',
    to: 'boxes.outerTrim.right'
  }),
  [DimensionField.WITH_EDGE_TRIM_HEIGHT]: Object.freeze({
    axis: 'y',
    from: 'boxes.outerTrim.top',
    to: 'keypoints.doorBottomY'
  }),
  [DimensionField.WALL_THICKNESS]: Object.freeze({
    axis: 'text',
    placement: 'bottomRight',
    textOnly: true
  }),
  [DimensionField.TRANSOM_HEIGHT]: Object.freeze({
    axis: 'y',
    from: 'boxes.transom.top',
    to: 'keypoints.doorBottomY'
  }),
  [DimensionField.HEADER_WIDTH]: Object.freeze({
    axis: 'x',
    from: 'boxes.header.left',
    to: 'boxes.header.right'
  }),
  [DimensionField.HEADER_HEIGHT]: Object.freeze({
    axis: 'y',
    from: 'boxes.header.top',
    to: 'boxes.header.bottom'
  })
});

function freezeProfile(profile) {
  return Object.freeze({
    ...profile,
    supportedViewSides: Object.freeze(profile.supportedViewSides.slice()),
    dimensionFields: Object.freeze(profile.dimensionFields.slice()),
    dimensionRules: Object.freeze({ ...profile.dimensionRules }),
    allowedPipelines: Object.freeze(profile.allowedPipelines.slice()),
    requiredSlots: Object.freeze(profile.requiredSlots.slice()),
    optionalSlots: Object.freeze(profile.optionalSlots.slice())
  });
}

function createProfile(key, label) {
  return freezeProfile({
    key,
    label,
    supportedViewSides: [ViewSide.FRONT, ViewSide.BACK],
    dimensionFields: COMMON_DIMENSION_FIELDS,
    dimensionRules: baseDimensionRules,
    allowedPipelines: COMMON_ALLOWED_PIPELINES,
    requiredSlots: [FULL_DOOR_SLOT],
    optionalSlots: OPTIONAL_REFERENCE_SLOTS
  });
}

const doorTypeProfiles = Object.freeze({
  [DoorTypeKey.SINGLE]: createProfile(DoorTypeKey.SINGLE, '单开门'),
  [DoorTypeKey.DOUBLE]: createProfile(DoorTypeKey.DOUBLE, '双开门'),
  [DoorTypeKey.MOTHER_CHILD]: createProfile(DoorTypeKey.MOTHER_CHILD, '子母门'),
  [DoorTypeKey.FOUR_MOTHER_CHILD]: createProfile(DoorTypeKey.FOUR_MOTHER_CHILD, '四开子母门'),
  [DoorTypeKey.FOUR_EQUAL]: createProfile(DoorTypeKey.FOUR_EQUAL, '四开平分门'),
  [DoorTypeKey.SIX_PANEL]: createProfile(DoorTypeKey.SIX_PANEL, '六开门')
});

const doorTypeAliases = Object.freeze({
  [DoorTypeKey.SINGLE]: DoorTypeKey.SINGLE,
  singleDoor: DoorTypeKey.SINGLE,
  '单开门': DoorTypeKey.SINGLE,
  '单门': DoorTypeKey.SINGLE,

  [DoorTypeKey.DOUBLE]: DoorTypeKey.DOUBLE,
  doubleDoor: DoorTypeKey.DOUBLE,
  '双开门': DoorTypeKey.DOUBLE,
  '双门': DoorTypeKey.DOUBLE,

  [DoorTypeKey.MOTHER_CHILD]: DoorTypeKey.MOTHER_CHILD,
  motherChildDoor: DoorTypeKey.MOTHER_CHILD,
  childMother: DoorTypeKey.MOTHER_CHILD,
  '子母门': DoorTypeKey.MOTHER_CHILD,

  [DoorTypeKey.FOUR_MOTHER_CHILD]: DoorTypeKey.FOUR_MOTHER_CHILD,
  fourMotherChildDoor: DoorTypeKey.FOUR_MOTHER_CHILD,
  '四开子母门': DoorTypeKey.FOUR_MOTHER_CHILD,

  [DoorTypeKey.FOUR_EQUAL]: DoorTypeKey.FOUR_EQUAL,
  fourEqualDoor: DoorTypeKey.FOUR_EQUAL,
  fourPanel: DoorTypeKey.FOUR_EQUAL,
  '四开平分门': DoorTypeKey.FOUR_EQUAL,
  '四开门': DoorTypeKey.FOUR_EQUAL,

  [DoorTypeKey.SIX_PANEL]: DoorTypeKey.SIX_PANEL,
  sixPanelDoor: DoorTypeKey.SIX_PANEL,
  '六开门': DoorTypeKey.SIX_PANEL
});

function normalizeDoorType(doorType) {
  const text = String(doorType || '').trim();
  if (!text) {
    return DoorTypeKey.SINGLE;
  }
  if (doorTypeAliases[text]) {
    return doorTypeAliases[text];
  }
  if (/六开/.test(text)) {
    return DoorTypeKey.SIX_PANEL;
  }
  if (/四开.*子母|子母.*四开/.test(text)) {
    return DoorTypeKey.FOUR_MOTHER_CHILD;
  }
  if (/四开/.test(text)) {
    return DoorTypeKey.FOUR_EQUAL;
  }
  if (/子母/.test(text)) {
    return DoorTypeKey.MOTHER_CHILD;
  }
  if (/双开|双门/.test(text)) {
    return DoorTypeKey.DOUBLE;
  }
  return DoorTypeKey.SINGLE;
}

function normalizeViewSide(viewSide) {
  return viewSide === ViewSide.BACK ? ViewSide.BACK : ViewSide.FRONT;
}

function getDoorTypeProfile(doorType) {
  return doorTypeProfiles[normalizeDoorType(doorType)] || doorTypeProfiles[DoorTypeKey.SINGLE];
}

function getDimensionFields({ doorType, viewSide, taskType } = {}) {
  if (taskType && taskType !== TaskType.DIMENSION_ANNOTATION) {
    return [];
  }
  const profile = getDoorTypeProfile(doorType);
  const normalizedViewSide = normalizeViewSide(viewSide);
  if (!profile.supportedViewSides.includes(normalizedViewSide)) {
    return [];
  }
  return profile.dimensionFields.map((fieldKey) => DimensionFieldMeta[fieldKey]);
}

function isDimensionFieldAllowed({ doorType, viewSide, field } = {}) {
  const profile = getDoorTypeProfile(doorType);
  const normalizedViewSide = normalizeViewSide(viewSide);
  if (!profile.supportedViewSides.includes(normalizedViewSide)) {
    return false;
  }
  return profile.dimensionFields.includes(field);
}

module.exports = {
  ViewSide,
  DoorTypeKey,
  doorTypeProfiles,
  normalizeDoorType,
  getDoorTypeProfile,
  getDimensionFields,
  isDimensionFieldAllowed
};
