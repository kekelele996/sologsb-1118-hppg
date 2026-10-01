import { onUnmounted, reactive } from 'vue'
import type { StoreApi } from 'zustand/vanilla'
import Dexie, { type Table } from 'dexie'
import type { Artifact, DeviceRole, HandoverDoc, Provenance, Relation, Side, Stratum, Trench } from '@/types'
import { uid } from '@/utils/id'

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number | string
}

/** Dexie 封装：探方 / 地层单位 / 出土物 / 层位关系 / 交接单 五张表 + 元数据表 */
class TrenchLogDb extends Dexie {
  trenches!: Table<Trench, string>
  strata!: Table<Stratum, string>
  artifacts!: Table<Artifact, string>
  relations!: Table<Relation, string>
  handovers!: Table<HandoverDoc, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbtrenchlog')
    this.version(1).stores({
      trenches: 'id, code, area',
      strata: 'id, trenchId, code, type',
      artifacts: 'id, stratumId, code, category',
      relations: 'id, unitAId, unitBId, type',
      meta: 'key'
    })
    // v2：地层单位新增「开口层位」字段，迁移时为历史数据补齐默认值
    this.version(2)
      .stores({
        trenches: 'id, code, area, backfilled',
        strata: 'id, trenchId, code, type, topDepth',
        artifacts: 'id, stratumId, code, category, date',
        relations: 'id, unitAId, unitBId, type, basis',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Stratum, string>('strata')
          .toCollection()
          .modify((stratum) => {
            if (!stratum.openLayer) {
              stratum.openLayer = '第①层'
            }
            if (!Array.isArray(stratum.inclusions)) {
              stratum.inclusions = []
            }
          })
      })
    // v3：新增交接单表；四类记录补齐溯源字段（originId 带设备前缀，两侧数据按此拆开、不按编号合并）
    this.version(SCHEMA_VERSION)
      .stores({
        trenches: 'id, code, area, backfilled, originId, originSide, finalized',
        strata: 'id, trenchId, code, type, topDepth, originId, originSide, finalized',
        artifacts: 'id, stratumId, code, category, date, originId, originSide, finalized',
        relations: 'id, unitAId, unitBId, type, basis, originId, originSide, finalized',
        handovers: 'id, kind, direction, status, handoverId, createdAt',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        let deviceRow = await tx.table<MetaRow, string>('meta').get('deviceId')
        if (!deviceRow) {
          deviceRow = { key: 'deviceId', value: uid('dev') }
          await tx.table('meta').put(deviceRow)
        }
        const prefix = String(deviceRow.value)
        const now = Date.now()
        for (const table of ['trenches', 'strata', 'artifacts', 'relations'] as const) {
          await tx
            .table<Trench | Stratum | Artifact | Relation, string>(table)
            .toCollection()
            .modify((row) => {
              if (row.originId !== undefined) return
              row.originSide = 'field'
              row.originId = `${prefix}:${row.id}`
              row.sourceLocalId = row.id
              row.aliasCodes = []
              row.finalized = false
              row.updatedAt = now
              row.syncBase = null
            })
        }
      })
  }
}

export const db = new TrenchLogDb()

/** 写入当前数据结构版本号 */
export async function stampDbVersion(): Promise<void> {
  await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
}

// ————— 设备身份与角色 —————

let cachedDeviceId: string | null = null
let cachedRole: DeviceRole | null = null

/** 本机设备 id（首次运行生成，用于跨设备交接时的记录对照） */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId
  const row = await db.meta.get('deviceId')
  if (row && typeof row.value === 'string' && row.value) {
    cachedDeviceId = row.value
    return cachedDeviceId
  }
  const id = uid('dev')
  await db.meta.put({ key: 'deviceId', value: id })
  cachedDeviceId = id
  return id
}

/** 同步取设备 id（bootstrap 后可用） */
export function deviceIdSync(): string {
  if (!cachedDeviceId) throw new Error('deviceId 尚未加载，请先 await getDeviceId()')
  return cachedDeviceId
}

/** 读取本机角色（现场 / 资料室），未设置返回 null */
export async function getDeviceRole(): Promise<DeviceRole | null> {
  if (cachedRole) return cachedRole
  const row = await db.meta.get('deviceRole')
  cachedRole = row && (row.value === 'field' || row.value === 'archive') ? (row.value as DeviceRole) : null
  return cachedRole
}

/** 设置本机角色 */
export async function setDeviceRole(role: DeviceRole): Promise<void> {
  cachedRole = role
  await db.meta.put({ key: 'deviceRole', value: role })
}

/**
 * 构造溯源字段。originId 带设备前缀，跨设备全局唯一，
 * 两侧数据按 originId 对照、绝不按编号合并（已有数据升级时按两侧拆开）。
 */
export function provenanceFor<T>(localId: string, side: Side = 'field'): Provenance<T> {
  return {
    originSide: side,
    originId: `${deviceIdSync()}:${localId}`,
    sourceLocalId: localId,
    aliasCodes: [],
    finalized: false,
    updatedAt: Date.now(),
    syncBase: null
  }
}

/**
 * 保存时取溯源字段：编辑已有记录则保留其来源侧 / 曾用号 / 定稿标记 / 同步基准，
 * 仅刷新 updatedAt；新建记录则生成默认溯源字段。
 */
export function provenanceForSave<T extends { id: string }>(
  existing: T | null | undefined,
  newId: string,
  side: Side = 'field'
): Provenance<T> {
  if (existing) {
    const prev = existing as unknown as Provenance<T>
    return {
      originSide: prev.originSide,
      originId: prev.originId,
      sourceLocalId: prev.sourceLocalId,
      aliasCodes: [...prev.aliasCodes],
      finalized: prev.finalized,
      updatedAt: Date.now(),
      syncBase: prev.syncBase
    }
  }
  return provenanceFor<T>(newId, side)
}

/** 读取整表 */
export async function syncAll<T extends object>(table: Table<T, string>): Promise<T[]> {
  return table.toArray()
}

/** 写入一条记录 */
export async function syncPut<T extends object>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(row)
}

/** 删除一条记录 */
export async function syncDelete<T extends object>(table: Table<T, string>, id: string): Promise<void> {
  await table.delete(id)
}

/** Zustand vanilla store → Vue 响应式桥接 */
export function useStore<T extends object>(store: StoreApi<T>): T {
  const state = reactive({ ...store.getState() }) as T
  const unsubscribe = store.subscribe((next: T) => {
    Object.assign(state, next)
  })
  onUnmounted(() => unsubscribe())
  return state
}

/** 首次打开写入示例数据 */
export async function seedDemoData(): Promise<void> {
  const count = await db.trenches.count()
  if (count > 0) return

  await getDeviceId()
  const today = new Date().toISOString().slice(0, 10)

  await db.trenches.bulkPut([
    {
      ...provenanceFor<Trench>('tr_0501'),
      id: 'tr_0501',
      code: 'T0501',
      area: 'Ⅱ区',
      size: '5×5 米',
      basePoint: 'N1200 / E3000',
      openLayer: '第①层',
      startDate: today,
      endDate: '',
      leader: '方铭',
      wallNote: '北壁、东壁保存较好；南壁被现代扰坑破坏',
      backfilled: false
    },
    {
      ...provenanceFor<Trench>('tr_0502'),
      id: 'tr_0502',
      code: 'T0502',
      area: 'Ⅱ区',
      size: '5×5 米',
      basePoint: 'N1205 / E3000',
      openLayer: '第①层',
      startDate: today,
      endDate: today,
      leader: '方铭',
      wallNote: '四壁规整，西壁可见 H12 剖面',
      backfilled: true
    }
  ])

  await db.strata.bulkPut([
    {
      ...provenanceFor<Stratum>('st_0501_l1'),
      id: 'st_0501_l1',
      trenchId: 'tr_0501',
      code: 'L01',
      type: '地层',
      openLayer: '第①层',
      topDepth: 0,
      bottomDepth: 0.25,
      soil: '灰褐色砂质黏土，疏松',
      inclusions: ['陶片', '炭屑'],
      formation: '近现代耕土层',
      date: today,
      drawingNo: 'T0501-北壁-01'
    },
    {
      ...provenanceFor<Stratum>('st_0501_l2'),
      id: 'st_0501_l2',
      trenchId: 'tr_0501',
      code: 'L02',
      type: '地层',
      openLayer: '第②层',
      topDepth: 0.25,
      bottomDepth: 0.6,
      soil: '黄褐色黏土，致密',
      inclusions: ['陶片', '骨'],
      formation: '汉代文化层',
      date: today,
      drawingNo: 'T0501-北壁-02'
    },
    {
      ...provenanceFor<Stratum>('st_0501_h12'),
      id: 'st_0501_h12',
      trenchId: 'tr_0501',
      code: 'H12',
      type: '灰坑',
      openLayer: '第②层下',
      topDepth: 0.6,
      bottomDepth: 1.4,
      soil: '深灰褐土，含大量灰烬',
      inclusions: ['陶片', '骨', '炭屑'],
      formation: '生活垃圾坑',
      date: today,
      drawingNo: 'T0501-H12-平剖面'
    },
    {
      ...provenanceFor<Stratum>('st_0502_l1'),
      id: 'st_0502_l1',
      trenchId: 'tr_0502',
      code: 'L01',
      type: '地层',
      openLayer: '第①层',
      topDepth: 0,
      bottomDepth: 0.3,
      soil: '灰褐色砂质黏土',
      inclusions: ['陶片'],
      formation: '耕土层',
      date: today,
      drawingNo: 'T0502-西壁-01'
    }
  ])

  await db.artifacts.bulkPut([
    {
      ...provenanceFor<Artifact>('af_001'),
      id: 'af_001',
      stratumId: 'st_0501_l2',
      code: 'T0501②:1',
      category: '陶器',
      count: 3,
      completeness: '残片',
      x: 2.4,
      y: 1.8,
      z: 0.42,
      date: today,
      collector: '祁野',
      tempLocation: '工地临时柜 A-2'
    },
    {
      ...provenanceFor<Artifact>('af_002'),
      id: 'af_002',
      stratumId: 'st_0501_h12',
      code: 'T0501H12:1',
      category: '骨器',
      count: 1,
      completeness: '可复原',
      x: 3.1,
      y: 3.6,
      z: 1.05,
      date: today,
      collector: '祁野',
      tempLocation: '工地临时柜 A-3'
    }
  ])

  await db.relations.bulkPut([
    {
      ...provenanceFor<Relation>('rl_001'),
      id: 'rl_001',
      unitAId: 'st_0501_h12',
      type: '打破',
      unitBId: 'st_0501_l2',
      basis: '剖面观察',
      recorder: '方铭',
      note: 'H12 开口于第②层下，打破 L02'
    },
    {
      ...provenanceFor<Relation>('rl_002'),
      id: 'rl_002',
      unitAId: 'st_0501_l1',
      type: '叠压',
      unitBId: 'st_0501_l2',
      basis: '剖面观察',
      recorder: '方铭',
      note: 'L01 叠压 L02，界面清晰'
    }
  ])
}
