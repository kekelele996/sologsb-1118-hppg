/** 数据来源侧：现场 / 资料室 */
export type Side = 'field' | 'archive'

/** 设备角色（本机是哪一侧） */
export type DeviceRole = Side

/** 交接溯源字段（探方 / 地层单位 / 出土物 / 层位关系 四类记录共有） */
export interface Provenance<T> {
  /** 来源侧：这条记录最初由哪一侧建立 */
  originSide: Side
  /** 来源侧本地 id（跨设备对照主键，含设备前缀，全局唯一） */
  originId: string
  /** 来源侧建立时的本地 id（交接时用于重映射外键） */
  sourceLocalId: string
  /** 曾用号 / 对方侧编号（实物标签上的号保留在此，不被定稿号覆盖） */
  aliasCodes: string[]
  /** 已定稿（资料室定稿后锁定，不退改） */
  finalized: boolean
  /** 最后修改时间（epoch 毫秒），用于变更检测 */
  updatedAt: number
  /** 上次同步时的业务数据快照（3-way merge 基准） */
  syncBase: T | null
}
