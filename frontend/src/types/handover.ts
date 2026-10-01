import type { Side } from './common'
import type { Artifact } from './artifact'
import type { Relation } from './relation'
import type { Stratum } from './stratum'
import type { Trench } from './trench'

/** 交接单状态 */
export type HandoverStatus =
  | 'draft' // 草稿（现场已勾选，尚未生成文件）
  | 'sent' // 已生成交接单文件，待资料室接收
  | 'received' // 资料室已接收，待定稿
  | 'finalized' // 资料室已定稿，回执已生成
  | 'receipted' // 现场已导入回执
  | 'failed' // 交接失败（校验不通过，现场留着重试）

/** 交接条目种类 */
export type ItemKind = 'trench' | 'stratum' | 'artifact' | 'relation'

/** 一条交接条目：带溯源信息的记录 */
export interface HandoverItem {
  kind: ItemKind
  /** 来源侧的跨设备对照主键 */
  originId: string
  originSide: Side
  /** 记录业务数据（含来源侧本地 id） */
  data: Trench | Stratum | Artifact | Relation
}

/** 交接单（现场 → 资料室） */
export interface HandoverPackage {
  id: string
  kind: 'handover'
  /** 文件格式版本 */
  version: 1
  direction: 'field_to_archive'
  status: HandoverStatus
  createdAt: number
  createdBy: string
  senderSide: Side
  items: HandoverItem[]
  note: string
}

/** 回执条目：资料室定稿后的一条记录 */
export interface ReceiptItem {
  kind: ItemKind
  originId: string
  /** 资料室侧的本地 id */
  finalId: string
  /** 资料室定稿编号 */
  finalCode: string
  /** 曾用号 / 现场号（实物标签上的号） */
  aliasCodes: string[]
  /** 定稿后的记录业务数据 */
  data: Trench | Stratum | Artifact | Relation
}

/** 回执（资料室 → 现场） */
export interface Receipt {
  id: string
  kind: 'receipt'
  version: 1
  /** 对应的交接单 id */
  handoverId: string
  direction: 'archive_to_field'
  status: 'receipted'
  createdAt: number
  createdBy: string
  items: ReceiptItem[]
}

/** 交接单或回执（handovers 表统一存储） */
export type HandoverDoc = HandoverPackage | Receipt

/** 导入预览：资料室收到交接单后的核对结果 */
export interface ImportPreview {
  package: HandoverPackage
  /** 逐条核对结果 */
  rows: ImportRow[]
  /** 校验错误（任一存在则不可定稿） */
  errors: string[]
  /** 统计 */
  counts: { create: number; update: number; conflict: number; unchanged: number }
}

/** 单条导入核对结果 */
export interface ImportRow {
  kind: ItemKind
  originId: string
  /** 现场编号 */
  fieldCode: string
  /** 资料室现有编号（若无则为新增） */
  archiveCode: string | null
  /** 建议定稿编号 */
  suggestedCode: string
  /** 资料室是否已存在该记录 */
  exists: boolean
  /** 两边都改动过，需按字段规则合并 */
  conflict: boolean
  /** 处理方式 */
  action: 'create' | 'merge' | 'unchanged'
  /** 该条校验错误 */
  errors: string[]
}
