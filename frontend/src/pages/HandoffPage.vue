<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type {
  Artifact,
  HandoffRecord,
  HandoverPackage,
  ReceiptPackage,
  Relation,
  Stratum,
  Trench
} from '@/types'
import { effectiveCode } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { usePartyRole } from '@/hooks/usePartyRole'
import { trenchStore } from '@/stores/trenchStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { handoffStore } from '@/stores/handoffStore'
import {
  applyReceipt,
  createHandover,
  importHandover,
  issueReceipt,
  parseHandover,
  parseReceipt,
  saveArchiveDrafts,
  type ArchiveDraft
} from '@/utils/handoff'
import { downloadJson, pickTextFile } from '@/utils/export'

const { role, setRole } = usePartyRole()
const trenchState = useStore(trenchStore)
const stratumState = useStore(stratumStore)
const artifactState = useStore(artifactStore)
const relationState = useStore(relationStore)
const handoffState = useStore(handoffStore)

async function refreshAll(): Promise<void> {
  await Promise.all([
    trenchStore.getState().hydrate(),
    stratumStore.getState().hydrate(),
    artifactStore.getState().hydrate(),
    relationStore.getState().hydrate(),
    handoffStore.getState().hydrate()
  ])
}

/* ------------------------------ 通用 ------------------------------ */

const today = new Date().toISOString().slice(0, 10)

function safeName(text: string): string {
  return (text || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30) || '未命名'
}

function statusTag(status: HandoffRecord['status']): { label: string; type: 'success' | 'warning' | 'info' } {
  switch (status) {
    case 'pending':
      return { label: '待回执 · 失败可重试导出', type: 'warning' }
    case 'receipted':
      return { label: '已收回执 · 闭环', type: 'success' }
    case 'imported':
      return { label: '已收件 · 待定稿', type: 'info' }
    case 'finalized':
      return { label: '已定稿 · 不退', type: 'success' }
  }
}

function countsText(record: HandoffRecord): string {
  const c = record.counts
  return `探方 ${c.trenches} · 单位 ${c.strata} · 出土物 ${c.artifacts} · 关系 ${c.relations}`
}

function downloadHandover(pkg: HandoverPackage): void {
  downloadJson(`交接包_${safeName(pkg.note || pkg.fromSite || pkg.packageId.slice(-6))}_${pkg.createdAt.slice(0, 10)}.json`, pkg)
}

function downloadReceipt(pkg: ReceiptPackage): void {
  downloadJson(`回执_${pkg.handoverPackageId.slice(-6)}_${pkg.finalizedAt.slice(0, 10)}.json`, pkg)
}

/* ------------------------------ 现场：组包 ------------------------------ */

const fieldSite = ref(localStorage.getItem('gbtrenchlog.siteName') || '发掘现场')
const handoverDate = ref(today)
const handoverNote = ref('')

const selectedStrata = ref<Stratum[]>([])
const selectedArtifacts = ref<Artifact[]>([])
const selectedTrenches = ref<Trench[]>([])

const strataTableRef = ref<{ toggleRowSelection: (row: Stratum, selected: boolean) => void } | null>(null)
const artifactTableRef = ref<{ toggleRowSelection: (row: Artifact, selected: boolean) => void } | null>(null)
const trenchTableRef = ref<{ toggleRowSelection: (row: Trench, selected: boolean) => void } | null>(null)

const candidateStrata = computed(() => stratumState.strata.filter((item) => item.date === handoverDate.value))
const candidateArtifacts = computed(() => artifactState.artifacts.filter((item) => item.date === handoverDate.value))
const candidateTrenches = computed(() =>
  trenchState.trenches.filter((item) => item.startDate === handoverDate.value || item.endDate === handoverDate.value)
)

/** 选中出土物的所属单位：即便单位不是当天新建，也随包带出，保证「出土物→单位」引用完整 */
const attachedStrata = computed<Stratum[]>(() => {
  const selectedIds = new Set(selectedStrata.value.map((item) => item.id))
  const ids = Array.from(new Set(selectedArtifacts.value.map((item) => item.stratumId)))
  return stratumState.strata.filter((item) => ids.includes(item.id) && !selectedIds.has(item.id))
})

/** 随包单位（勾选 + 自动带出）的所属探方：即便探方不是当天新建，也随包带出 */
const attachedTrenches = computed<Trench[]>(() => {
  const ids = new Set([...selectedStrata.value, ...attachedStrata.value].map((item) => item.trenchId))
  const selectedIds = new Set(selectedTrenches.value.map((item) => item.id))
  return trenchState.trenches.filter((item) => ids.has(item.id) && !selectedIds.has(item.id))
})

/** 层位关系两端都在随包单位里才随包走（层位关系听现场） */
const attachedRelations = computed<Relation[]>(() => {
  const ids = new Set([...selectedStrata.value, ...attachedStrata.value].map((item) => item.id))
  return relationState.relations.filter((item) => ids.has(item.unitAId) && ids.has(item.unitBId))
})

/** 切日期/首次进页时，默认把当天候选全部勾上，用户可手动取消 */
const initializedDates = new Set<string>()
async function selectAllByDate(): Promise<void> {
  await nextTick()
  candidateStrata.value.forEach((row) => strataTableRef.value?.toggleRowSelection(row, true))
  candidateArtifacts.value.forEach((row) => artifactTableRef.value?.toggleRowSelection(row, true))
  candidateTrenches.value.forEach((row) => trenchTableRef.value?.toggleRowSelection(row, true))
}
watch(
  [candidateStrata, candidateArtifacts, candidateTrenches],
  () => {
    if (initializedDates.has(handoverDate.value)) return
    if (candidateStrata.value.length + candidateArtifacts.value.length + candidateTrenches.value.length === 0) return
    initializedDates.add(handoverDate.value)
    void selectAllByDate()
  },
  { immediate: true }
)

function onDateChange(): void {
  selectedStrata.value = []
  selectedArtifacts.value = []
  selectedTrenches.value = []
  if (!initializedDates.has(handoverDate.value)) void selectAllByDate()
}

const outboxRecords = computed(() => handoffState.records.filter((item) => item.direction === 'handover' && 'packageId' in item.payload))

function unitLabel(id: string): string {
  return stratumState.strata.find((item) => item.id === id)?.code ?? id
}

async function generateHandover(): Promise<void> {
  if (
    selectedStrata.value.length === 0 &&
    selectedArtifacts.value.length === 0 &&
    selectedTrenches.value.length === 0 &&
    attachedStrata.value.length === 0 &&
    attachedTrenches.value.length === 0
  ) {
    ElMessage.warning('当天没有可交接的记录，请先在各编目页登记，或勾选要交出的条目')
    return
  }
  localStorage.setItem('gbtrenchlog.siteName', fieldSite.value.trim())
  const { pkg } = await createHandover(
    {
      trenches: [...selectedTrenches.value, ...attachedTrenches.value],
      strata: [...selectedStrata.value, ...attachedStrata.value],
      artifacts: selectedArtifacts.value,
      relations: attachedRelations.value
    },
    { fromSite: fieldSite.value, note: handoverNote.value }
  )
  downloadHandover(pkg)
  await refreshAll()
  ElMessage.success(
    `交接包已生成并保存到出件箱（${pkg.trenches.length} 探方 / ${pkg.strata.length} 单位 / ${pkg.artifacts.length} 出土物 / ${pkg.relations.length} 关系）。交接失败可在下方出件箱重新导出，包号不变。`
  )
}

async function retryExport(record: HandoffRecord): Promise<void> {
  downloadHandover(record.payload as HandoverPackage)
  ElMessage.success('交接包已重新导出（与原包同号，资料室按幂等收件）')
}

async function importReceiptFile(): Promise<void> {
  const raw = await pickTextFile().catch(() => null)
  if (!raw) return
  const parsed = parseReceipt(raw)
  if (!parsed.ok) {
    ElMessage.error(`回执读取失败，现场数据未改动：${parsed.errors.join('；')}`)
    return
  }
  const result = await applyReceipt(parsed.pkg)
  await refreshAll()
  if (!result.applied) {
    ElMessage.info('该回执此前已收过，按幂等处理，未重复回填')
    return
  }
  ElMessage.success(`回执已收：回填 ${result.updated} 条资料室定稿号；现场号原样保留未动`)
}

/* ------------------------------ 资料室：收件 ------------------------------ */

const lastImportErrors = ref<string[]>([])

async function importHandoverFile(): Promise<void> {
  const raw = await pickTextFile().catch(() => null)
  if (!raw) return
  lastImportErrors.value = []
  const parsed = parseHandover(raw)
  if (!parsed.ok) {
    // 交接失败：资料室一条不落库
    lastImportErrors.value = parsed.errors
    ElMessage.error(`交接包校验失败，整包拒收、资料未改动：${parsed.errors.length} 处问题`)
    return
  }
  const result = await importHandover(parsed.pkg)
  await refreshAll()
  if (!result.merged) {
    ElMessage.info('该交接包此前已收过（同包号），按幂等处理，未重复合并')
    return
  }
  ElMessage.success(`收件成功：${countsText(result.record)}。现场字段已按修订号合并，资料室已定稿内容原样保留`)
}

const inboxRecords = computed(() =>
  handoffState.records.filter((item) => item.direction === 'handover').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
)
const receiptRecords = computed(() => handoffState.records.filter((item) => item.direction === 'receipt'))

function receiptOf(handoverPackageId: string): ReceiptPackage | null {
  const row = receiptRecords.value.find((item) => item.handoverPackageId === handoverPackageId)
  return row ? (row.payload as ReceiptPackage) : null
}

/* ---------------------- 资料室：定稿编号对话框 ---------------------- */

const finalizeVisible = ref(false)
const finalizePackageId = ref('')
const finalizePkg = ref<HandoverPackage | null>(null)
const toSite = ref(localStorage.getItem('gbtrenchlog.archiveName') || '资料室')

const draftTrenchCode = reactive<Record<string, string>>({})
const draftStratumCode = reactive<Record<string, string>>({})
const draftStratumSoil = reactive<Record<string, string>>({})
const draftArtifactCode = reactive<Record<string, string>>({})

function openFinalize(record: HandoffRecord): void {
  const pkg = record.payload as HandoverPackage
  finalizePackageId.value = record.id
  finalizePkg.value = pkg
  Object.keys(draftTrenchCode).forEach((key) => delete draftTrenchCode[key])
  Object.keys(draftStratumCode).forEach((key) => delete draftStratumCode[key])
  Object.keys(draftStratumSoil).forEach((key) => delete draftStratumSoil[key])
  Object.keys(draftArtifactCode).forEach((key) => delete draftArtifactCode[key])
  pkg.trenches.forEach((item) => {
    const current = trenchState.trenches.find((row) => row.id === item.id)
    draftTrenchCode[item.id] = current?.archiveCode ?? ''
  })
  pkg.strata.forEach((item) => {
    const current = stratumState.strata.find((row) => row.id === item.id)
    draftStratumCode[item.id] = current?.archiveCode ?? ''
    draftStratumSoil[item.id] = current?.soilArchive ?? item.soil ?? ''
  })
  pkg.artifacts.forEach((item) => {
    const current = artifactState.artifacts.find((row) => row.id === item.id)
    draftArtifactCode[item.id] = current?.archiveCode ?? ''
  })
  finalizeVisible.value = true
}

function collectDrafts(): Map<string, ArchiveDraft> {
  const drafts = new Map<string, ArchiveDraft>()
  finalizePkg.value?.strata.forEach((item) => {
    drafts.set(item.id, {
      trenchCode: '',
      stratumCode: draftStratumCode[item.id] ?? '',
      stratumSoil: draftStratumSoil[item.id] ?? '',
      artifactCode: ''
    })
  })
  finalizePkg.value?.trenches.forEach((item) => {
    const existing = drafts.get(item.id)
    drafts.set(item.id, {
      trenchCode: draftTrenchCode[item.id] ?? '',
      stratumCode: existing?.stratumCode ?? '',
      stratumSoil: existing?.stratumSoil ?? '',
      artifactCode: existing?.artifactCode ?? ''
    })
  })
  finalizePkg.value?.artifacts.forEach((item) => {
    const existing = drafts.get(item.id)
    drafts.set(item.id, {
      trenchCode: existing?.trenchCode ?? '',
      stratumCode: existing?.stratumCode ?? '',
      stratumSoil: existing?.stratumSoil ?? '',
      artifactCode: draftArtifactCode[item.id] ?? ''
    })
  })
  return drafts
}

async function saveDrafts(): Promise<void> {
  if (!finalizePkg.value) return
  const { updated } = await saveArchiveDrafts(finalizePackageId.value, collectDrafts())
  await refreshAll()
  ElMessage.success(`定稿草稿已暂存 ${updated} 条（未定稿不锁，仍可继续改）`)
}

async function finalizeAndReceipt(): Promise<void> {
  if (!finalizePkg.value) return
  localStorage.setItem('gbtrenchlog.archiveName', toSite.value.trim())
  try {
    const { receipt } = await issueReceipt(finalizePackageId.value, collectDrafts(), toSite.value)
    downloadReceipt(receipt)
    await refreshAll()
    finalizeVisible.value = false
    ElMessage.success(`已定稿 ${receipt.items.length} 条并生成回执（定稿后不退）。请把回执文件交回现场。`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '定稿失败')
  }
}

function stratumRow(id: string): Stratum | undefined {
  return stratumState.strata.find((item) => item.id === id)
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">现场 ⇄ 资料室交接</h2>
        <p class="page-sub">
          跨侧只认稳定 id、不认手写编号：现场号留在实物上不动，资料室定稿号随回执回填；深度与层位关系听现场，土质土色听资料室。交接失败整包拒收、现场留件重试；资料室定稿不退。
        </p>
      </div>
      <el-radio-group :model-value="role" @update:model-value="(value: 'field' | 'archive') => setRole(value)">
        <el-radio-button value="field">发掘现场端</el-radio-button>
        <el-radio-button value="archive">资料室端</el-radio-button>
      </el-radio-group>
    </div>

    <!-- ============================ 现场端 ============================ -->
    <template v-if="role === 'field'">
      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>① 组当天交接包（探方 · 地层单位 · 出土物 · 层位关系）</span>
            <el-tag type="warning" effect="plain">土质土色以资料室回执定稿为准；深度/层位以本包为准</el-tag>
          </div>
        </template>
        <div class="gen-bar">
          <el-input v-model="fieldSite" placeholder="现场名称" style="width: 160px" />
          <el-date-picker v-model="handoverDate" type="date" value-format="YYYY-MM-DD" :clearable="false" @change="onDateChange" />
          <el-input v-model="handoverNote" placeholder="交接附言，如 Ⅱ区 10 月 1 日" style="width: 260px" />
          <el-button type="primary" @click="generateHandover">
            <el-icon><Promotion /></el-icon>生成交接包并导出
          </el-button>
        </div>

        <el-alert
          :title="`当天（${handoverDate}）候选：地层单位 ${candidateStrata.length}、出土物 ${candidateArtifacts.length}、探方 ${candidateTrenches.length}；随出土物自动带出单位 ${attachedStrata.length} 个、随单位带出探方 ${attachedTrenches.length} 个、层位关系 ${attachedRelations.length} 条`"
          type="info"
          :closable="false"
          show-icon
          class="mini-alert"
        />

        <h4 class="group-title">当天记的地层单位（勾选交出）</h4>
        <el-table
          ref="strataTableRef"
          :data="candidateStrata"
          border
          size="small"
          row-key="id"
          max-height="220"
          @selection-change="(rows: Stratum[]) => (selectedStrata = rows)"
        >
          <el-table-column type="selection" width="46" reserve-selection />
          <el-table-column label="现场单位号" width="120">
            <template #default="{ row }: { row: Stratum }">
              <span class="mono">{{ row.code }}</span>
              <el-tag v-if="row.archiveCode" size="small" type="success" effect="plain" class="mini">定稿 {{ effectiveCode(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="类型" prop="type" width="80" />
          <el-table-column label="深度(m)" width="110">
            <template #default="{ row }: { row: Stratum }">{{ row.topDepth }}–{{ row.bottomDepth }}</template>
          </el-table-column>
          <el-table-column label="土质土色（现场记录）" prop="soil" show-overflow-tooltip />
          <el-table-column label="修订号" prop="fieldRev" width="70" />
        </el-table>

        <h4 class="group-title">当天记的出土物（勾选交出）</h4>
        <el-table
          ref="artifactTableRef"
          :data="candidateArtifacts"
          border
          size="small"
          row-key="id"
          max-height="200"
          @selection-change="(rows: Artifact[]) => (selectedArtifacts = rows)"
        >
          <el-table-column type="selection" width="46" reserve-selection />
          <el-table-column label="现场器物号（贴在实物上）" prop="code" width="200" />
          <el-table-column label="类别" prop="category" width="80" />
          <el-table-column label="件数" prop="count" width="60" />
          <el-table-column label="Z 深度(m)" prop="z" width="90" />
          <el-table-column label="资料室定稿号" width="140">
            <template #default="{ row }: { row: Artifact }">
              <span v-if="row.archiveCode" class="mono">{{ row.archiveCode }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>

        <h4 class="group-title">当天记的探方（勾选交出）</h4>
        <el-table
          ref="trenchTableRef"
          :data="candidateTrenches"
          border
          size="small"
          row-key="id"
          max-height="160"
          @selection-change="(rows: Trench[]) => (selectedTrenches = rows)"
        >
          <el-table-column type="selection" width="46" reserve-selection />
          <el-table-column label="现场探方号" prop="code" width="130" />
          <el-table-column label="发掘区" prop="area" width="100" />
          <el-table-column label="资料室定稿号" width="140">
            <template #default="{ row }: { row: Trench }">{{ row.archiveCode || '—' }}</template>
          </el-table-column>
          <el-table-column label="负责人" prop="leader" />
        </el-table>

        <div v-if="attachedStrata.length > 0 || attachedTrenches.length > 0 || attachedRelations.length > 0" class="auto-attached">
          <p v-if="attachedStrata.length > 0" class="muted">
            随选中出土物自动带出所属单位：{{ attachedStrata.map((item) => item.code).join('、') }}
          </p>
          <p v-if="attachedTrenches.length > 0" class="muted">
            随选中单位自动带出探方：{{ attachedTrenches.map((item) => item.code).join('、') }}
          </p>
          <p v-if="attachedRelations.length > 0" class="muted">
            随选中单位自动带出层位关系：
            <span v-for="(relation, index) in attachedRelations" :key="relation.id">
              {{ unitLabel(relation.unitAId) }} {{ relation.type }} {{ unitLabel(relation.unitBId) }}<template v-if="index < attachedRelations.length - 1">；</template>
            </span>
          </p>
        </div>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>② 出件箱（交接失败留着重试，包号不变）</span>
            <el-button type="primary" plain @click="importReceiptFile">
              <el-icon><Download /></el-icon>导入资料室回执
            </el-button>
          </div>
        </template>
        <el-table :data="outboxRecords" border size="small" row-key="id">
          <el-table-column label="状态" width="180">
            <template #default="{ row }: { row: HandoffRecord }">
              <el-tag :type="statusTag(row.status).type" size="small" effect="dark">{{ statusTag(row.status).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="附言" prop="note" min-width="160" show-overflow-tooltip />
          <el-table-column label="内容" min-width="260">
            <template #default="{ row }: { row: HandoffRecord }">{{ countsText(row) }}</template>
          </el-table-column>
          <el-table-column label="生成时间" width="170">
            <template #default="{ row }: { row: HandoffRecord }">{{ row.createdAt.replace('T', ' ').slice(0, 16) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="160">
            <template #default="{ row }: { row: HandoffRecord }">
              <el-button link type="primary" size="small" @click="retryExport(row)">重新导出交接包</el-button>
            </template>
          </el-table-column>
          <template #empty>出件箱为空，先在上方生成当天交接包</template>
        </el-table>
      </el-card>
    </template>

    <!-- ============================ 资料室端 ============================ -->
    <template v-else>
      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>① 接收现场交接包</span>
            <el-input v-model="toSite" placeholder="资料室名称" style="width: 160px" />
          </div>
        </template>
        <el-result
          v-if="lastImportErrors.length > 0"
          icon="error"
          title="交接失败：整包拒收，资料室一条未落库"
          :sub-title="`共 ${lastImportErrors.length} 处问题，退回现场修正后用原包重投`"
        >
          <template #extra>
            <ul class="error-list">
              <li v-for="(item, index) in lastImportErrors" :key="index">{{ item }}</li>
            </ul>
          </template>
        </el-result>
        <el-button type="primary" size="large" @click="importHandoverFile">
          <el-icon><Upload /></el-icon>选择交接包 JSON 收件
        </el-button>
        <p class="muted hint">校验内容：包格式、四类记录字段完整、包内主键唯一、单位→探方/出土物→单位/关系两端引用完整。任何一项不过即整包拒收。</p>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>② 收件箱：按资料室规矩定稿编号，出回执</template>
        <el-table :data="inboxRecords" border size="small" row-key="id">
          <el-table-column label="状态" width="150">
            <template #default="{ row }: { row: HandoffRecord }">
              <el-tag :type="statusTag(row.status).type" size="small" effect="dark">{{ statusTag(row.status).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="来自" prop="site" width="100" />
          <el-table-column label="附言" prop="note" min-width="140" show-overflow-tooltip />
          <el-table-column label="内容" min-width="240">
            <template #default="{ row }: { row: HandoffRecord }">{{ countsText(row) }}</template>
          </el-table-column>
          <el-table-column label="收件时间" width="170">
            <template #default="{ row }: { row: HandoffRecord }">{{ row.createdAt.replace('T', ' ').slice(0, 16) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="220">
            <template #default="{ row }: { row: HandoffRecord }">
              <el-button v-if="row.status === 'imported'" link type="primary" size="small" @click="openFinalize(row)">
                定稿编号
              </el-button>
              <el-button v-if="row.status === 'finalized'" link type="primary" size="small" @click="openFinalize(row)">
                查看定稿
              </el-button>
              <el-button
                v-if="row.status === 'finalized' && receiptOf(row.id)"
                link
                type="success"
                size="small"
                @click="downloadReceipt(receiptOf(row.id)!)"
              >
                重新导出回执
              </el-button>
            </template>
          </el-table-column>
          <template #empty>收件箱为空，请选择现场交来的交接包 JSON</template>
        </el-table>
      </el-card>
    </template>

    <!-- ===================== 资料室定稿对话框 ===================== -->
    <el-dialog v-model="finalizeVisible" title="资料室定稿编号" width="900px" top="6vh">
      <div v-if="finalizePkg">
        <el-alert
          title="定稿规则：定稿号按资料室规矩编号；土质土色以资料室定稿为准。现场号与现场深度/层位关系在左侧对照，不会被覆盖。"
          type="info"
          :closable="false"
          show-icon
          class="mini-alert"
        />

        <h4 class="group-title">探方定稿号（{{ finalizePkg.trenches.length }}）</h4>
        <el-table :data="finalizePkg.trenches" border size="small" max-height="180">
          <el-table-column label="现场号" width="140">
            <template #default="{ row }: { row: Trench }"><span class="mono">{{ row.area }} · {{ row.code }}</span></template>
          </el-table-column>
          <el-table-column label="资料室定稿号">
            <template #default="{ row }: { row: Trench }">
              <el-input v-model="draftTrenchCode[row.id]" :placeholder="`如 总-${row.code}`" size="small" />
            </template>
          </el-table-column>
        </el-table>

        <h4 class="group-title">地层单位定稿号 + 定稿土质土色（{{ finalizePkg.strata.length }}）</h4>
        <el-table :data="finalizePkg.strata" border size="small" max-height="260">
          <el-table-column label="现场号" width="100">
            <template #default="{ row }: { row: Stratum }"><span class="mono">{{ row.code }}</span></template>
          </el-table-column>
          <el-table-column label="深度(m)/层位（现场，只读）" width="170">
            <template #default="{ row }: { row: Stratum }">
              <div>{{ row.topDepth }}–{{ row.bottomDepth }} · {{ row.openLayer }}</div>
              <el-tag v-if="stratumRow(row.id)?.finalized" size="small" type="success" effect="plain" class="mini">已定稿不退</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="定稿单位号" width="170">
            <template #default="{ row }: { row: Stratum }">
              <el-input v-model="draftStratumCode[row.id]" :placeholder="`如 Ⅱ-${row.code}`" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="土质土色（资料室定稿）" min-width="220">
            <template #default="{ row }: { row: Stratum }">
              <el-input
                v-model="draftStratumSoil[row.id]"
                type="textarea"
                :rows="2"
                size="small"
                :placeholder="`现场原记：${row.soil || '空'}`"
              />
            </template>
          </el-table-column>
        </el-table>

        <h4 class="group-title">出土物定稿号（{{ finalizePkg.artifacts.length }}）</h4>
        <el-table :data="finalizePkg.artifacts" border size="small" max-height="220">
          <el-table-column label="现场器物号（实物标签，不动）" prop="code" width="220" />
          <el-table-column label="资料室定稿号">
            <template #default="{ row }: { row: Artifact }">
              <el-input v-model="draftArtifactCode[row.id]" :placeholder="`如 馆藏-${row.code}`" size="small" />
            </template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer>
        <el-button @click="finalizeVisible = false">关闭</el-button>
        <el-button @click="saveDrafts">暂存草稿（不定稿）</el-button>
        <el-button type="primary" @click="finalizeAndReceipt">定稿并导出回执</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.block {
  margin-bottom: 16px;
  border-radius: 12px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.gen-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.mini-alert {
  margin-bottom: 12px;
}
.group-title {
  margin: 14px 0 8px;
  font-size: 13px;
  color: #4a3722;
}
.mini {
  margin-left: 6px;
}
.auto-attached {
  margin-top: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #f7f4ee;
  font-size: 12px;
}
.hint {
  margin-top: 10px;
  font-size: 12px;
}
.error-list {
  margin: 0;
  padding-left: 18px;
  text-align: left;
  font-size: 12px;
  color: #c0392b;
  line-height: 1.8;
}
</style>
