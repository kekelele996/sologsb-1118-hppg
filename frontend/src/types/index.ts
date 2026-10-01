export { TRENCH_SIZES, trenchKey, findTrenchConflict } from './trench'
export type { Trench, TrenchSize } from './trench'
export { UNIT_TYPES, INCLUSIONS, stratumThickness, isDepthInverted, isCodeDuplicated, effectiveSoil, effectiveCode } from './stratum'
export type { Stratum, UnitType, Inclusion } from './stratum'
export { ARTIFACT_CATEGORIES, COMPLETENESS } from './artifact'
export type { Artifact, ArtifactCategory, Completeness } from './artifact'
export { RELATION_TYPES, RELATION_BASES } from './relation'
export type { Relation, RelationType, RelationBasis } from './relation'
export { HANDOVER_KIND, RECEIPT_KIND } from './handoff'
export type {
  PartyRole,
  HandoffDirection,
  HandoffStatus,
  HandoverPackage,
  ReceiptPackage,
  ReceiptItem,
  HandoffRecord
} from './handoff'
