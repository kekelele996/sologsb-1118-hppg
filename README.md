# 考古探方地层编目台（gbtrenchlog）

面向考古发掘工地的记录员与整理人员，把「探方 → 地层单位 → 堆积描述 → 层位关系 → 出土物」整理成一套可核对的编目档案，解决地层编号重复、打破与叠压关系记不清、出土物脱离层位上下文的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21818>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbtrenchlog
FRONTEND_PORT=21818
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（Composition API） |
| 语言 | TypeScript（`vue-tsc` 类型检查零错误） |
| UI 组件库 | Element Plus |
| 状态管理 | Zustand（`zustand/vanilla` createStore + Vue 响应式桥接） |
| 路由 | Vue Router 4（History 模式，nginx `try_files` 回落） |
| 构建 | Vite 6 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 两侧交接 | 离线 JSON 交接包/回执 + 出件箱/收件箱（IndexedDB `handoffs` 表，无后端） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21818
npm run build      # 类型检查 + 生产构建
```

## 四、目录结构

```
sologsb-1118/
├── docker-compose.yml          # 顶层 name: gbtrenchlog，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # trench.ts / stratum.ts / artifact.ts / relation.ts / handoff.ts / index.ts
│       ├── stores/             # trenchStore / stratumStore / artifactStore / relationStore / handoffStore（Zustand）
│       ├── components/common/  # StratumDepthBar / RelationGraph / TrenchTag / UnitPicker
│       ├── hooks/              # useStratumOrder / useRelationGraph / usePersistentStore / usePartyRole
│       ├── pages/              # TrenchesPage / StrataPage / ArtifactsPage / RelationsPage / SectionsPage / HandoffPage
│       ├── router/index.ts
│       └── utils/              # graph.ts / export.ts / id.ts / handoff.ts（交接合并引擎）
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Trench 探方 | 探方号、发掘区、规格、基点坐标、开口层位、发掘起止、负责人、四壁备注、是否回填 | `trenches` |
| Stratum 地层单位 | 单位号、类型（地层/灰坑/房址/沟/墓葬）、开口层位、上下界深度、土质土色、包含物、堆积成因、绘图拍照号 | `strata` |
| Artifact 出土物 | 所属地层单位、器物编号、类别、件数、残整程度、探方内 X/Y/Z、出土日期、提取人、临时存放 | `artifacts` |
| Relation 层位关系 | 单位 A、关系类型（叠压/打破/共存）、单位 B、判定依据、记录人、备注 | `relations` |

- 数据库名 `gbtrenchlog`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史地层单位补齐「开口层位」字段并规范包含物数组；
- `version(3)` 升级为**两侧交接**：已有数据按两侧拆开——旧 `code` 归现场槽（贴在实物上不动），新增 `archiveCode` 资料室定稿槽（默认空）；深度/层位/关系归现场主权（`fieldRev` 修订号）；地层单位新增 `soilArchive`（资料室定稿土质土色）与 `finalized`（定稿态）；新增 `handoffs` 出件/收件箱表；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 五·补、现场 ⇄ 资料室交接（v3）

应用头部或 `/handoff` 页可切换**发掘现场端 / 资料室端**（同一套应用在两边各部署一份，角色存浏览器本地）。交接完全离线，靠 JSON 文件对传，不依赖网络：

| 交接语义 | 落法 |
| --- | --- |
| 编号一改就对不上 | 跨侧只认稳定 `id`（UUID），不认手抄编号；编号两侧分开存：`code` 现场号 + `archiveCode` 资料室定稿号 |
| 现场交出当天记录 | 现场端按日期勾选「探方 / 地层单位 / 出土物」，自动闭包带出所属探方、单位与两端齐备的层位关系，生成交接包并写入**出件箱**（`pending`） |
| 资料室定稿回执 | 资料室端收件后在定稿对话框按自己规矩编定稿号、定稿土质土色；齐全后整包事务定稿并导出回执 JSON |
| 同一单位两边都动过 | **土质土色听资料室**（`soilArchive`，非空即覆盖展示）；**深度与层位关系听现场**（仅在 `fieldRev` 更高时覆盖） |
| 现场号贴在实物上 | 资料室合并永不写 `code`，只回填 `archiveCode`；现场收回执也只回填定稿号，现场号不动 |
| 交接失败现场重试 | 交接包一次生成、包号不变，出件箱 `pending` 常驻，可反复重新导出；对方按包号幂等收件 |
| 失败整包拒收 | 资料室收件先校验包格式/字段/主键唯一/包内引用完整（单位→探方、出土物→单位、关系两端），任一不过整包不落库 |
| 定稿不退 | 定稿写入 `finalized=true`，后续交接包不覆盖定稿号与定稿土质（现场修订的深度/层位仍更新）；定稿号与库内已定稿记录重号时拒绝出回执 |
| 回执闭环 | 现场导入回执后回填定稿号，出件箱记录置 `receipted`；同号交接包/回执重投均幂等 |

> 现场端可新建/编辑/删除全部记录（每次保存 `fieldRev +1`）；资料室端各编目页只读，定稿动作只能在 `/handoff` 对交接包执行。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/trenches` | 探方清单：按「发掘区-探方号」校验唯一性，卡片显示单位数、出土物件数、关系数与发掘进度状态 |
| `/strata` | 地层单位编目表：按类型与深度区间筛选，层序倒置与单位号重复即时高亮，深度刻度条展示厚度 |
| `/artifacts` | 出土物登记与清单：先锁定所属地层单位（级联选择器），带出深度区间并校验出土深度是否在该区间内 |
| `/relations` | 层位关系视图：SVG 有向图展示叠压/打破，点击节点高亮直接关系，新增关系前做环路检测 |
| `/sections` | 四壁剖面示意：按深度刻度绘制地层条带与厚度标注，叠加出土物投影点 |
| `/handoff` | 现场⇄资料室交接：现场组当天交接包/出件箱重试/收回执；资料室整包校验收件、定稿编号与土质土色、出回执 |

## 七、校验规则

- 同一「发掘区-探方号」只允许一个探方；
- 同一探方内单位号不可重复（保存时拒绝）；
- 上界深度大于下界深度即为**层序倒置**，编目表整行标红并在顶部汇总；
- 若「A 叠压/打破 B」但 A 的上界深度大于 B，则提示层位关系与深度矛盾；
- 新增层位关系前做**环路检测**（DFS），会形成闭合矛盾的关系直接拒绝保存；
- 出土物的 Z（深度）必须落在其所属地层单位的深度区间内，否则给出层位核对提示。
