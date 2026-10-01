import { db } from '@/hooks/usePersistentStore'
import type {
  Artifact,
  HandoverPackage,
  HandoffRecord,
  ReceiptItem,
  ReceiptPackage,
  Relation,
  Stratum,
  Trench
} from '@/types'
import { HANDOVER_KIND, RECEIPT_KIND } from '@/types'
import { uid } from '@/utils/id'

/** 交接包候选集：现场按当天记录勾选 */
export interface HandoverSelection {
  trenches: Trench[]
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
}

/** 资料室定稿草稿：只含资料室有权定稿的字段 */
export interface ArchiveDraft {
  trenchCode: string
  stratumCode: string
  stratumSoil: string
  artifactCode: string
}

function countsOf(pkg: HandoverPackage): HandoffRecord['counts'] {
  return {
    trenches: pkg.trenches.length,
    strata: pkg.strata.length,
    artifacts: pkg.artifacts.length,
    relations: pkg.relations.length
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isTrench(value: unknown): value is Trench {
  if (!isObject(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.code === 'string' &&
    typeof row.area === 'string' &&
    isFiniteNumber(row.fieldRev)
  )
}

function isStratum(value: unknown): value is Stratum {
  if (!isObject(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.trenchId === 'string' &&
    typeof row.code === 'string' &&
    isFiniteNumber(row.topDepth) &&
    isFiniteNumber(row.bottomDepth) &&
    isStringArray(row.inclusions) &&
    isFiniteNumber(row.fieldRev)
  )
}

function isArtifact(value: unknown): value is Artifact {
  if (!isObject(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.stratumId === 'string' &&
    typeof row.code === 'string' &&
    isFiniteNumber(row.fieldRev)
  )
}

function isRelation(value: unknown): value is Relation {
  if (!isObject(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.unitAId === 'string' &&
    typeof row.unitBId === 'string' &&
    typeof row.type === 'string' &&
    isFiniteNumber(row.fieldRev)
  )
}

/** 解析并校验交接包，失败返回错误清单（整包不通过，资料室一条不落库） */
export function parseHandover(raw: string): { ok: true; pkg: HandoverPackage } | { ok: false; errors: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, errors: ['文件不是合法 JSON，无法交接'] }
  }
  if (!isObject(parsed)) return { ok: false, errors: ['交接包结构错误：根节点不是对象'] }
  const root = parsed as Record<string, unknown>
  const errors: string[] = []
  if (root.kind !== HANDOVER_KIND) errors.push('不是发掘现场交接包（kind 不匹配）')
  if (typeof root.packageId !== 'string' || !root.packageId) errors.push('缺少交接包号 packageId')
  if (!Array.isArray(root.trenches)) errors.push('探方数据不是数组')
  if (!Array.isArray(root.strata)) errors.push('地层单位数据不是数组')
  if (!Array.isArray(root.artifacts)) errors.push('出土物数据不是数组')
  if (!Array.isArray(root.relations)) errors.push('层位关系数据不是数组')
  if (errors.length > 0) return { ok: false, errors }

  const trenches = (root.trenches as unknown[]).filter(isTrench)
  const strata = (root.strata as unknown[]).filter(isStratum)
  const artifacts = (root.artifacts as unknown[]).filter(isArtifact)
  const relations = (root.relations as unknown[]).filter(isRelation)

  if (trenches.length !== (root.trenches as unknown[]).length) errors.push('存在字段不完整的探方记录')
  if (strata.length !== (root.strata as unknown[]).length) errors.push('存在字段不完整的地层单位记录')
  if (artifacts.length !== (root.artifacts as unknown[]).length) errors.push('存在字段不完整的出土物记录')
  if (relations.length !== (root.relations as unknown[]).length) errors.push('存在字段不完整的层位关系记录')

  // 包内引用完整性：单位必须落在包内探方上，出土物必须挂在包内单位上，关系两端必须都在包内
  const trenchIds = new Set(trenches.map((item) => item.id))
  const stratumIds = new Set(strata.map((item) => item.id))
  strata.forEach((item) => {
    if (!trenchIds.has(item.trenchId)) errors.push(`单位 ${item.code}（${item.id}）所属探方不在交接包内`)
  })
  artifacts.forEach((item) => {
    if (!stratumIds.has(item.stratumId)) errors.push(`出土物 ${item.code}（${item.id}）所属地层单位不在交接包内`)
  })
  relations.forEach((item) => {
    if (!stratumIds.has(item.unitAId) || !stratumIds.has(item.unitBId)) {
      errors.push(`关系 ${item.id} 的单位端点不在交接包内`)
    }
  })

  // 包内主键唯一性
  const dup = (ids: string[], label: string): void => {
    const seen = new Set<string>()
    ids.forEach((id) => {
      if (seen.has(id)) errors.push(`${label}主键重复：${id}`)
      seen.add(id)
    })
  }
  dup(trenches.map((item) => item.id), '探方')
  dup(strata.map((item) => item.id), '地层单位')
  dup(artifacts.map((item) => item.id), '出土物')
  dup(relations.map((item) => item.id), '层位关系')

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    pkg: {
      kind: HANDOVER_KIND,
      packageId: root.packageId as string,
      fromSite: typeof root.fromSite === 'string' ? root.fromSite : '',
      createdAt: typeof root.createdAt === 'string' ? root.createdAt : '',
      note: typeof root.note === 'string' ? root.note : '',
      trenches,
      strata,
      artifacts,
      relations
    }
  }
}

/** 解析回执 */
export function parseReceipt(raw: string): { ok: true; pkg: ReceiptPackage } | { ok: false; errors: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, errors: ['文件不是合法 JSON，无法读取回执'] }
  }
  if (!isObject(parsed)) return { ok: false, errors: ['回执结构错误：根节点不是对象'] }
  const root = parsed as Record<string, unknown>
  const errors: string[] = []
  if (root.kind !== RECEIPT_KIND) errors.push('不是资料室回执（kind 不匹配）')
  if (typeof root.handoverPackageId !== 'string' || !root.handoverPackageId) errors.push('回执缺少原交接包号')
  if (!Array.isArray(root.items)) errors.push('回执 items 不是数组')
  if (errors.length > 0) return { ok: false, errors }
  const items: ReceiptItem[] = []
  ;(root.items as unknown[]).forEach((item) => {
    if (
      isObject(item) &&
      (item.entity === 'trench' || item.entity === 'stratum' || item.entity === 'artifact') &&
      typeof item.id === 'string'
    ) {
      items.push({ entity: item.entity, id: item.id, archiveCode: typeof item.archiveCode === 'string' ? item.archiveCode : '' })
    } else {
      errors.push('回执中存在不合规的定稿项')
    }
  })
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    pkg: {
      kind: RECEIPT_KIND,
      packageId: typeof root.packageId === 'string' && root.packageId ? root.packageId : uid('rc'),
      handoverPackageId: root.handoverPackageId as string,
      toSite: typeof root.toSite === 'string' ? root.toSite : '',
      finalizedAt: typeof root.finalizedAt === 'string' ? root.finalizedAt : '',
      items
    }
  }
}

/**
 * 现场组包：把当天勾选的探方/地层单位/出土物/层位关系打成交接包。
 * 组包同时写入出件箱（pending，失败后留着重试），包号一次生成、重试复用。
 */
export async function createHandover(
  selection: HandoverSelection,
  meta: { fromSite: string; note: string }
): Promise<{ pkg: HandoverPackage; record: HandoffRecord }> {
  const pkg: HandoverPackage = {
    kind: HANDOVER_KIND,
    packageId: uid('ho'),
    fromSite: meta.fromSite.trim(),
    createdAt: new Date().toISOString(),
    note: meta.note.trim(),
    trenches: selection.trenches,
    strata: selection.strata,
    artifacts: selection.artifacts,
    relations: selection.relations
  }
  const record: HandoffRecord = {
    id: pkg.packageId,
    direction: 'handover',
    status: 'pending',
    site: pkg.fromSite,
    note: pkg.note,
    createdAt: pkg.createdAt,
    handoverPackageId: pkg.packageId,
    payload: pkg,
    counts: countsOf(pkg)
  }
  await db.handoffs.put(record)
  return { pkg, record }
}

/** 合并单条：现场字段只在更高 fieldRev 时覆盖；资料室字段（定稿号/定稿土质/定稿态）一律保留 */
function mergeTrench(existing: Trench | undefined, incoming: Trench): Trench {
  if (!existing) {
    return { ...incoming, archiveCode: typeof incoming.archiveCode === 'string' ? incoming.archiveCode : '' }
  }
  const acceptField = incoming.fieldRev >= (existing.fieldRev ?? 1)
  const base = acceptField ? { ...incoming } : { ...existing }
  // 对方那条不能盖掉：资料室定稿号始终保留
  return { ...base, id: existing.id, archiveCode: existing.archiveCode, fieldRev: Math.max(existing.fieldRev ?? 1, incoming.fieldRev) }
}

function mergeStratum(existing: Stratum | undefined, incoming: Stratum): Stratum {
  if (!existing) {
    return {
      ...incoming,
      archiveCode: typeof incoming.archiveCode === 'string' ? incoming.archiveCode : '',
      soilArchive: typeof incoming.soilArchive === 'string' ? incoming.soilArchive : '',
      finalized: false
    }
  }
  const acceptField = incoming.fieldRev >= (existing.fieldRev ?? 1)
  // 深度与层位关系听现场：修订号更高才覆盖；土质土色听资料室：保留资料室定稿值与定稿态
  const base = acceptField ? { ...incoming } : { ...existing }
  return {
    ...base,
    id: existing.id,
    archiveCode: existing.archiveCode,
    soilArchive: existing.soilArchive,
    finalized: existing.finalized,
    fieldRev: Math.max(existing.fieldRev ?? 1, incoming.fieldRev)
  }
}

function mergeArtifact(existing: Artifact | undefined, incoming: Artifact): Artifact {
  if (!existing) {
    return { ...incoming, archiveCode: typeof incoming.archiveCode === 'string' ? incoming.archiveCode : '' }
  }
  const acceptField = incoming.fieldRev >= (existing.fieldRev ?? 1)
  const base = acceptField ? { ...incoming } : { ...existing }
  // 现场器物号早贴在实物上：incoming.code 本来就是现场号；资料室定稿号单独保留，互不覆盖
  return { ...base, id: existing.id, archiveCode: existing.archiveCode, fieldRev: Math.max(existing.fieldRev ?? 1, incoming.fieldRev) }
}

function mergeRelation(existing: Relation | undefined, incoming: Relation): Relation {
  if (!existing) return { ...incoming }
  if (incoming.fieldRev < (existing.fieldRev ?? 1)) return existing
  // 层位关系听现场
  return { ...incoming, id: existing.id, fieldRev: Math.max(existing.fieldRev ?? 1, incoming.fieldRev) }
}

/**
 * 资料室收件：整包事务合并。
 * - 校验失败由调用方在 parseHandover 阶段拦截，不走到这里；
 * - 同号包重投：已收件/已定稿都直接幂等返回，不二次落库；
 * - 定过稿的记录不退：合并时定稿号、定稿土质、finalized 全部保留。
 */
export async function importHandover(pkg: HandoverPackage): Promise<{ merged: boolean; record: HandoffRecord }> {
  const existed = await db.handoffs.get(pkg.packageId)
  if (existed) {
    return { merged: false, record: existed }
  }
  await db.transaction('rw', db.trenches, db.strata, db.artifacts, db.relations, async () => {
    for (const incoming of pkg.trenches) {
      await db.trenches.put(mergeTrench(await db.trenches.get(incoming.id), incoming))
    }
    for (const incoming of pkg.strata) {
      await db.strata.put(mergeStratum(await db.strata.get(incoming.id), incoming))
    }
    for (const incoming of pkg.artifacts) {
      await db.artifacts.put(mergeArtifact(await db.artifacts.get(incoming.id), incoming))
    }
    for (const incoming of pkg.relations) {
      await db.relations.put(mergeRelation(await db.relations.get(incoming.id), incoming))
    }
  })

  const record: HandoffRecord = {
    id: pkg.packageId,
    direction: 'handover',
    status: 'imported',
    site: pkg.fromSite,
    note: pkg.note,
    createdAt: new Date().toISOString(),
    handoverPackageId: pkg.packageId,
    payload: pkg,
    counts: countsOf(pkg)
  }
  await db.handoffs.put(record)
  return { merged: true, record }
}

/** 资料室保存定稿草稿（只写定稿号与定稿土质，未定稿不锁） */
export async function saveArchiveDrafts(
  packageId: string,
  drafts: Map<string, ArchiveDraft>
): Promise<{ updated: number }> {
  const record = await db.handoffs.get(packageId)
  if (!record || record.direction !== 'handover') throw new Error('交接包不存在')
  const pkg = record.payload as HandoverPackage
  let updated = 0
  await db.transaction('rw', db.trenches, db.strata, db.artifacts, async () => {
    for (const incoming of pkg.trenches) {
      const draft = drafts.get(incoming.id)
      if (!draft) continue
      const existing = await db.trenches.get(incoming.id)
      if (!existing) continue
      await db.trenches.put({ ...existing, archiveCode: draft.trenchCode.trim() })
      updated += 1
    }
    for (const incoming of pkg.strata) {
      const draft = drafts.get(incoming.id)
      if (!draft) continue
      const existing = await db.strata.get(incoming.id)
      if (!existing) continue
      await db.strata.put({ ...existing, archiveCode: draft.stratumCode.trim(), soilArchive: draft.stratumSoil.trim() })
      updated += 1
    }
    for (const incoming of pkg.artifacts) {
      const draft = drafts.get(incoming.id)
      if (!draft) continue
      const existing = await db.artifacts.get(incoming.id)
      if (!existing) continue
      await db.artifacts.put({ ...existing, archiveCode: draft.artifactCode.trim() })
      updated += 1
    }
  })
  return { updated }
}

export interface IssueReceiptResult {
  receipt: ReceiptPackage
  record: HandoffRecord
  items: ReceiptItem[]
}

/**
 * 资料室定稿并出回执：
 * - 包内每条探方/单位/出土物都必须有非空定稿号，否则拒绝（给出缺号清单）；
 * - 土质土色以资料室定稿为准写入；单位标记 finalized（定过稿的不退）；
 * - 整包事务，成功后交接箱记录置 finalized。
 */
export async function issueReceipt(packageId: string, drafts: Map<string, ArchiveDraft>, toSite: string): Promise<IssueReceiptResult> {
  const record = await db.handoffs.get(packageId)
  if (!record || record.direction !== 'handover') throw new Error('交接包不存在')
  const pkg = record.payload as HandoverPackage

  const missing: string[] = []
  const codeSeen = new Map<string, string>()
  const requireCode = (entity: ReceiptItem['entity'], id: string, code: string, label: string): void => {
    const trimmed = code.trim()
    if (!trimmed) {
      missing.push(label)
      return
    }
    const key = `${entity}:${trimmed.toUpperCase()}`
    const other = codeSeen.get(key)
    if (other && other !== id) missing.push(`定稿号「${trimmed}」被多条记录共用`)
    codeSeen.set(key, id)
  }

  pkg.trenches.forEach((item) =>
    requireCode('trench', item.id, drafts.get(item.id)?.trenchCode ?? '', `探方现场号 ${item.code}`)
  )
  pkg.strata.forEach((item) => {
    const draft = drafts.get(item.id)
    requireCode('stratum', item.id, draft?.stratumCode ?? '', `单位现场号 ${item.code}`)
    if (draft && !draft.stratumSoil.trim()) missing.push(`单位 ${item.code} 的定稿土质土色为空`)
  })
  pkg.artifacts.forEach((item) =>
    requireCode('artifact', item.id, drafts.get(item.id)?.artifactCode ?? '', `出土物现场号 ${item.code}`)
  )

  // 与资料室库中已有的定稿号冲突（别的交接包已定过，不能重号）
  const [allTrenches, allStrata, allArtifacts] = await Promise.all([
    db.trenches.toArray(),
    db.strata.toArray(),
    db.artifacts.toArray()
  ])
  const packageIds = {
    trenches: new Set(pkg.trenches.map((item) => item.id)),
    strata: new Set(pkg.strata.map((item) => item.id)),
    artifacts: new Set(pkg.artifacts.map((item) => item.id))
  }
  const trenchCodes = new Set(
    pkg.trenches.map((item) => drafts.get(item.id)?.trenchCode.trim().toUpperCase() ?? '').filter(Boolean)
  )
  const stratumCodes = new Set(
    pkg.strata.map((item) => drafts.get(item.id)?.stratumCode.trim().toUpperCase() ?? '').filter(Boolean)
  )
  const artifactCodes = new Set(
    pkg.artifacts.map((item) => drafts.get(item.id)?.artifactCode.trim().toUpperCase() ?? '').filter(Boolean)
  )

  allTrenches.forEach((row) => {
    const used = row.archiveCode.trim().toUpperCase()
    if (used && !packageIds.trenches.has(row.id) && trenchCodes.has(used)) {
      missing.push(`探方定稿号「${row.archiveCode}」已被已定稿探方 ${row.code} 占用`)
    }
  })
  allStrata.forEach((row) => {
    const used = row.archiveCode.trim().toUpperCase()
    if (used && !packageIds.strata.has(row.id) && stratumCodes.has(used)) {
      missing.push(`单位定稿号「${row.archiveCode}」已被已定稿单位 ${row.code} 占用`)
    }
  })
  allArtifacts.forEach((row) => {
    const used = row.archiveCode.trim().toUpperCase()
    if (used && !packageIds.artifacts.has(row.id) && artifactCodes.has(used)) {
      missing.push(`出土物定稿号「${row.archiveCode}」已被已定稿出土物 ${row.code} 占用`)
    }
  })

  if (missing.length > 0) {
    throw new Error(`还差定稿信息不能出回执：${Array.from(new Set(missing)).join('；')}`)
  }

  const items: ReceiptItem[] = []

  await db.transaction('rw', db.trenches, db.strata, db.artifacts, db.handoffs, async () => {
    for (const incoming of pkg.trenches) {
      const draft = drafts.get(incoming.id)!
      const existing = await db.trenches.get(incoming.id)
      if (existing) await db.trenches.put({ ...existing, archiveCode: draft.trenchCode.trim() })
      items.push({ entity: 'trench', id: incoming.id, archiveCode: draft.trenchCode.trim() })
    }
    for (const incoming of pkg.strata) {
      const draft = drafts.get(incoming.id)!
      const existing = await db.strata.get(incoming.id)
      if (existing) {
        await db.strata.put({
          ...existing,
          archiveCode: draft.stratumCode.trim(),
          soilArchive: draft.stratumSoil.trim(),
          finalized: true
        })
      }
      items.push({ entity: 'stratum', id: incoming.id, archiveCode: draft.stratumCode.trim() })
    }
    for (const incoming of pkg.artifacts) {
      const draft = drafts.get(incoming.id)!
      const existing = await db.artifacts.get(incoming.id)
      if (existing) await db.artifacts.put({ ...existing, archiveCode: draft.artifactCode.trim() })
      items.push({ entity: 'artifact', id: incoming.id, archiveCode: draft.artifactCode.trim() })
    }
  })

  const receipt: ReceiptPackage = {
    kind: RECEIPT_KIND,
    packageId: uid('rc'),
    handoverPackageId: pkg.packageId,
    toSite: toSite.trim(),
    finalizedAt: new Date().toISOString(),
    items
  }
  const updated: HandoffRecord = { ...record, status: 'finalized' }
  await db.handoffs.put(updated)
  const receiptRecord: HandoffRecord = {
    id: receipt.packageId,
    direction: 'receipt',
    status: 'finalized',
    site: toSite.trim(),
    note: `回执：${pkg.note || pkg.packageId}`,
    createdAt: receipt.finalizedAt,
    handoverPackageId: pkg.packageId,
    payload: receipt,
    counts: record.counts
  }
  await db.handoffs.put(receiptRecord)
  return { receipt, record: updated, items }
}

export interface ApplyReceiptResult {
  applied: boolean
  updated: number
  record: HandoffRecord
}

/**
 * 现场收回执：只回填资料室定稿号 archiveCode，现场号 code 一律不动。
 * - 同号回执重投：幂等，不重复写；
 * - 对应交接包若还在出件箱，置 receipted（已闭环）。
 */
export async function applyReceipt(receipt: ReceiptPackage): Promise<ApplyReceiptResult> {
  const existed = await db.handoffs.get(receipt.packageId)
  if (existed) {
    return { applied: false, updated: 0, record: existed }
  }
  let updated = 0
  await db.transaction('rw', db.trenches, db.strata, db.artifacts, db.handoffs, async () => {
    for (const item of receipt.items) {
      if (item.entity === 'trench') {
        const row = await db.trenches.get(item.id)
        if (row && row.archiveCode !== item.archiveCode) {
          await db.trenches.put({ ...row, archiveCode: item.archiveCode })
          updated += 1
        }
      } else if (item.entity === 'stratum') {
        const row = await db.strata.get(item.id)
        if (row && row.archiveCode !== item.archiveCode) {
          await db.strata.put({ ...row, archiveCode: item.archiveCode })
          updated += 1
        }
      } else {
        const row = await db.artifacts.get(item.id)
        if (row && row.archiveCode !== item.archiveCode) {
          await db.artifacts.put({ ...row, archiveCode: item.archiveCode })
          updated += 1
        }
      }
    }
    const outbox = await db.handoffs.get(receipt.handoverPackageId)
    if (outbox && outbox.direction === 'handover' && outbox.status === 'pending') {
      await db.handoffs.put({ ...outbox, status: 'receipted' })
    }
  })

  const record: HandoffRecord = {
    id: receipt.packageId,
    direction: 'receipt',
    status: 'receipted',
    site: receipt.toSite,
    note: `收到回执（交接包 ${receipt.handoverPackageId.slice(-6)}）`,
    createdAt: new Date().toISOString(),
    handoverPackageId: receipt.handoverPackageId,
    payload: receipt,
    counts: { trenches: 0, strata: 0, artifacts: 0, relations: 0 }
  }
  await db.handoffs.put(record)
  return { applied: true, updated, record }
}

/** 交接箱列表（现场看出件箱 handover；资料室看收件箱 handover + 已发回执 receipt） */
export async function listHandoffs(direction: 'handover' | 'receipt' | 'all'): Promise<HandoffRecord[]> {
  const rows = await db.handoffs.toArray()
  const filtered = direction === 'all' ? rows : rows.filter((item) => item.direction === direction)
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** 从交接箱记录取回原始包（重试导出） */
export function packageOfRecord(record: HandoffRecord): HandoverPackage | ReceiptPackage {
  return record.payload
}
