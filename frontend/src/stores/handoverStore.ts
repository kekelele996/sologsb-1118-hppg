import { createStore } from 'zustand/vanilla'
import type {
  Artifact,
  DeviceRole,
  HandoverDoc,
  HandoverPackage,
  ImportPreview,
  ItemKind,
  Receipt,
 Relation,
  Stratum,
  Trench
} from '@/types'
import { db, getDeviceRole, setDeviceRole as persistRole, syncPut } from '@/hooks/usePersistentStore'
import { artifactStore } from './artifactStore'
import { relationStore } from './relationStore'
import { stratumStore } from './stratumStore'
import { trenchStore } from './trenchStore'
import {
  applyImport,
  applyReceipt,
  buildHandoverPackage,
  buildReceipt,
  parseHandoverFile,
  parseReceiptFile,
  previewImport,
  type AnyRecord,
  type BuildSelection,
  type Snapshot
} from '@/utils/handover'

interface HandoverState {
  role: DeviceRole | null
  packages: HandoverPackage[]
  receipts: Receipt[]
  loaded: boolean
  hydrate: () => Promise<void>
  setRole: (role: DeviceRole) => Promise<void>
  /** 现场：生成交接单并保存到发件箱 */
  createPackage: (sel: BuildSelection) => Promise<HandoverPackage>
  /** 资料室：导入交接单文件，解析 + 校验 + 预览（不写业务库） */
  previewPackage: (text: string) => Promise<ImportPreview>
  /** 资料室：定稿并生成回执，写入业务库 */
  finalizePackage: (pkgId: string, finalCodes: Map<string, string>, createdBy: string) => Promise<Receipt>
  /** 现场：导入回执文件，采用定稿编号 */
  applyReceiptFile: (text: string) => Promise<{ applied: number; warnings: string[] }>
  removeDoc: (id: string) => Promise<void>
}

function snapshot(): Snapshot {
  return {
    trenches: trenchStore.getState().trenches,
    strata: stratumStore.getState().strata,
    artifacts: artifactStore.getState().artifacts,
    relations: relationStore.getState().relations
  }
}

async function putRecord(kind: ItemKind, record: AnyRecord): Promise<void> {
  if (kind === 'trench') await syncPut<Trench>(db.trenches, record as Trench)
  else if (kind === 'stratum') await syncPut<Stratum>(db.strata, record as Stratum)
  else if (kind === 'artifact') await syncPut<Artifact>(db.artifacts, record as Artifact)
  else await syncPut<Relation>(db.relations, record as Relation)
}

async function refreshAll(): Promise<void> {
  await Promise.all([
    trenchStore.getState().hydrate(),
    stratumStore.getState().hydrate(),
    artifactStore.getState().hydrate(),
    relationStore.getState().hydrate()
  ])
}

export const handoverStore = createStore<HandoverState>((set, get) => ({
  role: null,
  packages: [],
  receipts: [],
  loaded: false,

  hydrate: async () => {
    const role = await getDeviceRole()
    const docs = await db.handovers.toArray()
    const packages = docs.filter((d): d is HandoverPackage => (d as HandoverDoc).kind === 'handover')
    const receipts = docs.filter((d): d is Receipt => (d as HandoverDoc).kind === 'receipt')
    packages.sort((a, b) => b.createdAt - a.createdAt)
    receipts.sort((a, b) => b.createdAt - a.createdAt)
    set({ role, packages, receipts, loaded: true })
  },

  setRole: async (role) => {
    await persistRole(role)
    set({ role })
  },

  createPackage: async (sel) => {
    const side = get().role ?? 'field'
    const pkg = buildHandoverPackage(sel, snapshot(), side)
    await db.handovers.put(pkg)
    await get().hydrate()
    return pkg
  },

  previewPackage: async (text) => {
    const parsed = parseHandoverFile(text)
    if (!parsed.ok || !parsed.doc) throw new Error(parsed.error ?? '交接单解析失败')
    const pkg = parsed.doc
    const preview = previewImport(pkg, snapshot())
    // 保存到收件箱：有校验错误标记 failed，否则标记 received
    const status = preview.errors.length > 0 ? 'failed' : 'received'
    await db.handovers.put({ ...pkg, status })
    await get().hydrate()
    return preview
  },

  finalizePackage: async (pkgId, finalCodes, createdBy) => {
    const docs = await db.handovers.toArray()
    const pkg = docs.find((d): d is HandoverPackage => (d as HandoverDoc).kind === 'handover' && d.id === pkgId)
    if (!pkg) throw new Error('找不到交接单')
    const preview = previewImport(pkg, snapshot())
    if (preview.errors.length > 0) throw new Error(`交接单校验未通过：${preview.errors.join('；')}`)

    const { records, receiptItems } = applyImport(pkg, snapshot(), finalCodes)
    await Promise.all(records.map(({ kind, record }) => putRecord(kind, record)))
    const receipt = buildReceipt(pkg, receiptItems, createdBy)
    await db.handovers.put(receipt)
    await db.handovers.put({ ...pkg, status: 'receipted' })
    await refreshAll()
    await get().hydrate()
    return receipt
  },

  applyReceiptFile: async (text) => {
    const parsed = parseReceiptFile(text)
    if (!parsed.ok || !parsed.doc) throw new Error(parsed.error ?? '回执解析失败')
    const receipt = parsed.doc
    const { updated, warnings } = applyReceipt(receipt, snapshot())
    await Promise.all(updated.map(({ kind, record }) => putRecord(kind, record)))
    await db.handovers.put(receipt)
    // 对应交接单标记为已回执
    const docs = await db.handovers.toArray()
    const pkg = docs.find((d): d is HandoverPackage => (d as HandoverDoc).kind === 'handover' && d.id === receipt.handoverId)
    if (pkg) await db.handovers.put({ ...pkg, status: 'receipted' })
    await refreshAll()
    await get().hydrate()
    return { applied: updated.length, warnings }
  },

  removeDoc: async (id) => {
    await db.handovers.delete(id)
    await get().hydrate()
  }
}))
