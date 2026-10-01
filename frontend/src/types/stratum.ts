/** 单位类型 */
export const UNIT_TYPES = ['地层', '灰坑', '房址', '沟', '墓葬'] as const
export type UnitType = (typeof UNIT_TYPES)[number]

/** 包含物 */
export const INCLUSIONS = ['陶片', '骨', '炭屑', '石器'] as const
export type Inclusion = (typeof INCLUSIONS)[number]

/** Stratum 地层单位 */
export interface Stratum {
  id: string
  trenchId: string
  /** 现场单位号（贴在探方壁、图上与出土物上，资料室不得覆盖），如 H12、L03 */
  code: string
  /** 资料室定稿单位号（回执带回，未回执为空） */
  archiveCode: string
  /** 现场侧修订号：现场每改一次 +1，资料室仅在更高修订号到达时采纳深度/层位 */
  fieldRev: number
  type: UnitType
  /** 开口层位（现场主权） */
  openLayer: string
  /** 距地表深度上界（米，现场主权） */
  topDepth: number
  /** 距地表深度下界（米，现场主权） */
  bottomDepth: number
  /** 土质土色 · 现场原始记录 */
  soil: string
  /** 土质土色 · 资料室定稿（空则展示现场记录，非空一律听资料室） */
  soilArchive: string
  /** 资料室是否已定稿：定稿后定稿字段不退，现场侧修订的深度/层位仍可更新 */
  finalized: boolean
  inclusions: Inclusion[]
  /** 堆积成因推测 */
  formation: string
  date: string
  /** 绘图与拍照编号 */
  drawingNo: string
}

/** 展示用土质土色：资料室定稿优先，未定稿时退回现场原始记录 */
export function effectiveSoil(stratum: Pick<Stratum, 'soil' | 'soilArchive'>): string {
  return stratum.soilArchive.trim() || stratum.soil
}

/** 展示用单位号：资料室定稿号优先，但现场号一并保留展示 */
export function effectiveCode<T extends { code: string; archiveCode: string }>(unit: T): string {
  return unit.archiveCode.trim() || unit.code
}

/** 厚度（米） */
export function stratumThickness(stratum: Pick<Stratum, 'topDepth' | 'bottomDepth'>): number {
  return Math.round(Math.abs(stratum.bottomDepth - stratum.topDepth) * 100) / 100
}

/** 层序是否倒置：上界深度大于下界深度即倒置 */
export function isDepthInverted(stratum: Pick<Stratum, 'topDepth' | 'bottomDepth'>): boolean {
  return stratum.topDepth > stratum.bottomDepth
}

/** 单位号在同一探方内是否重复（以现场号为准，现场号是贴在实物上的那一套） */
export function isCodeDuplicated(strata: Stratum[], candidate: Pick<Stratum, 'id' | 'trenchId' | 'code'>): boolean {
  return strata.some(
    (item) =>
      item.id !== candidate.id &&
      item.trenchId === candidate.trenchId &&
      item.code.trim().toUpperCase() === candidate.code.trim().toUpperCase()
  )
}
