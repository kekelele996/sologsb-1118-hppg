<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useStore } from '@/hooks/usePersistentStore'
import { handoverStore } from '@/stores/handoverStore'
import { trenchStore } from '@/stores/trenchStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore } from '@/stores/artifactStore'
import { downloadJson } from '@/utils/export'
import type { DeviceRole, HandoverPackage, ImportPreview, ItemKind, Receipt } from '@/types'

const handoverState = useStore(handoverStore)
const trenchState = useStore(trenchStore)
const stratumState = useStore(stratumStore)
const artifactState = useStore(artifactStore)

const role = computed(() => handoverState.role)

// ————— 角色选择 —————
async function chooseRole(r: DeviceRole): Promise<void> {
  await handoverStore.getState().setRole(r)
  ElMessage.success(r === 'field' ? '已切换到「现场」：负责记录并交接' : '已切换到「资料室」：负责定稿编号并回执')
}

// ————— 现场：新建交接单 —————
const createVisible = ref(false)
const createForm = reactive({
  date: new Date().toISOString().slice(0, 10),
  trenchIds: [] as string[],
  stratumIds: [] as string[],
  artifactIds: [] as string[],
  createdBy: '',
  note: ''
})

const trenchesAfterDate = computed(() => trenchState.trenches.filter((t) => !createForm.date || t.updatedAt >= new Date(createForm.date).getTime()))
const strataAfterDate = computed(() => stratumState.strata.filter((s) => !createForm.date || s.updatedAt >= new Date(createForm.date).getTime()))
const artifactsAfterDate = computed(() => artifactState.artifacts.filter((a) => !createForm.date || a.updatedAt >= new Date(createForm.date).getTime()))

function openCreate(): void {
  createForm.date = new Date().toISOString().slice(0, 10)
  createForm.trenchIds = trenchesAfterDate.value.map((t) => t.id)
  createForm.stratumIds = strataAfterDate.value.map((s) => s.id)
  createForm.artifactIds = artifactsAfterDate.value.map((a) => a.id)
  createForm.note = ''
  createVisible.value = true
}

function toggleAll(kind: 'trench' | 'stratum' | 'artifact', checked: boolean): void {
  if (kind === 'trench') createForm.trenchIds = checked ? trenchesAfterDate.value.map((t) => t.id) : []
  if (kind === 'stratum') createForm.stratumIds = checked ? strataAfterDate.value.map((s) => s.id) : []
  if (kind === 'artifact') createForm.artifactIds = checked ? artifactsAfterDate.value.map((a) => a.id) : []
}

const createCount = computed(() => ({
  trenches: createForm.trenchIds.length,
  strata: createForm.stratumIds.length,
  artifacts: createForm.artifactIds.length
}))

async function submitCreate(): Promise<void> {
  if (createForm.stratumIds.length === 0 && createForm.trenchIds.length === 0 && createForm.artifactIds.length === 0) {
    ElMessage.warning('请至少勾选一条要交接的记录')
    return
  }
  const pkg = await handoverStore.getState().createPackage({
    trenchIds: createForm.trenchIds,
    stratumIds: createForm.stratumIds,
    artifactIds: createForm.artifactIds,
    note: createForm.note.trim(),
    createdBy: createForm.createdBy.trim()
  })
  downloadJson(`交接单_${pkg.id}.json`, pkg)
  ElMessage.success('交接单已生成并下载，交给资料室后等待回执')
  createVisible.value = false
}

// ————— 现场：导入回执 —————
const receiptInput = ref<HTMLInputElement | null>(null)
function triggerReceipt(): void {
  receiptInput.value?.click()
}
async function onReceiptFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const { applied, warnings } = await handoverStore.getState().applyReceiptFile(text)
    if (applied > 0) ElMessage.success(`已导入回执，${applied} 条记录采用定稿编号`)
    warnings.forEach((w) => ElMessage.warning(w))
    if (applied === 0 && warnings.length === 0) ElMessage.info('回执没有可应用的条目')
  } catch (err) {
    ElMessage.error(`回执导入失败：${(err as Error).message}`)
  } finally {
    input.value = ''
  }
}

// ————— 资料室：导入交接单 → 预览 → 定稿 —————
const handoverInput = ref<HTMLInputElement | null>(null)
const previewVisible = ref(false)
const preview = ref<ImportPreview | null>(null)
const finalCodes = reactive<Record<string, string>>({})
const finalizeBy = ref('')

function triggerHandover(): void {
  handoverInput.value?.click()
}
async function onHandoverFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const p = await handoverStore.getState().previewPackage(text)
    preview.value = p
    Object.keys(finalCodes).forEach((k) => delete finalCodes[k])
    p.rows.forEach((r) => (finalCodes[r.originId] = r.suggestedCode))
    previewVisible.value = true
    if (p.errors.length > 0) ElMessage.error(`校验未通过：${p.errors.join('；')}`)
    else ElMessage.success(`已接收交接单，共 ${p.rows.length} 条，核对后定稿编号`)
  } catch (err) {
    ElMessage.error(`交接单导入失败：${(err as Error).message}`)
  } finally {
    input.value = ''
  }
}

async function submitFinalize(): Promise<void> {
  if (!preview.value) return
  const codes = new Map<string, string>()
  preview.value.rows.forEach((r) => codes.set(r.originId, (finalCodes[r.originId] ?? r.suggestedCode).trim() || r.suggestedCode))
  try {
    const receipt = await handoverStore.getState().finalizePackage(preview.value.package.id, codes, finalizeBy.value.trim())
    downloadJson(`回执_${receipt.id}.json`, receipt)
    ElMessage.success(`已定稿 ${receipt.items.length} 条，回执已下载，请交回现场`)
    previewVisible.value = false
  } catch (err) {
    ElMessage.error(`定稿失败：${(err as Error).message}`)
  }
}

// ————— 通用：下载 / 重试 —————
function downloadPkg(pkg: HandoverPackage): void {
  downloadJson(`交接单_${pkg.id}.json`, pkg)
}
function downloadReceipt(r: Receipt): void {
  downloadJson(`回执_${r.id}.json`, r)
}

function statusTag(status: string): { type: 'primary' | 'success' | 'warning' | 'danger' | 'info'; text: string } {
  const map: Record<string, { type: 'primary' | 'success' | 'warning' | 'danger' | 'info'; text: string }> = {
    draft: { type: 'info', text: '草稿' },
    sent: { type: 'primary', text: '待交接' },
    received: { type: 'warning', text: '待定稿' },
    finalized: { type: 'success', text: '已定稿' },
    receipted: { type: 'success', text: '已回执' },
    failed: { type: 'danger', text: '失败待重试' }
  }
  return map[status] ?? { type: 'info', text: status }
}

function kindLabel(kind: ItemKind): string {
  return { trench: '探方', stratum: '地层单位', artifact: '出土物', relation: '层位关系' }[kind]
}

function pkgCounts(pkg: HandoverPackage): Record<string, number> {
  const c: Record<string, number> = { trench: 0, stratum: 0, artifact: 0, relation: 0 }
  pkg.items.forEach((it) => (c[it.kind] += 1))
  return c
}

onMounted(() => {
  if (!handoverState.loaded) handoverStore.getState().hydrate()
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">交接与回执</h2>
        <p class="page-sub">
          现场把当天记的探方、地层单位、出土物打包交出去；资料室按自己的规矩定稿编号后回执。
          两边都动过的地层单位，土质土色听资料室，深度与层位关系听现场；实物标签上的曾用号保留，不被定稿号盖掉。
        </p>
      </div>
    </div>

    <!-- 角色未选择 -->
    <div v-if="!role" class="role-picker">
      <el-card class="role-card" shadow="hover" @click="chooseRole('field')">
        <div class="role-icon">现</div>
        <h3>我是现场</h3>
        <p>负责发掘记录，把当天的探方、地层单位、出土物打包交接给资料室，导入回执并保留曾用号。</p>
      </el-card>
      <el-card class="role-card" shadow="hover" @click="chooseRole('archive')">
        <div class="role-icon archive">资</div>
        <h3>我是资料室</h3>
        <p>接收交接单，按本室规矩定稿编号、核对冲突，生成回执交回现场；已定稿的记录不退改。</p>
      </el-card>
    </div>

    <template v-else>
      <el-alert class="rule-alert" type="info" :closable="false" show-icon>
        <template #title>
          <span>
            当前角色：<b>{{ role === 'field' ? '现场' : '资料室' }}</b>
            。冲突规则：土质土色听资料室，深度与层位关系听现场；曾用号保留；定稿不退。
          </span>
          <el-button link type="primary" @click="chooseRole(role === 'field' ? 'archive' : 'field')">切换角色</el-button>
        </template>
      </el-alert>

      <!-- 现场视图 -->
      <template v-if="role === 'field'">
        <div class="toolbar">
          <el-button type="primary" @click="openCreate">
            <el-icon><Plus /></el-icon>新建交接单
          </el-button>
          <el-button @click="triggerReceipt">
            <el-icon><Upload /></el-icon>导入回执
          </el-button>
          <input ref="receiptInput" type="file" accept=".json,application/json" style="display:none" @change="onReceiptFile" />
        </div>

        <h3 class="section-title">发件箱</h3>
        <el-table :data="handoverState.packages" border stripe row-key="id" empty-text="还没有交接单">
          <el-table-column label="交接单号" width="200">
            <template #default="{ row }"><span class="mono">{{ row.id }}</span></template>
          </el-table-column>
          <el-table-column label="生成时间" width="170">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column label="内容">
            <template #default="{ row }">
              <el-tag v-for="(n, k) in pkgCounts(row)" :key="k" size="small" effect="plain" class="mini">
                {{ kindLabel(k as ItemKind) }} {{ n }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag :type="statusTag(row.status).type" effect="dark">{{ statusTag(row.status).text }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="downloadPkg(row)">下载交接单</el-button>
              <el-button link type="warning" size="small" @click="downloadPkg(row)">重试</el-button>
            </template>
          </el-table-column>
        </el-table>

        <h3 class="section-title">已导入回执</h3>
        <el-table :data="handoverState.receipts" border stripe row-key="id" empty-text="还没有导入回执">
          <el-table-column label="回执号" width="200">
            <template #default="{ row }"><span class="mono">{{ row.id }}</span></template>
          </el-table-column>
          <el-table-column label="对应交接单" width="200">
            <template #default="{ row }"><span class="mono">{{ row.handoverId }}</span></template>
          </el-table-column>
          <el-table-column label="定稿条目" width="100">
            <template #default="{ row }">{{ row.items.length }} 条</template>
          </el-table-column>
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="downloadReceipt(row)">下载回执</el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>

      <!-- 资料室视图 -->
      <template v-else>
        <div class="toolbar">
          <el-button type="primary" @click="triggerHandover">
            <el-icon><Upload /></el-icon>导入交接单
          </el-button>
          <input ref="handoverInput" type="file" accept=".json,application/json" style="display:none" @change="onHandoverFile" />
        </div>

        <h3 class="section-title">收件箱</h3>
        <el-table :data="handoverState.packages" border stripe row-key="id" empty-text="还没有收到交接单">
          <el-table-column label="交接单号" width="200">
            <template #default="{ row }"><span class="mono">{{ row.id }}</span></template>
          </el-table-column>
          <el-table-column label="接收时间" width="170">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column label="内容">
            <template #default="{ row }">
              <el-tag v-for="(n, k) in pkgCounts(row)" :key="k" size="small" effect="plain" class="mini">
                {{ kindLabel(k as ItemKind) }} {{ n }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag :type="statusTag(row.status).type" effect="dark">{{ statusTag(row.status).text }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="downloadPkg(row)">查看文件</el-button>
            </template>
          </el-table-column>
        </el-table>

        <h3 class="section-title">已生成回执</h3>
        <el-table :data="handoverState.receipts" border stripe row-key="id" empty-text="还没有生成回执">
          <el-table-column label="回执号" width="200">
            <template #default="{ row }"><span class="mono">{{ row.id }}</span></template>
          </el-table-column>
          <el-table-column label="对应交接单" width="200">
            <template #default="{ row }"><span class="mono">{{ row.handoverId }}</span></template>
          </el-table-column>
          <el-table-column label="定稿条目" width="100">
            <template #default="{ row }">{{ row.items.length }} 条</template>
          </el-table-column>
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="downloadReceipt(row)">下载回执</el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </template>

    <!-- 新建交接单（现场） -->
    <el-dialog v-model="createVisible" title="新建交接单" width="760px">
      <el-form label-width="90px">
        <el-form-item label="交接日期">
          <el-date-picker v-model="createForm.date" type="date" value-format="YYYY-MM-DD" style="width: 180px" />
          <span class="muted">默认勾选该日期之后有改动的记录</span>
        </el-form-item>
        <el-form-item label="经办人">
          <el-input v-model="createForm.createdBy" placeholder="选填" style="width: 180px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="createForm.note" type="textarea" :rows="2" placeholder="选填" />
        </el-form-item>
      </el-form>

      <div class="pick-group">
        <div class="pick-head">
          <b>探方</b>
          <el-checkbox :model-value="createForm.trenchIds.length === trenchesAfterDate.length && trenchesAfterDate.length > 0" @change="(v: boolean) => toggleAll('trench', v)">全选</el-checkbox>
        </div>
        <el-checkbox-group v-model="createForm.trenchIds">
          <el-checkbox v-for="t in trenchesAfterDate" :key="t.id" :value="t.id">{{ t.area }} · {{ t.code }}</el-checkbox>
        </el-checkbox-group>
      </div>
      <div class="pick-group">
        <div class="pick-head">
          <b>地层单位</b>
          <el-checkbox :model-value="createForm.stratumIds.length === strataAfterDate.length && strataAfterDate.length > 0" @change="(v: boolean) => toggleAll('stratum', v)">全选</el-checkbox>
        </div>
        <el-checkbox-group v-model="createForm.stratumIds">
          <el-checkbox v-for="s in strataAfterDate" :key="s.id" :value="s.id">{{ s.code }}（{{ s.type }}）</el-checkbox>
        </el-checkbox-group>
      </div>
      <div class="pick-group">
        <div class="pick-head">
          <b>出土物</b>
          <el-checkbox :model-value="createForm.artifactIds.length === artifactsAfterDate.length && artifactsAfterDate.length > 0" @change="(v: boolean) => toggleAll('artifact', v)">全选</el-checkbox>
        </div>
        <el-checkbox-group v-model="createForm.artifactIds">
          <el-checkbox v-for="a in artifactsAfterDate" :key="a.id" :value="a.id">{{ a.code }}</el-checkbox>
        </el-checkbox-group>
      </div>

      <p class="muted">
        已选：探方 {{ createCount.trenches }} · 地层单位 {{ createCount.strata }} · 出土物 {{ createCount.artifacts }}
        （关联层位关系与上级探方会自动带上）
      </p>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">生成交接单</el-button>
      </template>
    </el-dialog>

    <!-- 导入交接单预览（资料室） -->
    <el-dialog v-model="previewVisible" title="交接单核对与定稿" width="960px">
      <el-alert
        v-if="preview && preview.errors.length > 0"
        type="error"
        :closable="false"
        show-icon
        :title="`校验未通过（${preview.errors.length} 项），请现场修正后重新交接`"
        class="preview-alert"
      >
        <div v-for="(e, i) in preview.errors" :key="i" class="muted">· {{ e }}</div>
      </el-alert>
      <el-alert v-else type="success" :closable="false" show-icon :title="`核对通过：新增 ${preview?.counts.create ?? 0} · 更新 ${preview?.counts.update ?? 0} · 冲突 ${preview?.counts.conflict ?? 0} · 无变化 ${preview?.counts.unchanged ?? 0}`" class="preview-alert" />

      <el-table :data="preview?.rows ?? []" border stripe max-height="460" row-key="originId">
        <el-table-column label="种类" width="90">
          <template #default="{ row }">{{ kindLabel(row.kind) }}</template>
        </el-table-column>
        <el-table-column label="现场编号" width="140">
          <template #default="{ row }"><span class="mono">{{ row.fieldCode }}</span></template>
        </el-table-column>
        <el-table-column label="资料室现号" width="140">
          <template #default="{ row }">
            <span class="mono">{{ row.archiveCode ?? '—' }}</span>
            <el-tag v-if="row.conflict" type="warning" size="small" effect="dark" class="mini">两边都改</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="定稿编号（可改）" min-width="180">
          <template #default="{ row }">
            <el-input v-model="finalCodes[row.originId]" size="small" :disabled="row.action === 'unchanged'" />
          </template>
        </el-table-column>
        <el-table-column label="处理" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.action === 'create'" type="success" size="small">新增</el-tag>
            <el-tag v-else-if="row.action === 'merge'" type="primary" size="small">合并</el-tag>
            <el-tag v-else type="info" size="small">无变化</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="校验" min-width="160">
          <template #default="{ row }">
            <span v-for="(e, i) in row.errors" :key="i" class="err">· {{ e }}</span>
            <span v-if="row.errors.length === 0" class="muted">通过</span>
          </template>
        </el-table-column>
      </el-table>

      <el-form label-width="90px" class="finalize-form">
        <el-form-item label="定稿人">
          <el-input v-model="finalizeBy" placeholder="选填" style="width: 180px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="previewVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!preview || preview.errors.length > 0" @click="submitFinalize">确认定稿并生成回执</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.role-picker {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  max-width: 760px;
  margin: 40px auto;
}
.role-card {
  cursor: pointer;
  text-align: center;
  padding: 12px;
}
.role-card h3 {
  margin: 12px 0 8px;
}
.role-card p {
  margin: 0;
  font-size: 13px;
  color: #7d7264;
  line-height: 1.7;
  text-align: left;
}
.role-icon {
  width: 56px;
  height: 56px;
  margin: 0 auto;
  border-radius: 14px;
  background: linear-gradient(135deg, #e0c168, #a9762f);
  color: #3c2f1f;
  font-size: 24px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.role-icon.archive {
  background: linear-gradient(135deg, #8fb8c9, #2f6f8f);
  color: #fff;
}
.rule-alert {
  margin-bottom: 16px;
}
.section-title {
  margin: 22px 0 12px;
  font-size: 16px;
  font-weight: 600;
}
.mini {
  margin-left: 4px;
}
.pick-group {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid #e6ded0;
  border-radius: 10px;
}
.pick-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.pick-group .el-checkbox-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}
.preview-alert {
  margin-bottom: 12px;
}
.finalize-form {
  margin-top: 14px;
}
.err {
  display: block;
  color: #c0392b;
  font-size: 12px;
}
</style>
