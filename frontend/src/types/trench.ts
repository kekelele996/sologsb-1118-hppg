/** 探方规格 */
export const TRENCH_SIZES = ['5×5 米', '10×10 米', '5×10 米', '2×10 米'] as const
export type TrenchSize = (typeof TRENCH_SIZES)[number]

/** Trench 探方 */
export interface Trench {
  id: string
  /** 现场探方号（贴在现场记录上，资料室不得覆盖），如 T0501 */
  code: string
  /** 资料室定稿探方号（回执带回，未回执为空） */
  archiveCode: string
  /** 现场侧修订号：现场每改一次 +1，资料室仅在更高修订号到达时采纳现场字段 */
  fieldRev: number
  /** 发掘区 */
  area: string
  size: TrenchSize
  /** 基点坐标（如 N1200 / E3000） */
  basePoint: string
  /** 开口层位 */
  openLayer: string
  startDate: string
  endDate: string
  /** 负责人 */
  leader: string
  /** 四壁方向备注 */
  wallNote: string
  /** 是否已回填 */
  backfilled: boolean
}

/** 探方唯一键：发掘区-探方号（仍以现场号为准） */
export function trenchKey(trench: Pick<Trench, 'area' | 'code'>): string {
  return `${trench.area.trim()}-${trench.code.trim().toUpperCase()}`
}

/** 校验探方唯一性，返回冲突的探方（无冲突返回 null） */
export function findTrenchConflict(trenches: Trench[], candidate: Pick<Trench, 'id' | 'area' | 'code'>): Trench | null {
  const key = trenchKey(candidate)
  return trenches.find((item) => item.id !== candidate.id && trenchKey(item) === key) ?? null
}
