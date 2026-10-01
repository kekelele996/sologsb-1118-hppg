import type { Artifact, Relation, Stratum, Trench } from './index'

/** 站点角色：发掘现场 / 资料室（同一套应用在两边各部署一份，本地各自保存角色） */
export type PartyRole = 'field' | 'archive'

/** 交接方向：现场→资料室（交接包）/ 资料室→现场（回执） */
export type HandoffDirection = 'handover' | 'receipt'

/**
 * 出件/收件箱记录状态：
 * - 现场交接包：pending（已生成待送达）→ receipted（回执已收回）；失败重试不产生新状态，pending 一直在
 * - 资料室收件：imported（已收件待定稿）→ finalized（已出回执）
 */
export type HandoffStatus = 'pending' | 'receipted' | 'imported' | 'finalized'

/** 现场 → 资料室交接包 */
export interface HandoverPackage {
  kind: 'gbtrenchlog-handover'
  /** 包唯一号：同号重投按幂等处理（重试时必须导出同一个包，不能另起新号） */
  packageId: string
  /** 现场站点标识 */
  fromSite: string
  createdAt: string
  /** 记录人附言（如「Ⅱ区 10 月 1 日」） */
  note: string
  trenches: Trench[]
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
}

/** 资料室对单条记录的定稿项（只回定稿号） */
export interface ReceiptItem {
  entity: 'trench' | 'stratum' | 'artifact'
  id: string
  /** 资料室定稿号 */
  archiveCode: string
}

/** 资料室 → 现场回执：定稿编号回执，现场只回填 archiveCode，绝不动现场号 */
export interface ReceiptPackage {
  kind: 'gbtrenchlog-receipt'
  /** 回执对应交接包号（幂等键） */
  packageId: string
  handoverPackageId: string
  toSite: string
  finalizedAt: string
  items: ReceiptItem[]
}

/** 出件箱 / 收件箱记录（handoffs 表） */
export interface HandoffRecord {
  /** handover 用交接包 packageId；receipt 用回执 packageId */
  id: string
  direction: HandoffDirection
  status: HandoffStatus
  site: string
  note: string
  createdAt: string
  /** 对应包号（receipt 行指向其 handoverPackageId） */
  handoverPackageId: string
  /** 包内容原样保存：现场留着重试，资料室留着备查 */
  payload: HandoverPackage | ReceiptPackage
  /** 各类记录条数，便于列表展示 */
  counts: { trenches: number; strata: number; artifacts: number; relations: number }
}

export const HANDOVER_KIND = 'gbtrenchlog-handover'
export const RECEIPT_KIND = 'gbtrenchlog-receipt'
