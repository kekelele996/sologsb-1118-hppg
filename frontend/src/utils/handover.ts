import type {
  Artifact,
  HandoverItem,
  HandoverPackage,
  ImportPreview,
  ItemKind,
  Receipt,
  ReceiptItem,
  Relation,
  Side,
  Stratum,
  Trench
} from '@/types'
import { uid } from '@/utils/id'

/** 四类记录的业务数据（不含溯源字段） */
export type AnyRecord = Trench | Stratum | Artifact | Relation

/** 两侧数据快照 */
export interface Snapshot {
  trenches: Trench[]
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
}

const PREFIX: Record<ItemKind, string> = { trench: 'tr', stratum: 'st', artifact: 'af', relation: 'rl' }

/** 便于按字段名读写记录（接口无索引签名，经 unknown 转换） */
type Row = Record<string, unknown>

/** 业务字段（参与变更比较；外键字段不参与，始终按现场意见重映射） */
const BUSINESS_FIELDS: Record<ItemKind, string[]> = {
  trench: ['code', 'area', 'size', 'basePoint', 'openLayer', 'startDate', 'endDate', 'leader', 'wallNote', 'backfilled'],
  stratum: ['code', 'type', 'openLayer', 'topDepth', 'bottomDepth', 'soil', 'inclusions', 'formation', 'date', 'drawingNo'],
  artifact: ['code', 'category', 'count', 'completeness', 'x', 'y', 'z', 'date', 'collector', 'tempLocation'],
  relation: ['type', 'basis', 'recorder', 'note']
}

/** 外键字段（交接时按现场意见重映射到资料室本地 id） */
const FK_FIELDS: Record<ItemKind, string[]> = {
  trench: [],
  stratum: ['trenchId'],
  artifact: ['stratumId'],
  relation: ['unitAId', 'unitBId']
}

/** 两边都改动时，听资料室的字段（土质土色 / 定稿编号 / 分类） */
const ARCHIVE_WINS: Record<ItemKind, string[]> = {
  trench: ['code', 'area', 'size', 'basePoint', 'openLayer'],
  stratum: ['code', 'type', 'soil', 'inclusions', 'formation'],
  artifact: ['code', 'category'],
  relation: []
}

function recordsOf(snapshot: Snapshot, kind: ItemKind): AnyRecord[] {
  if (kind === 'trench') return snapshot.trenches
  if (kind === 'stratum') return snapshot.strata
  if (kind === 'artifact') return snapshot.artifacts
  return snapshot.relations
}

function findByOrigin(snapshot: Snapshot, kind: ItemKind, originId: string): AnyRecord | undefined {
  return recordsOf(snapshot, kind).find((item) => item.originId === originId)
}

/** 数组比较（包含物等，顺序无关） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    const sa = [...a].sort()
    const sb = [...b].sort()
    return sa.every((v, i) => v === sb[i])
  }
  return false
}

/** 业务字段是否一致（外键字段不参与比较） */
function businessEqual(a: AnyRecord, b: AnyRecord, kind: ItemKind): boolean {
  return BUSINESS_FIELDS[kind].every((field) => {
    const va = (a as unknown as Row)[field]
    const vb = (b as unknown as Row)[field]
    if (Array.isArray(va) || Array.isArray(vb)) return deepEqual(va, vb)
    return va === vb
  })
}

/** 外键重映射：把现场本地 id 换成资料室本地 id */
function remapFk<T extends AnyRecord>(record: T, kind: ItemKind, localIdMap: Map<string, string>): T {
  const next = { ...record } as unknown as Row
  for (const field of FK_FIELDS[kind]) {
    const value = next[field]
    if (typeof value === 'string' && localIdMap.has(value)) {
      next[field] = localIdMap.get(value)
    }
  }
  return next as T
}

function now(): number {
  return Date.now()
}

// ————— 现场：构造交接单 —————

export interface BuildSelection {
  trenchIds: string[]
  stratumIds: string[]
  artifactIds: string[]
  note: string
  createdBy: string
}

/** 现场把当天记的探方、地层单位、出土物打包成交接单（自动带上关联关系与上级探方） */
export function buildHandoverPackage(sel: BuildSelection, snapshot: Snapshot, side: Side): HandoverPackage {
  const stratumIds = new Set<string>(sel.stratumIds)
  // 触及所选地层单位的层位关系一并交接
  const relIds = new Set<string>()
  snapshot.relations.forEach((r) => {
    if (stratumIds.has(r.unitAId) || stratumIds.has(r.unitBId)) relIds.add(r.id)
  })
  // 关系两端的地层单位都在包内（保证外键可对照）
  relIds.forEach((rid) => {
    const r = snapshot.relations.find((x) => x.id === rid)
    if (r) {
      stratumIds.add(r.unitAId)
      stratumIds.add(r.unitBId)
    }
  })
  // 所选地层单位的出土物
  const artifactIds = new Set<string>(sel.artifactIds)
  snapshot.artifacts.forEach((a) => {
    if (stratumIds.has(a.stratumId)) artifactIds.add(a.id)
  })
  // 所选地层单位的上级探方
  const trenchIds = new Set<string>(sel.trenchIds)
  snapshot.strata.forEach((s) => {
    if (stratumIds.has(s.id)) trenchIds.add(s.trenchId)
  })

  const items: HandoverItem[] = []
  snapshot.trenches.filter((t) => trenchIds.has(t.id)).forEach((t) =>
    items.push({ kind: 'trench', originId: t.originId, originSide: t.originSide, data: t })
  )
  snapshot.strata.filter((s) => stratumIds.has(s.id)).forEach((s) =>
    items.push({ kind: 'stratum', originId: s.originId, originSide: s.originSide, data: s })
  )
  snapshot.artifacts.filter((a) => artifactIds.has(a.id)).forEach((a) =>
    items.push({ kind: 'artifact', originId: a.originId, originSide: a.originSide, data: a })
  )
  snapshot.relations.filter((r) => relIds.has(r.id)).forEach((r) =>
    items.push({ kind: 'relation', originId: r.originId, originSide: r.originSide, data: r })
  )

  return {
    id: uid('ho'),
    kind: 'handover',
    version: 1,
    direction: 'field_to_archive',
    status: 'sent',
    createdAt: now(),
    createdBy: sel.createdBy,
    senderSide: side,
    items,
    note: sel.note
  }
}

// ————— 解析交接文件 —————

export interface ParseResult<T> {
  ok: boolean
  doc?: T
  error?: string
}

export function parseHandoverFile(text: string): ParseResult<HandoverPackage> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件不是有效的 JSON' }
  }
  const obj = json as unknown as Row
  if (obj.kind !== 'handover') return { ok: false, error: '文件不是交接单（kind 应为 handover）' }
  if (obj.version !== 1) return { ok: false, error: `不支持的交接单版本：${String(obj.version)}` }
  if (obj.direction !== 'field_to_archive') return { ok: false, error: '交接单方向不正确' }
  if (!Array.isArray(obj.items) || obj.items.length === 0) return { ok: false, error: '交接单没有条目' }
  for (const [i, raw] of obj.items.entries()) {
    const it = raw as unknown as Row
    if (!it || typeof it.kind !== 'string' || typeof it.originId !== 'string' || !it.data) {
      return { ok: false, error: `第 ${i + 1} 条条目缺少 kind / originId / data` }
    }
  }
  return { ok: true, doc: obj as unknown as HandoverPackage }
}

export function parseReceiptFile(text: string): ParseResult<Receipt> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件不是有效的 JSON' }
  }
  const obj = json as unknown as Row
  if (obj.kind !== 'receipt') return { ok: false, error: '文件不是回执（kind 应为 receipt）' }
  if (obj.version !== 1) return { ok: false, error: `不支持的回执版本：${String(obj.version)}` }
  if (obj.direction !== 'archive_to_field') return { ok: false, error: '回执方向不正确' }
  if (!Array.isArray(obj.items) || obj.items.length === 0) return { ok: false, error: '回执没有条目' }
  for (const [i, raw] of obj.items.entries()) {
    const it = raw as unknown as Row
    if (!it || typeof it.kind !== 'string' || typeof it.originId !== 'string' || typeof it.finalCode !== 'string' || !it.data) {
      return { ok: false, error: `第 ${i + 1} 条回执缺少 kind / originId / finalCode / data` }
    }
  }
  return { ok: true, doc: obj as unknown as Receipt }
}

// ————— 资料室：预览与定稿 —————

/** 解析某探方引用的 originId（用于探方范围内的编号查重） */
function trenchOriginIdOf(trenchId: string, pkg: HandoverPackage, snapshot: Snapshot): string | null {
  const pkgTrench = pkg.items.find((it) => it.kind === 'trench' && (it.data as Trench).id === trenchId)
  if (pkgTrench) return pkgTrench.originId
  const bySource = snapshot.trenches.find((t) => t.sourceLocalId === trenchId)
  if (bySource) return bySource.originId
  const byId = snapshot.trenches.find((t) => t.id === trenchId)
  if (byId) return byId.originId
  return null
}

/** 建议定稿编号：资料室已改过则保留资料室编号；否则用现场号（同范围内已占用则加后缀），资料室可在界面改 */
function suggestFinalCode(
  item: HandoverItem,
  existing: AnyRecord | undefined,
  archiveChanged: boolean,
  snapshot: Snapshot,
  pkg: HandoverPackage
): string {
  if (existing && archiveChanged) return (existing as { code: string }).code
  const code = (item.data as { code: string }).code
  const taken = new Set<string>()
  if (item.kind === 'trench') {
    const area = (item.data as Trench).area.trim()
    snapshot.trenches.filter((t) => t.area.trim() === area).forEach((t) => taken.add(t.code))
    pkg.items
      .filter((it) => it.kind === 'trench' && it !== item && (it.data as Trench).area.trim() === area)
      .forEach((it) => taken.add((it.data as Trench).code))
  } else if (item.kind === 'stratum') {
    const trenchOrigin = trenchOriginIdOf((item.data as Stratum).trenchId, pkg, snapshot)
    snapshot.strata
      .filter((s) => trenchOriginIdOf(s.trenchId, pkg, snapshot) === trenchOrigin)
      .forEach((s) => taken.add(s.code))
    pkg.items
      .filter(
        (it) =>
          it.kind === 'stratum' &&
          it !== item &&
          trenchOriginIdOf((it.data as Stratum).trenchId, pkg, snapshot) === trenchOrigin
      )
      .forEach((it) => taken.add((it.data as Stratum).code))
  } else if (item.kind === 'artifact') {
    snapshot.artifacts.forEach((a) => taken.add(a.code))
    pkg.items.filter((it) => it.kind === 'artifact' && it !== item).forEach((it) => taken.add((it.data as Artifact).code))
  }
  if (!taken.has(code)) return code
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${code}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${code}-${Date.now()}`
}

/** 资料室导入预览：逐条核对、校验、建议定稿编号（不写库） */
export function previewImport(pkg: HandoverPackage, snapshot: Snapshot): ImportPreview {
  const errors: string[] = []
  const resolvable = new Set<string>()
  snapshot.trenches.forEach((t) => resolvable.add(t.sourceLocalId))
  snapshot.strata.forEach((s) => resolvable.add(s.sourceLocalId))
  snapshot.artifacts.forEach((a) => resolvable.add(a.sourceLocalId))
  pkg.items.forEach((it) => resolvable.add((it.data as { id: string }).id))

  const rows: ImportPreview['rows'] = []
  for (const item of pkg.items) {
    const data = item.data as unknown as Row
    const rowErrors: string[] = []
    const code = String(data.code ?? '').trim()
    if (!code) rowErrors.push('编号为空')

    if (item.kind === 'stratum') {
      const trenchId = String(data.trenchId ?? '')
      if (!trenchId) rowErrors.push('缺少所属探方')
      else if (!resolvable.has(trenchId)) rowErrors.push(`所属探方「${trenchId}」在交接单与资料室中都不存在`)
    } else if (item.kind === 'artifact') {
      const stratumId = String(data.stratumId ?? '')
      if (!stratumId) rowErrors.push('缺少所属地层单位')
      else if (!resolvable.has(stratumId)) rowErrors.push(`所属地层单位「${stratumId}」在交接单与资料室中都不存在`)
    } else if (item.kind === 'relation') {
      const unitAId = String(data.unitAId ?? '')
      const unitBId = String(data.unitBId ?? '')
      if (!unitAId || !unitBId) rowErrors.push('关系两端不完整')
      else {
        if (!resolvable.has(unitAId)) rowErrors.push(`单位 A「${unitAId}」不存在`)
        if (!resolvable.has(unitBId)) rowErrors.push(`单位 B「${unitBId}」不存在`)
      }
    }

    const existing = findByOrigin(snapshot, item.kind, item.originId)
    const base = existing?.syncBase ?? null
    const fieldChanged = !base || !businessEqual(item.data as AnyRecord, base as AnyRecord, item.kind)
    const archiveChanged = !base ? false : !businessEqual(existing as AnyRecord, base as AnyRecord, item.kind)
    const conflict = Boolean(existing && fieldChanged && archiveChanged)
    const action: ImportPreview['rows'][number]['action'] = !existing
      ? 'create'
      : fieldChanged
        ? archiveChanged
          ? 'merge'
          : 'merge'
        : 'unchanged'

    const suggestedCode = suggestFinalCode(item, existing, archiveChanged, snapshot, pkg)
    rows.push({
      kind: item.kind,
      originId: item.originId,
      fieldCode: code,
      archiveCode: existing ? String((existing as { code: string }).code) : null,
      suggestedCode,
      exists: Boolean(existing),
      conflict,
      action,
      errors: rowErrors
    })
    rowErrors.forEach((e) => errors.push(`${code || item.originId}：${e}`))
  }

  return {
    package: pkg,
    rows,
    errors,
    counts: {
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'merge' && !r.conflict).length,
      conflict: rows.filter((r) => r.conflict).length,
      unchanged: rows.filter((r) => r.action === 'unchanged').length
    }
  }
}

/** 资料室定稿：按预览结果写入记录，生成回执。finalCodes 可覆盖建议编号。 */
export function applyImport(
  pkg: HandoverPackage,
  snapshot: Snapshot,
  finalCodes: Map<string, string>
): { records: { kind: ItemKind; record: AnyRecord }[]; receiptItems: ReceiptItem[] } {
  const nowTs = now()
  const localIdMap = new Map<string, string>()
  snapshot.trenches.forEach((t) => localIdMap.set(t.sourceLocalId, t.id))
  snapshot.strata.forEach((s) => localIdMap.set(s.sourceLocalId, s.id))
  snapshot.artifacts.forEach((a) => localIdMap.set(a.sourceLocalId, a.id))

  const out: { kind: ItemKind; record: AnyRecord }[] = []
  const receiptItems: ReceiptItem[] = []

  const process = (kind: ItemKind): void => {
    for (const item of pkg.items.filter((it) => it.kind === kind)) {
      const incoming = item.data as AnyRecord
      const existing = findByOrigin(snapshot, kind, item.originId)
      const base = (existing?.syncBase as AnyRecord | null) ?? null
      const inc = remapFk({ ...incoming } as AnyRecord, kind, localIdMap)
      const finalCode = (finalCodes.get(item.originId) ?? (inc as { code: string }).code) as string

      let record: AnyRecord
      if (!existing) {
        const id = uid(PREFIX[kind])
        record = {
          ...(inc as object),
          id,
          originId: item.originId,
          originSide: item.originSide,
          sourceLocalId: (incoming as { id: string }).id,
          aliasCodes: [],
          finalized: true,
          updatedAt: nowTs,
          syncBase: inc
        } as unknown as AnyRecord
      } else {
        const fieldChanged = !base || !businessEqual(incoming, base, kind)
        const archiveChanged = !base ? false : !businessEqual(existing, base, kind)
        const next = { ...(existing as unknown as Row) } as unknown as AnyRecord
        if (fieldChanged && !archiveChanged) {
          // 只有现场改动：采用现场业务数据，保留资料室溯源
          for (const f of BUSINESS_FIELDS[kind]) (next as unknown as Row)[f] = (inc as unknown as Row)[f]
          for (const f of FK_FIELDS[kind]) (next as unknown as Row)[f] = (inc as unknown as Row)[f]
          ;(next as { syncBase: unknown }).syncBase = inc
        } else if (fieldChanged && archiveChanged) {
          // 两边都动过：土质土色 / 编号 / 分类听资料室；深度 / 层位关系 / 测量听现场
          for (const f of BUSINESS_FIELDS[kind]) {
            if (ARCHIVE_WINS[kind].includes(f)) {
              (next as unknown as Row)[f] = (existing as unknown as Row)[f]
            } else {
              (next as unknown as Row)[f] = (inc as unknown as Row)[f]
            }
          }
          for (const f of FK_FIELDS[kind]) (next as unknown as Row)[f] = (inc as unknown as Row)[f]
          ;(next as { syncBase: unknown }).syncBase = inc
        }
        record = next
      }

      // 定稿：采用资料室定稿编号（可被界面改写），实物标签号保留为曾用号；定稿标记不退
      const prevCode = (record as { code: string }).code
      ;(record as { code: string }).code = finalCode
      const alias = new Set((record as { aliasCodes: string[] }).aliasCodes)
      // 资料室曾用号与现场标签号，只要不是当前定稿号都保留（不能把对方那条盖掉）
      if (existing && (existing as { code: string }).code !== finalCode) alias.add((existing as { code: string }).code)
      if ((inc as { code: string }).code !== finalCode) alias.add((inc as { code: string }).code)
      if (prevCode !== finalCode) alias.add(prevCode)
      ;(record as { aliasCodes: string[] }).aliasCodes = [...alias]
      ;(record as { finalized: boolean }).finalized = true
      ;(record as { updatedAt: number }).updatedAt = nowTs

      localIdMap.set((incoming as { id: string }).id, (record as { id: string }).id)
      out.push({ kind, record })
      receiptItems.push({
        kind,
        originId: item.originId,
        finalId: (record as { id: string }).id,
        finalCode: (record as { code: string }).code,
        aliasCodes: (record as { aliasCodes: string[] }).aliasCodes,
        data: record
      })
    }
  }

  process('trench')
  process('stratum')
  process('artifact')
  process('relation')

  return { records: out, receiptItems }
}

/** 生成回执 */
export function buildReceipt(pkg: HandoverPackage, receiptItems: ReceiptItem[], createdBy: string): Receipt {
  return {
    id: uid('rc'),
    kind: 'receipt',
    version: 1,
    handoverId: pkg.id,
    direction: 'archive_to_field',
    status: 'receipted',
    createdAt: now(),
    createdBy,
    items: receiptItems
  }
}

// ————— 现场：导入回执 —————

export interface ReceiptApplyResult {
  updated: { kind: ItemKind; record: AnyRecord }[]
  warnings: string[]
}

/** 现场导入回执：采用定稿编号，实物标签号保留为曾用号，定稿标记不退 */
export function applyReceipt(receipt: Receipt, snapshot: Snapshot): ReceiptApplyResult {
  const updated: { kind: ItemKind; record: AnyRecord }[] = []
  const warnings: string[] = []
  for (const item of receipt.items) {
    const record = findByOrigin(snapshot, item.kind, item.originId)
    if (!record) {
      warnings.push(`回执条目 ${item.finalCode}（${item.originId}）在本机未找到对应记录`)
      continue
    }
    const oldCode = (record as { code: string }).code
    ;(record as { code: string }).code = item.finalCode
    const alias = new Set((record as { aliasCodes: string[] }).aliasCodes)
    if (oldCode && oldCode !== item.finalCode) alias.add(oldCode)
    item.aliasCodes.forEach((c) => alias.add(c))
    ;(record as { aliasCodes: string[] }).aliasCodes = [...alias]
    ;(record as { finalized: boolean }).finalized = true
    ;(record as { syncBase: unknown }).syncBase = item.data
    ;(record as { updatedAt: number }).updatedAt = now()
    updated.push({ kind: item.kind, record })
  }
  return { updated, warnings }
}
