# VRC UI 规范全量审计与整改清单

> 审计日期：2026-07-21  
> 审计范围：`apps/web/src` 生产页面、组件、全局样式、Electron 启动层，以及 `apps/web/src/prototypes` 原型页面。  
> 审计依据：`docs/UI设计规范.md`、`docs/UI样式规范归档.md`。  
> 当前结论为静态代码审计；未替代浏览器截图、DevTools 尺寸测量、三主题切换和 Electron 冷启动验收。

## 1. 给执行 agent 的规则

### 1.1 状态含义

- **符合**：源码已经满足规范，不要为“统一”而回退或复制旧实现。
- **部分符合**：结构正确，但存在尺寸、颜色、响应式、语义或重复样式风险，需要按本清单收敛。
- **不符合**：违反明确硬标准，应在对应优先级内整改。
- **原型隔离**：原型不是生产入口。原型可以继续用于验证流程，但不能把原型样式复制回生产组件；若原型继续展示，必须明确标记为 prototype。

### 1.2 修改边界

- 只修改自己领取的功能域，不能把无关后端、Electron 主进程、原型重写混进同一个提交。
- 新增颜色只能先登记为 token，再由组件消费；不要在业务组件内新增 hex/rgb/hsl。
- 选中主值和状态文字不得直接假设基础 accent/success 在所有背景上都可读；前景色使用 `--vrc-active-text`、`--vrc-success-text`，深色模式由 `[data-tone="dark"]` 混入正文色提高对比度。
- VM、物理机、存储、ISO 等统计/详情 Dialog 的顶部汇总卡统一使用 `--vrc-surface` 和弱边框；浅色表现为白色，深色跟随主题 surface。汇总信息不使用 `--vrc-surface-muted`、accent-soft 或状态色整块填充，避免形成脏灰色块。
- 保留现有功能契约：连接读取、VM 操作、创建、扩容、控制台、定时任务和设置逻辑不能因视觉整改改变 API 或业务口径。
- 复杂 Dialog 必须保持 `el-dialog__body` / `el-dialog__footer` 的结构职责，不能通过增加外层 padding 掩盖内部布局问题。
- 每个 agent 完成后至少运行 `npm` 项目已有的类型检查或构建，并记录未完成的浏览器验收项。

### 1.3 分派建议

| Agent | 负责范围 | 禁止事项 |
|---|---|---|
| Agent A：Shell / 总览 | `App.vue` 的应用外壳、总览、`HostVmPanel.vue`、对应全局基础样式 | 不改 Dialog 业务流程和 Console；不重写主题系统 |
| Agent B：VM / Dialog | `VmProvisioningDialog.vue`、`VmResizeDialog.vue`、`VmRenameDialog.vue`、`VmScheduleDialog.vue`、VM 详情/资源详情 Dialog、`Vrc*Icon.vue` | 不修改应用设置数据模型；不复制 prototype 为第二套生产组件 |
| Agent C：Theme / Feedback / Console | `styles.css` token 与旧样式清理、设置页、Toast/Tooltip/Loading、`ConsoleDialog.vue`、Electron 启动层 | 不改 VM 后端操作语义；不要用一次性局部覆盖继续堆第三层 CSS |
| 主 agent | 合并复核、跨域冲突处理、最终验收文档 | 不直接采纳未经源码复核的结论 |

## 2. 已符合的功能与实现基线

这些区域已经基本符合规范，整改时以保留为原则，只修复本清单明确指出的偏差。

| 功能 | 当前证据 | 结论 |
|---|---|---|
| 主题 token 基础 | `apps/web/src/styles.css:1-188`，包含三套主题、字号、控件尺寸、状态色、滚动条 token | 符合基础架构 |
| 根节点主题/明暗作用域 | `apps/web/src/App.vue:1244-1334` 写入 `document.documentElement`，Teleport 到 body 的 Dialog、MessageBox、Toast、Tooltip 可继承 | 结构符合，暗色 token 仍需按第 3.1/3.9 节清理 |
| App Shell 响应式骨架 | `styles.css:435-486`、`12235-12438`，桌面/中等/窄屏有断点，`minmax(0, 1fr)` | 符合基础布局 |
| 侧栏品牌头部 | Web `62px`，macOS `92px`，固定 `flex-basis` | 符合 |
| 资源总览入口 active/hover | `styles.css:610-635`、后层覆盖 `5120-5130`，保持 surface，用边框表达 active | 符合 |
| 查询与动作分组 | `HostVmPanel.vue:508-580`，查询、批量动作、创建/导出/刷新分组，顺序正确 | 符合 |
| VM 状态筛选 | `HostVmPanel.vue:517-520`、`styles.css:1740-1773`，使用 Element `el-segmented` 28/22 规格 | 符合 |
| 物理机/VM 资源 meter | `HostVmPanel.vue:442-504`、`styles.css:10647-10697`，4px 低饱和 meter，风险使用语义色 | 符合 |
| VM 四个高频动作基础语义 | `HostVmPanel.vue:657-672`、`styles.css:4502-4628`，开机/关机/强制重启/删除有 title、aria-label、禁用原因、26px 盒子 | 基础符合；扩容第五个图标需按第 3.2 节处理 |
| VM 操作中状态 | `HostVmPanel.vue:621-632`，短文案 + 三段点；`styles.css:4427-4455`、`4630-4638` 支持 reduced motion | 符合 |
| 生产 Loading 标识 | App/Host/Console 使用 `VrcLogoMark`，统一 ring + logo 结构 | 符合；旧平台色声明需清理 |
| 总览下钻 | `App.vue:3026-3054`，弹出 VM 详情而不改变底层总览状态 | 符合 |
| 定时任务 Dialog 主结构 | `VmScheduleDialog.vue:419-497`，880px、6vh、Tabs、三段分组、固定 footer、目标数据区独立滚动 | 基础符合；见第 3.8.1 节 |
| 设置页固定导航 | `App.vue:5782-5824`、`styles.css:8798-8937`，外层固定、右侧内容区滚动 | 符合；设置空态见第 3.6 节 |
| Toast 基础时长和 Tooltip 暗色浮层 | `App.vue:382`、`5175-5181`；`styles.css:6114-6183` | 基础符合，继续禁止读取成功 Toast |
| 自定义背景作用域 | `App.vue:1063-1078`、`styles.css:1114-1151`，只影响 workspace，资源面板保持 surface | 符合，需补齐无图片导入验收 |

### 2.1 生产功能评级总表

| 功能/组件 | 评级 | 主要结论 |
|---|---|---|
| App Shell / Sidebar | 部分符合 | 固定品牌头和响应式骨架正确；旧硬编码颜色、连接搜索无结果空态、活动行键盘交互需改 |
| 物理机总览 | 基本符合 | 查询/动作、meter、评估、序号、下钻符合；移动端指标栅格、空态高度、Unicode 图标需改 |
| HostVmPanel / VM 清单 | 基本符合 | segmented、toolbar、四个高频动作、loading 符合；第五个扩容图标、系统列、完成态整行色、滚动层级需改 |
| VmProvisioningDialog | 部分符合 | 骨架、主滚动、footer、表格、loading、响应式符合；普通控件 28px、候选 IP 自绘 segmented、inset 边框不符合 |
| VmResizeDialog | 部分符合 | 标题、footer、token、桌面布局符合；单一主滚动、移动端五列、inset 边框需改 |
| VmRenameDialog | 符合（小缺口） | 30px 输入、footer、token 符合；宿主表格的改名图标补 title/Tooltip |
| VmScheduleDialog | 基本符合 | 复杂 Dialog、Tabs、30px 表单、表格、footer 符合；任务行图标说明和筛选/动作分组需改 |
| VrcVmActionIcon / VrcToolbarIcon | 符合 | viewBox、线宽、圆角端点和强制重启中心三角符合；可访问名称由宿主按钮提供 |
| VM Detail Dialog | 基本符合 | 80vw/75vh、表格列宽和独立数据滚动基本符合；超窄响应和状态整行背景需复核 |
| Host / SR Detail Dialog | 部分符合 | summary、表格密度、token、meter 基本符合；body padding 0 和唯一主滚动未完全落地 |
| ISO Dialog | 已整改 | 查询/动作分组、30px 搜索、28px toolbar icon、少量数据收缩和多行内部滚动已统一；VRC loading 与主题 token 保持不变 |
| Activity Log Dialog | 不符合项集中 | body padding、31px 搜索、自绘状态 filter、整项状态背景需整改 |
| Connection Settings Dialog | 部分符合 | 30px 表单和按钮基本符合；固定导航 + 内容单滚动、active 低噪声表达需改 |
| Account Import Dialog | 部分符合 | 双栏结构和响应基础符合；自绘 tabs、固定 footer、主/预览滚动边界需改 |
| ConsoleDialog | 部分符合 | body 0、28px 工具按钮、Tooltip/aria、VRC loading 符合；重复 CSS、默认滚动条和 terminal 硬编码需改 |
| 设置 / 主题 / 背景 | 基本符合 | 根节点主题、持久化、背景作用域符合；列表层级、互斥控件和移动端设置滚动需补齐 |
| Electron 启动层 | 部分符合 | 主题读取和 ready gate 方向正确；显示时长、交叉淡入、Logo 同源性需改 |

## 3. 整改清单（按优先级）

### P0：必须先处理的全局一致性问题

#### 3.1 清理全局 CSS 历史硬编码和重复覆盖

- **现状**：`apps/web/src/styles.css` 静态扫描约有 363 处硬编码颜色。重点包括 `430-575`、`610-773`、`785-847`、`1293-1496`、`1521-1677`、`2440-2694`、`3981-4075`、`4640-4768`、`7042-7883`、`10616-10636`。后半段 token 覆盖只改变部分最终 computed 值，源头仍然存在，后续很容易重新泄漏白色、蓝色和平台色。
- **正确改法**：
  1. 先按区域合并旧规则，不要再追加第三层 override。
  2. 页面/面板背景使用 `--vrc-bg`、`--vrc-surface`、`--vrc-surface-muted`、`--vrc-surface-raised`。
  3. 正文/辅助/弱文字使用 `--vrc-text`、`--vrc-text-muted`、`--vrc-text-subtle`。
  4. 普通边框、强调边框、焦点使用 `--vrc-border`、`--vrc-border-strong`、`--vrc-focus-ring`。
  5. 链接如需保留下划线识别，新增 `--vrc-link` / `--vrc-link-hover` 语义 token；不能继续散落 `#2563eb` / `#1d4ed8`。
  6. 状态统一使用 `--vrc-info`、`--vrc-success`、`--vrc-warning`、`--vrc-danger` 及对应 soft token。
  7. terminal 纯黑只允许终端画布专用 token，不得扩散到 Dialog、toolbar、上传卡片。
- **验收**：
  - 运行颜色扫描，除 `:root` / 三主题 token、terminal 专用 token、Logo SVG 必要 fill 外，不再出现业务 hex/rgb。
  - 切换三套主题和浅色/深色，逐区检查 body、sidebar、workspace、table、dialog、toast、tooltip、loading、console。
  - `git diff --check` 无空白错误。

#### 3.2 保留 VM 操作列第五个图标和能力列宽

- **口径更正**：前面“扩容移出操作列、操作列固定约 146px”的结论不准确。扩容是 VM 行级操作，用户已明确要求保留在操作列，不能放到磁盘数据列。
- **正确改法**：操作列顺序固定为开机、关机、强制重启、扩容、删除；支持扩容时使用 176px，不支持扩容时使用 144px。五枚/四枚按钮均为 26px 图标按钮，磁盘列只展示容量和磁盘摘要。
- **验收**：1440px、980px、700px 下图标固定居中；支持扩容的平台表头与内容列均为 176px，不支持时均为 144px；打开扩容 Dialog 后按 Esc，焦点回到扩容按钮但不得出现背景、外框或阴影。

#### 3.3 统一表格、查询边框和状态字重

- **现状**：
  - `styles.css:3981-3987` 的 `.el-table` 仍写死 `#fafafa/#fff/#f5f5f5/#eee`。
  - `styles.css:1775-1787`、`6402-6415` 的查询输入默认透明边框，规范要求单层 1px `--vrc-border`。
  - `styles.css:4675-4682` 的 `.state-text` 默认字重偏重；创建评估和普通状态应为 `400`。
- **正确改法**：表头 `--vrc-surface-muted`、行 `--vrc-surface`、hover `--vrc-accent-soft` 低透明、边框 `--vrc-border`；输入默认 `1px solid var(--vrc-border)`，focus 只切换 `--vrc-border-strong` 且不显示外扩阴影，不能改变盒子尺寸；普通状态和推荐文案改为 `var(--vrc-font-weight-regular)`。
- **验收**：计算样式确认 focus 前后仍是 1px；表格表头/行/hover 随主题切换；状态列不因加粗抢焦点。

### P1：生产功能域整改

#### 3.4 VM 列表和总览滚动层级

- **现状**：`HostVmPanel.vue:585-596` 使用 `vm-table-wrap` 包裹 `el-table`，`tableHeight="100%"`；全局 `styles.css:1102-1108` 的 workspace 自身 `overflow:auto`，总览 `styles.css:2226-2234` 也存在高度/滚动叠加风险。部分窗口可能出现 workspace、table wrapper、Element body 三层同向滚动。
- **正确改法**：页面模式只保留 workspace 或表格数据区中的一个主纵向滚动容器；设置页继续保持外层 `overflow:hidden`、右内容区 `overflow:auto`。自定义目标表和列表采用“固定表头 + 独立数据区”，数据区增加 `.vrc-scroll-container`、`scrollbar-gutter: stable`；不要用隐藏滚动条掩盖宽度问题。
- **验收**：1440/980/700/手机宽度下，同一方向只出现一个主滚动条；表头固定且列线对齐；页面主体不因表格横向滚动而整体横向滚动。

#### 3.4.1 HostVmPanel 细项

- `HostVmPanel.vue:634` 系统列当前 `min-width=156` 且居中。改为约 `170px`、表头和主要内容左对齐；名称/系统/磁盘/IP 按 240/170/220/128 口径检查，操作列按能力使用 176/144px。
- `styles.css:1509-1519` 页面版 `.metric-grid` 仍有 5 个固定最小列；仅 Dialog 版有降列断点。`980px` 改为 3 列，`700px` 改为 2 列或 `auto-fit,minmax(146px,1fr)`，不能让 workspace 横向滚动。
- `styles.css:1864-1889`、`4572-4602`、`5778-5839` 的 `forceReboot` 状态当前接近 info 色。强制重启必须使用低饱和 `--vrc-warning`，保留中心启动三角，不能变成 danger 红或普通 refresh。
- `App.vue:5447-5479` 当搜索关键词无匹配时没有空态。增加“未找到匹配连接”的普通弱色反馈；不要套大卡片或背景块，清空关键词后恢复列表。
- `App.vue:5620-5627` 总览匹配 segmented 增加 `aria-label="物理机/VM IP 匹配模式"`。
- `App.vue:5490-5507` 活动记录行目前依赖双击 div。改为可聚焦、可点击的 button 或 `role="button" + tabindex=0`，支持 Enter/Space；不要依赖双击，保留列表行的低噪声外观。
- `styles.css:4476-4482` 等 VM action success/error 不能给整行铺红绿背景；移除 stripe/完成态色块，只保留状态列文字、三段点和左侧 3px 语义条。

#### 3.5 物理机总览与左侧连接列表

- **已符合**：总览查询和动作分组、序号列、资源余量 + 4px meter + 说明、创建评估 400 字重、总览入口 active 用边框表达。
- **待整改**：
  - `App.vue:5449-5453` 的总览入口图标仍为裸 Unicode `↗`，应改为现有 `VrcToolbarIcon`/简洁方形 mark，保持 24px viewBox、主题 token 和可访问名称。
  - `styles.css:610-648`、`702-735`、`764-847` 的 sidebar/connection/activity 仍有纯白、蓝色、亮绿色和旧背景。
  - active 状态点在 `styles.css:710-735` 改变 5/7px 盒子，可能造成布局位移；统一固定尺寸，只改变颜色和弱环。
  - `styles.css:2245-2261` 的总览/VM 空态最小高度约 520px，窄屏会产生大空白；移动端改为 `clamp(220px, 40vh, 520px)` 一类响应式高度。
- **正确改法**：连接名称、地址、端口分别使用 text/muted/subtle；连接 active 不使用大面积 accent-soft；活动行只保留 surface-raised + 2px 语义左线，错误/警告不刷整块红黄背景。
- **验收**：三主题下侧栏不残留蓝/白；连接 active 切换不发生位移；空列表直接使用普通弱色空态，不出现额外大卡片。

#### 3.6 设置页空态和设置菜单

- **现状**：`styles.css:9432-9437` 的 `.settings-empty-note` 仍是 muted 背景、边框、圆角卡片；规范要求连接库、账号库、IP 池等列表空态复用表格 empty 区。实际使用点包括 `App.vue:6128`（连接库空态）和 `6181`（IP 池筛选无结果）；`6143` 模板说明、`6314/6420` Chrome 插件说明、`6471-6477` 维护加载/错误/无数据说明可保留，但要使用语义 token。`styles.css:8921-8925` 设置菜单 active 仍铺整块 accent-soft，视觉噪声偏高。
- **正确改法**：移除 `.settings-empty-note` 的背景、边框、圆角和额外 padding，改用 `.el-table__empty-block/.el-table__empty-text` 的 12/11px muted/subtle 文字。设置菜单 active 保持 surface，以 accent 边框和图标色表达当前项；不要影响资源总览入口的既有规则。
- **验收**：连接、账号、IP 池 0 条时只出现表格空态；设置菜单切换不产生色块墙，键盘焦点仍清晰。

#### 3.6.1 设置页互斥控件和列表

- `App.vue:6283-6285` Chrome 插件“内网/本机”是互斥模式，却使用自绘 `.chrome-extension-segmented`。改为 `el-segmented` 28/22px；内容 Tabs 仍可使用标准 Tabs，不能混为一类。
- `App.vue:6335` / `styles.css:10415-10417` Chrome 本地连接表外层滚动未纳入 `.vrc-scroll-container`。增加该 class，确保只有表格数据区滚动并使用统一 10px/2px thumb。
- `App.vue:5982-6008` 的 `.settings-switch` 是 button+`aria-pressed`。若保留自绘样式，补 `role="switch"`、`aria-checked` 和键盘语义；更推荐使用 `el-switch`，视觉保持 34×20px。
- 连接库、IP 池使用自定义 list（`App.vue:6113-6131`、`6161-6184`），不应只修空态；应评估迁移到统一表格语义，或至少补 muted 表头、surface 行、44-48px 行高和同一 empty slot。
- `styles.css:12257-12263` 在 980px 只给设置导航 6 列，但实际有 7 项。700px 以下改为 3 列或纵向导航，保证最后一项不形成孤立窄按钮。
- 700px 以下 `.workspace` 变为 auto 高度，但 settings mode 仍 `overflow:hidden`；移动端要显式给设置 panel 可计算高度，或让 workspace overflow visible、右内容区成为唯一滚动容器，避免内容裁切。
- IP 池当前在 `settings-card.ip-pool-card` 内再嵌 `.ip-pool-list-panel` / `.ip-pool-editor-panel` 两个完整 surface+border+radius 面板，形成 card-in-card。外层 settings section 只保留标题和内容边界，列表/编辑区用两列布局、分割线或 muted 表头表达，不再各自套完整圆角卡。

#### 3.7 统一危险确认入口

- **现状**：`App.vue:1821` 删除 IP 池、`App.vue:1832` 清空 IP 池仍直接调用 Element `ElMessageBox.confirm`；`VmScheduleDialog.vue:307` 删除任务自行拼接换行文本。统一 helper 在 `App.vue:5149-5172`，但组件不能直接依赖 App 内部函数。
- **正确改法**：将 `confirmVrcAction` / `renderVrcConfirmAction` 抽到共享 domain/composable（例如 `apps/web/src/domain/confirmAction.ts`），所有业务确认统一提供：对象、动作、影响范围、取消/关闭区分、`closeOnClickModal: false`、`vrc-confirm-message-box`。删除 IP 池要说明会影响后续分配；清空要说明未保存内容将丢失；删除定时任务保留后续不再执行语义。
- **验收**：全生产代码只允许共享 helper 触发业务确认；grep 裸 `ElMessageBox.confirm` 只剩 helper 实现；按钮高度 30px、间距 8px、无默认 title/icon。

#### 3.8 VM 详情、改名、扩容、创建 Dialog

- **已符合**：`VmResizeDialog.vue:424-427` 已清除 body/footer padding；普通输入和 footer 多数使用 30px token；扩容 stepper 为 30px 外框，系统登录字段和窄屏有断点。
- **执行要求**：
  - `VmProvisioningDialog.vue` 保留紧凑表单、侧栏和任务 footer，但继续检查 980/700 断点，不能让双列压缩到不可读。
  - `VmResizeDialog.vue:486` 的磁盘选择器仍显式 `--el-component-size: 28px`；作为普通表单字段应回到 30px，若确实是密集筛选器必须在文档中标注用途，不得仅因局部历史规则保留。
  - 所有输入、select、input-number、只读字段统一单层 1px 边框；focus 只改变边框色，不用 inset shadow 叠第二层。
  - `styles.css` 全局 readonly wrapper 和 `.vm-rename-readonly` 当前使用 `--vrc-surface-muted` 灰绿背景，与普通表单字段形成不必要的状态色块。只读字段改为 `--vrc-surface` 背景、正常文字色和 `--vrc-border` 弱边框；只通过不可编辑行为和光标语义区分，不使用强调色或 muted 色块。
  - 简单详情、ISO、SR、Host Dialog 也要统一表头 muted、空态、footer 按钮和滚动容器，不能只修复杂流程 Dialog。
- **验收**：每个 Dialog 测量 header/body/footer 计算 padding；按钮高度/字重/间距符合 30px/12px/400/8px；窄屏无正文遮挡和双滚动。

#### 3.8.1 创建、扩容、定时任务和资源详情细项

- **已完成（2026-07-21）**：候选 IP “可用/全部”已从自绘 button segmented 改为 `el-segmented`，共用全局 28/22px 和主题 token。
- **已完成（2026-07-21）**：候选 IP 原“可用”卡使用硬编码浅绿底/深绿文字、选中卡使用硬编码蓝底/蓝边/蓝文字，现已统一为 `--vrc-surface` 背景和弱边框；未选中可用卡只在说明文字使用 `--vrc-success-text`，选中卡的 IP 主值和状态小字统一使用 `--vrc-active-text`，并只增加 `--vrc-active-border`，不铺状态背景。两个前景 token 在深色模式混入正文色，避免直接使用偏暗的基础主题色。
- **已完成（2026-07-21）**：创建预案 1～3 行时不启用数据区滚动和稳定 gutter，表头取消滚动条补偿；容器高度计入上下边框，不以裁切数据行换取无滚动条；超过 3 行后才启用统一 `.vrc-scroll-container` 滚动条。
- **已完成（2026-07-21）**：`VmProvisioningDialog.vue:1531-1556`、`styles.css` 创建表单普通 input/select/input-number 已统一为 `--vrc-control-height` 30px，只有 segmented 保留 28px。
- **已完成（2026-07-21）**：`VmProvisioningDialog.vue:1711-1735` 的预案表格行内输入已改为显式 `1px solid var(--vrc-border)`，删除透明边框和 inset shadow；hover 保持弱边框，focus 只切换为强边框。
- **已完成（2026-07-21）**：创建主参数区和预案表格 CPU/内存/磁盘步进器统一消费 `--vrc-number-step-width: 28px`、`--vrc-number-step-height: 15px`；预案列轨道同步调整为 78/84/92px，不再把步进按钮压缩为 22px。
- **已完成（2026-07-21）**：`VmResizeDialog.vue` 的 stepper 聚焦从内部 inset 双边框改为外框 `border-color` + 统一 focus ring；磁盘 select 删除 28px 遗留变量，明确使用 30px、单层 1px 边框，并补齐 hover/focus token。
- **部分完成（2026-07-21）**：扩容正文已增加唯一 `.vrc-scroll-container` 和视口高度上限，自绘 mount radiogroup 已补 `focus-visible`。仍需继续验证/整改小于 700px 时固定 5 列的重排，以及按真实业务状态确认是否需要 disabled 语义。
- `VmScheduleDialog.vue:454-464` 目标筛选与批量命令处在同一 grid。拆成查询 wrapper 和动作 wrapper，动作靠右；`606-609` 编辑/删除按钮补 `title` 或暗色 Tooltip。目标表和任务表现有表头/行高/滚动规则保留。
- `HostVmPanel.vue:609-617` 改名图标补 `title` 或 Tooltip，保留稳定占位盒子。
- `App.vue:6611-6638` 活动日志搜索改为 30px；状态过滤自绘 button 改 `el-segmented`，去掉 `padding: 0 10px 10px` 的基线错误，并补 `aria-label`。
- `styles.css` 不再给活动日志 status item 铺整块 info/success/warning/danger soft 背景；统一使用 surface-raised 和四边等宽 1px 弱边框，不保留左侧粗状态线，状态只由右侧文字颜色表达。侧栏日志入口图标不使用独立背景块或边框。
- **部分完成（2026-07-21）**：VM/Host/SR/ISO 顶部统计卡已统一为 surface + 弱边框，ISO body 已为 0 padding；Host/SR body 结构和其他简单详情 Dialog 的唯一滚动仍待后续统一。
- **已完成（2026-07-21）**：ISO 搜索保留在查询组，刷新改为 28×28 `VrcToolbarIcon name="refresh"`，靠右并提供 Tooltip/aria-label；ISO 不再消费 `.cache-refresh-link` 旧文字按钮样式。
- **已完成（2026-07-21）**：ISO 表格不再固定 420px；少量数据按 42px 表头 + 48px 行高收缩，加载/空态保留 300px，数据较多时上限 420px 并由表格数据区滚动。
- `App.vue:6641-6757` 连接设置 Dialog 的 `.settings-dialog-shell` 增加唯一内容滚动区，窄屏导航和内容纵向重排。
- `App.vue:6759-6860` 账号导入是复杂双栏流程，但操作按钮在内容卡底部且没有固定 footer。将取消/只导入新增/测试并导入移动到 `#footer`，footer 30px、gap 8px、padding 由内部维护；预览表独立 `.vrc-scroll-container`。

#### 3.9 Console Dialog 和终端反馈

- **现状**：`styles.css:2427-2694` 与 `6600+`、`7696+` 存在重复 Console 规则；`7042-7054`、`7254-7883` 仍有大量终端窗口、上传卡片、成功/错误状态的硬编码色；`styles.css:7416` 使用未定义的 `--vrc-text-secondary`。普通 console side、VM tabs、upload status 可能形成多个同向滚动容器。
- **正确改法**：
  1. 将 console 样式合并成一个 section，删除旧块，不继续叠加覆盖。
  2. 扩展 terminal token：`--vrc-terminal-border`、`--vrc-terminal-titlebar`、`--vrc-terminal-overlay`、`--vrc-terminal-track`、`--vrc-terminal-success`、`--vrc-terminal-warning`、`--vrc-terminal-danger`，三主题和 dark 均定义。
  3. 把未定义 `--vrc-text-secondary` 改为 `--vrc-text-muted` 或 `--vrc-text-subtle`。
  4. 正常、放大、嵌入模式明确唯一主滚动容器；上传状态卡只在规定位置显示，不覆盖 titlebar/toolbar。
  5. 终端画布可保持黑色，但外框、toolbar、status bar、上传 overlay 必须主题联动。
- **验收**：普通/放大/嵌入 Console 在 980/700/手机下无双滚动；三主题和深色切换时外框/toolbar/上传进度/成功错误状态同步；不再有未定义 CSS var。

#### 3.10 Electron 启动覆盖层

- **现状**：`apps/electron/main.cjs:11` 的 `MIN_STARTUP_VISIBLE_MS=650`，`STARTUP_EXIT_ANIMATION_MS=260`；`startup.html` 的 opacity transition 约 220ms，低于规范要求的最短约 1.8s 和 420-480ms 交叉淡入。
- **正确改法**：将首次启动最短显示时间调整到约 `1800ms`；覆盖层和主界面交叉淡入使用 `420-480ms` 同一口径，主 Renderer 完成主题、连接列表和至少两帧布局后再移除；启动失败保留主题背景并显示短错误。启动 logo 与 `VrcLogoMark` 保持同一图形资产，不使用不一致的平台 app icon 变体。
- **验收**：Electron 冷启动计时不低于约 1.8s；无先露出白色/未着色窗口；Dock activate 不绕过 ready gate；失败路径仍可读。

### P2：原型与维护性整改

#### 3.11 原型页面隔离和回收

- `apps/web/src/prototypes` 当前包含 8 个原型：`ResourceListPrototype.vue`、`ThemeAppearancePrototype.vue`、`VmRenamePrototype.vue`、`VmResize*`、`VmSchedulePrototype.vue`、`ClientStartupPrototype.vue`。
- 原型中仍有独立硬编码颜色、旧按钮尺寸、第二套定时任务/扩容结构。它们不能作为生产组件继续维护，也不能在整改中直接复制回 `App.vue` 或正式 Dialog。
- 正确做法：保留用于验收的交互原型，但在文件头/入口标记 prototype；将已完成的生产组件作为唯一正式实现；若原型需要同步展示，仅同步 token、文案和流程，不复制弱类型字段或旧页面布局。
- 验收：生产入口只引用 `apps/web/src/components` 和 `App.vue` 正式组件；原型不被生产路由加载；prototype 的差异在文档中有说明。

## 4. 设置和反馈功能逐项结论

| 功能 | 状态 | 结论与整改 |
|---|---|---|
| 外观主题三选一 | 部分符合 | token 和持久化已具备；完成全局硬编码清理后验证三主题全页面联动 |
| 浅色/深色/跟随系统 | 部分符合 | 根节点作用域正确；暗色变量不要只在 JS inline 维护，改为 CSS 主题层并补 Console/表格/空态验收 |
| 自定义语义色 | 符合基础 | 6 位 hex 校验、独立 accent/success/warning/danger 已有；预设色不要扩大蓝紫主色占比 |
| 工作区背景 | 符合基础 | 作用域、缓存版本、上传格式和重置逻辑已有；补测无图片导入和窄屏可读性 |
| 连接库/连接编辑 | 部分符合 | 功能完整；按钮、输入和空态需按第 3.6/3.7 节统一 |
| 创建模板 | 已核实无需功能整改 | 当前只是归档说明，不直接编辑模板，避免与创建 VM 真实配置形成两套口径；说明块按普通 muted 文本保留 |
| IP 池 | 不符合确认入口 | 删除/清空改统一确认；列表空态改表格 empty；其余表单按 token 检查 |
| Chrome 插件设置 | 部分符合 | 基础布局和按钮存在；检查窄屏重排、暗色、输入边框和保存/检测 Toast |
| 维护/ISO 清理 | 部分符合 | 读取成功不弹 Toast；危险清理要走统一确认并明确对象/影响范围 |
| 日志 | 部分符合 | 读取成功反馈方式符合；活动行旧颜色和 status 卡需 token 化 |
| Console | 不符合/高风险 | 重复 CSS、terminal 硬编码、未定义 token、多滚动容器按第 3.9 节整改 |
| Electron 启动 | 部分符合 | 主题读取和 ready gate 基本存在；显示时长/淡入和 logo 资产按第 3.10 节整改 |

## 5. 验收矩阵

每个 agent 在提交前都要填写实际结果；未做的项目必须写“未验证”，不能用静态阅读替代。

| 维度 | 必测场景 | 验收口径 |
|---|---|---|
| 主题 | Graphite Sage、Basalt Copper、Mist Teal；浅色/深色 | body、sidebar、workspace、table、dialog、toast、tooltip、loading、console 全部跟随；无旧蓝/纯白残留 |
| 响应式 | 桌面、980px、700px、窄手机 | 无页面级横向滚动；按钮/查询/步骤/表格不重叠；只保留规定的表格横滚 |
| 控件尺寸 | input/select/input-number、segmented、switch、按钮 | 普通控件 30px；segmented 28/22；普通 switch 34×20；密集表格 switch 30×16；Toolbar 28；行内 icon 26 |
| 表格 | 空、加载、hover、排序、选中、禁用、长文本 | muted 表头、surface 行、48px 业务行、短状态无省略、主列可读、列线对齐 |
| Dialog | 创建、编辑、详情、危险确认、关闭恢复焦点 | body/footer padding 0（复杂 Dialog）；footer 固定；确认包含对象/动作/影响范围；不点击遮罩关闭 |
| 反馈 | 保存、删除、错误、读取、局部刷新 | 成功 Toast 只由明确用户动作触发；读取使用 loading/活动日志；Tooltip 无白边/halo |
| Loading | 首屏、列表、表格、Console、上传 | 中心为 VRC logo；平台名可在说明文字出现，但不替代 logo；支持 reduced motion |
| Electron | 冷启动、Dock activate、启动失败 | 最短约 1.8s，420-480ms 交叉淡入，主题先于主界面显示，失败可读 |

## 6. 建议执行顺序

1. Agent C 先清理 token、`.el-table`、Console terminal token 和确认入口公共 helper，避免其他 agent 在旧样式上继续加覆盖。
2. Agent A 收敛 Shell、总览、VM 表格滚动和行内操作列，保持现有数据/操作逻辑。
3. Agent B 统一各 Dialog 的字段、表格、footer、确认和响应式；定时任务组件以现有正式组件为唯一实现。
4. Agent C 完成 Electron 启动时序和原型隔离标记。
5. 主 agent 运行类型检查/构建，逐主题逐断点做浏览器验收，复核各 agent 的 diff 是否越界，再按模块提交。

## 7. 本轮审计限制

- 未启动 Web/Electron，也未执行 Playwright 或 DevTools 的真实像素/计算尺寸检查。
- 当前工作树已有用户未提交改动，本审计未修改这些业务文件；行号以审计时工作树为准，agent 开始修改前应重新确认行号。
- 本文是整改任务分派依据，不代表已完成任何修复；修复完成后应在本文对应条目补充命令、截图或测量结果。

## 8. 整改前构建基线

- 命令：`npm --workspace apps/web run build`
- 结果：通过，`vue-tsc -b` 与 Vite production build 均成功。
- 现有非阻断警告：`@vueuse/core` 的 PURE 注释位置被 Rollup 忽略；主 JS、CSS 和 `xlsx` chunk 超过默认 500kB 提示。UI 整改不得新增编译错误，性能拆包另行处理，不混入纯样式提交。

## 9. 修改记录

### 2026-07-21：连接搜索无匹配空态试验点

- 对应条目：3.4.1 `App.vue` 左侧连接列表搜索无匹配时缺少空态。
- 状态：已修复。
- 实际改动：
  - `apps/web/src/App.vue` 在已有连接但搜索结果为空时增加 `role="status"` 的“未找到匹配连接”提示；不改变筛选关键词、连接排序或加载逻辑。
  - `apps/web/src/styles.css` 增加 `.sidebar-search-empty`，使用主题弱文字 token、固定间距和普通文本排版，不添加背景、边框或卡片容器。
- 验证：执行 `npm --workspace apps/web run build`，`vue-tsc -b` 与 Vite production build 通过；执行 `git diff --check` 无空白错误。未进行浏览器截图、三主题切换和断点实测，待后续 UI 验收补充。
- 测试说明：
  1. 执行 `npm --workspace apps/web run dev`，打开终端输出的本地地址。
  2. 左侧已有连接时，在搜索框输入一个不存在的名称，例如 `不存在的连接-001`。
  3. 预期：连接列表区域显示“未找到匹配连接”，不出现大块背景或边框；清空搜索框后，连接分组恢复。

### 2026-07-21：连接 active 状态点固定尺寸试验点

- 对应条目：3.5 左侧连接列表 active 状态点改变尺寸导致布局位移。
- 状态：已修复。
- 实际改动：
  - `apps/web/src/styles.css` 将普通和 active 状态点统一为 `6px × 6px`、固定左侧间距；active 仅通过主题色和环形阴影表达，不再改变盒子尺寸。
  - 移除状态点宽高的过渡动画，避免切换连接时产生视觉位移；保留颜色和阴影过渡。
- 测试说明：
  1. 在左侧至少保留两个连接，先点击第一个连接，再点击第二个连接，重复切换几次。
  2. 观察连接名称、地址和端口列：active 状态切换时，文字起始位置和端口位置应保持不动。
  3. 在浅色、深色和至少一个主题色方案下检查：active 点只改变颜色/弱环，不应放大成 7px，也不应挤动相邻文字。
- 验证：已执行 `npm --workspace apps/web run build` 与 `git diff --check`，均通过；浏览器尺寸、三主题和真实点击切换仍需按上面步骤手工验收。

### 2026-07-21：连接选中态移除整行背景

- 对应条目：3.5 连接 active 不使用大面积 `--vrc-accent-soft`，改用外框表达当前连接。
- 状态：已修复。
- 实际改动：
  - `apps/web/src/styles.css` 为 `.connection-item.active`、active hover 和键盘 focus 覆盖最终背景为 `var(--vrc-surface)`。
  - active 外框改用 `var(--vrc-accent)`；保留原有 1px transparent 边框占位，切换时不会改变行尺寸。
  - 未修改资源总览入口、设置菜单和表格当前行的其他选中规则。
- 测试说明：
  1. 执行 `npm --workspace apps/web run dev`，打开终端输出的本地地址。
  2. 左侧至少保留两个连接，点击任意连接使其处于 active，再切换到另一个连接。
  3. 预期：选中行底色与普通列表 surface 一致，只看到外框变为主题 accent 色；名称、IP、端口位置不发生位移。
  4. 使用键盘 Tab 聚焦连接行，确认 focus ring 清晰，且不会重新出现整行 accent-soft 背景。
  5. 切换浅色、深色和至少一个主题色方案，确认外框颜色跟随主题 token。
- 验证：已执行 `npm --workspace apps/web run build` 与 `git diff --check`，均通过；浏览器实际点击、键盘 focus 和主题切换仍需按上面步骤手工验收。

### 2026-07-21：连接选中外框降对比度

- 对应条目：3.5 连接 active 外框颜色过重。
- 状态：已修复。
- 实际改动：
  - `apps/web/src/styles.css` 将 active 外框从纯 `var(--vrc-accent)` 调整为 `color-mix(in srgb, var(--vrc-accent) 42%, var(--vrc-border))`。
  - 保持选中行 `var(--vrc-surface)` 背景和 1px 边框占位不变，只降低外框对比度；未修改状态点和连接切换逻辑。
- 测试说明：
  1. 执行 `npm --workspace apps/web run dev`，打开终端输出的本地地址。
  2. 点击左侧连接，确认 active 行底色不变，外框仍可识别但不应比文字或主按钮更抢眼。
  3. 切换 Graphite Sage、Basalt Copper、Mist Teal，确认外框随各主题 accent/border 混合变化，不出现纯深色硬边。
- 验证：已执行 `npm --workspace apps/web run build` 与 `git diff --check`，均通过；浏览器主题切换和截图对比仍需按上面步骤手工验收。

### 2026-07-21：统一资源总览与连接列表 active 外框

- 对应条目：3.5 active 外框颜色需要跨入口一致，不能只调整连接列表。
- 状态：已修复。
- 实际改动：
  - `apps/web/src/styles.css` 新增 `--vrc-active-border` 语义 token，统一使用主色与普通边框的 42%/58% 混合色。
  - 资源总览入口 `.overview-entry` 与连接列表 `.connection-item` 的 hover/active 外框共用该 token；两者背景均保持 `var(--vrc-surface)`。
  - 设置菜单和表格当前行仍保留各自的选中语义，避免把不同交互层级强行合并。
- 测试说明：
  1. 执行 `npm --workspace apps/web run dev`，打开终端输出的本地地址。
  2. 在左侧分别观察“资源总览” active 外框和任意连接 active 外框，确认颜色一致、明度接近且都没有整块背景。
  3. 切换 Graphite Sage、Basalt Copper、Mist Teal，确认两个入口同步变化，不出现一个深色、一个浅色的分裂状态。
  4. 点击连接和资源总览来回切换，确认 1px 外框不会造成布局位移。
- 验证：已执行 `npm --workspace apps/web run build` 与 `git diff --check`，均通过；浏览器截图对比和三主题实测仍需按上面步骤手工验收。

### 2026-07-21：归一导航与列表选项 active 样式

- 对应条目：3.5、3.6，导航/列表选项 active 不能各自维护不同背景和边框颜色。
- 状态：已修复。
- 实际改动：
  - `apps/web/src/styles.css` 将资源总览、连接项、设置导航、设置主题选项、设置连接项和 IP 池项统一为 `var(--vrc-surface)` 背景 + `var(--vrc-active-border)` 外框。
  - active 选项不再铺 `--vrc-accent-soft` 大块背景；设置工作区导航使用同色 inset 外框避免改变固定高度。
  - segmented、Tabs、表格当前行、步骤条、开关保留各自交互语义，不纳入列表选项外框规则。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，打开本地地址。
  2. 依次检查左侧资源总览/连接项、设置导航、设置主题卡、设置连接项和 IP 池项的 active 状态。
  3. 预期：这些列表选中项均保持所在 surface，只显示同一明度的浅色 active 外框，不出现某一项深绿、另一项灰绿或整块 accent-soft 背景。
  4. 再检查 segmented、Tabs、表格当前行和开关，确认它们仍保持各自控件语义，没有被误改成列表外框样式。
  5. 切换三套主题，确认 active 外框颜色同步变化。
- 验证：已执行 `npm --workspace apps/web run build` 与 `git diff --check`，均通过；浏览器逐入口点击和三主题实测仍需按上面步骤手工验收。

### 2026-07-21：Chrome 插件 Tabs 与运行位置控件归一

- 对应条目：3.6.1 Chrome 插件“内网/本机”自绘 segmented；同页“服务地址/本地连接库”仍为自绘 Tabs。
- 状态：已修复。
- 实际改动：
  - `apps/web/src/App.vue` 将“服务地址/本地连接库”替换为标准 `el-tabs`，内容放入对应 `el-tab-pane`，复用组件的 Tab/TabPanel 语义和键盘切换。
  - 将“内网/本机”替换为标准 `el-segmented`，复用全局 28px 外盒、22px 选中项、12px/400 和主题 token；保留模式切换时自动调整 Host 并写入本地设置的既有逻辑。
  - `apps/web/src/styles.css` 删除该页面两套自绘按钮组选中样式；Tabs 使用 32px 下划线规范并在内容左侧对齐，首项与面板正文共用左边线；segmented 只保留布局宽度和外框差异。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，进入“设置 / Chrome 插件”。
  2. 点击“服务地址/本地连接库”，确认 Tabs 位于内容左侧、首项与下方面板正文左边线对齐，使用下划线样式而非 segmented 胶囊；两个面板内容切换正确。
  3. 用 Tab 键聚焦 Tabs，再使用左右方向键切换，确认焦点可见且面板同步变化。
  4. 在“服务地址”中切换“内网/本机”：外盒应为 28px、选中块为 22px；切到本机时默认 Host 变为 `127.0.0.1`，切回内网时恢复 `vrc-server`。
  5. 刷新页面，确认已选择的运行位置和服务地址仍从本地设置恢复；再切换三套主题检查 Tabs 和 segmented token 联动。
- 验证：已执行 `npm --workspace apps/web run build` 与 `git diff --check`，均通过；标准 Tabs 左对齐、点击切换和左右方向键切换已在本地浏览器实测通过。刷新持久化和三主题仍需按上面步骤手工验收。

### 2026-07-21：只读字段背景归一

- 对应条目：3.8，只读字段不应使用灰绿或强调色背景形成状态色块。
- 状态：已修复。
- 实际改动：
  - `apps/web/src/styles.css` 将全局 `readonly` 输入 wrapper 从 `--vrc-surface-muted` 改为 `--vrc-surface`，保留正常文字色和 1px `--vrc-border`。
  - `.vm-rename-readonly` 同步改为普通 surface 和正常文字色，避免 Element 输入与自定义只读展示出现两套口径。
  - Chrome 插件完整 Base URL 不再单独覆盖颜色，直接消费全局只读规范。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，进入“设置 / Chrome 插件 / 服务地址”。
  2. 对比“服务地址”普通输入和“完整 Base URL”只读输入：两者背景应同属普通 surface，边框同为弱边框；只读字段仍不能编辑。
  3. 打开虚拟机改名弹框，确认原名称只读字段使用相同 surface/弱边框口径，不再显示灰绿底。
  4. 切换三套主题及浅色/深色，确认只读字段不出现深绿、灰绿或强调色背景，文字仍清晰可读。
- 验证：已执行 `npm --workspace apps/web run build` 与 `git diff --check`，均通过。本地浏览器计算样式确认“服务地址”“端口”“完整 Base URL”的 wrapper 背景均为 `rgb(251, 252, 250)`、边框均为 `rgb(210, 219, 213)`，Base URL 仍为 readonly。改名弹框和三主题仍需按上述步骤手工验收。

### 2026-07-21：创建虚拟机数字步进器规格补充审计

- 对应条目：3.8.1 创建主参数和预案表格数字输入规格。
- 状态：已修复。
- 原问题：
  - 主参数区仍将普通控件强制为 28px，与 30px 普通表单规范不符；该问题原清单已记录。
  - 预案表格行内输入仍使用透明边框/inset 历史规则；该问题原清单已记录。
  - 主参数区步进按钮宽 28px，预案行内步进按钮宽 22px；该跨区域不一致此前未单独记录，本轮已补入 3.8.1。
- 实际改动：`apps/web/src/styles.css` 新增 `--vrc-number-step-width: 28px`，创建主参数、侧栏字段和预案行内字段统一使用 30px 控件高度、28×15px 步进按钮和单层弱边框；预案数字列调整为 78/84/92px。未修改 CPU、内存、磁盘、创建数量的取值范围、预案生成或提交逻辑。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，打开任意支持创建虚拟机的物理机并进入创建弹框。
  2. 测量主参数 CPU/内存/磁盘/创建台数：外框均应为 30px，上下步进按钮各 15px、宽 28px。
  3. 测量预案表格 CPU/内存/磁盘：外框、步进按钮宽高和主参数区一致，显式单层 1px 弱边框；hover 不改变边框，focus 仅切换边框色。
  4. 在 1440px、980px、700px 检查预案列：数字和值不重叠，按钮不溢出，不能通过重新压缩步进按钮解决列宽不足。
- 验证：执行 `npm --workspace apps/web run build` 与 `git diff --check` 均通过。本地浏览器在 Proxmox VE 创建弹框实测：主参数 4 个数字输入 wrapper 高度均为 30px，预案 CPU/内存/磁盘 wrapper 高度均为 30px；两处步进按钮均为 28px 宽、15px 高，wrapper 边框均为单层 1px。980px、700px 和三主题仍需按上述步骤继续验收。

### 2026-07-21：创建预案滚动与候选 IP 主题状态归一

- 对应条目：3.8.1 创建预案数据区滚动、候选 IP 筛选和卡片状态。
- 状态：已修复。
- 原问题：
  - 单条预案仍显示数据区滚动条；初版隐藏滚动后又漏算容器上下边框，数据行实际高度被裁掉 2px。
  - 候选 IP 曾使用浅绿/蓝色背景区分状态；选中主值若直接使用基础 `--vrc-accent`，在深色 surface 上可能对比度不足。
  - 候选区末层通用规则仍把 `.ip-candidates` 与安装步骤一起设为 muted 背景，状态口径不够清楚。
- 实际改动：
  - `VmProvisioningDialog.vue` 根据预案数量添加 `is-static-body`；1～3 行关闭数据区滚动和稳定 gutter，超过 3 行才启用统一滚动。容器高度改为 `34 + 行数 × 42px`、上限 160px，显式计入 2px 外框。
  - 候选 IP “可用/全部”使用 `el-segmented`；候选区、普通卡、选中卡均使用 `--vrc-surface`，普通卡使用弱边框，选中只改变 `--vrc-active-border` 和主值文字，不铺背景色。
  - 新增 `--vrc-active-text`、`--vrc-success-text` 前景语义 token；浅色模式沿用当前主题 accent/success，深色模式与 `--vrc-text` 混合提亮。选中卡的 IP 主值和状态小字统一使用 active text；未选中卡的“可用”说明使用 success text。
  - 玄武铜、雾青等主题继续提供各自基础 accent/success，深色前景由同一语义公式派生，没有增加页面专属颜色。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，打开 Proxmox VE 物理机的“创建虚拟机”，展开“网络配置 / IP 池”。
  2. 创建台数设为 1：预案数据区不应显示纵向滚动条；行内容上下不裁切，表头与数据列对齐。再设为 4，预期数据区出现统一滚动且表头保持固定。
  3. 检查候选 IP：普通卡、可用卡、选中卡背景完全一致；未选中“可用”只改变小字颜色，选中卡的 IP 主值和状态小字应一起切换为主题选中前景色，同时只增加弱外框。
  4. 检查“可用/全部”：外盒总高 28px、选中项 22px，切换后候选列表过滤正确，不影响当前首选 IP。
  5. 依次切换石墨青、玄武铜、雾青及浅色/深色。选中 IP 主值必须随主题变化；深色模式下不得继续使用偏暗的原始 accent，候选卡和候选区仍保持同一 surface。
- 验证：
  - `npm --workspace apps/web run build` 通过；仅保留既有 `@vueuse/core` PURE 注释和大 chunk 警告。`git diff --check` 通过。
  - 本地 Chrome 在 `127.0.0.1:5173` 的真实 Proxmox VE 创建弹框实测：单条预案 body 为 `overflow-y: hidden`、`scrollbar-gutter: auto`，`clientHeight=42`、`scrollHeight=42`，无滚动且无裁切；表格 `clientHeight=scrollHeight=74`。
  - 浅色石墨青下，候选区、普通卡、选中卡背景均为 `rgb(251, 251, 247)`；普通/选中只在边框和主值文字上产生差异。segmented 外盒含边框总高 28px，选中项 22px。
  - 补充点击验收：从 `192.168.2.32` 切换到 `192.168.2.34` 后，新选中卡的 IP 主值和“可用”小字计算颜色均为主题 active text `rgb(66, 107, 87)`；原卡恢复普通主值色和 success text。验收后已恢复首选 `192.168.2.32`。
  - 深色石墨青下，候选区、普通卡、选中卡背景均为 `rgb(22, 29, 33)`；选中主值对背景对比度 `6.05:1`，“可用”说明对比度 `6.52:1`。浏览器计算值确认 active/success 前景已混入深色正文色。
  - 深色下切换三套主题，active text 分别由石墨青 `#426b57`、玄武铜 `#9b5f35`、雾青 `#2f6f68` 派生，确认主题联动。验收后已恢复原设置“石墨青 + 跟随系统”，创建弹框保留在展开候选 IP 的页面供继续检查。

### 2026-07-21：候选 IP 选中后保持原顺序

- 对应条目：3.8.1 候选 IP 选择交互稳定性。
- 状态：已修复。
- 原问题：选择候选 IP 后，`orderAvailableIps()` 会把 `preferredIp` 强行提到数组第一位；例如 `.34` 从第二张卡跳到第一张卡，用户会误以为卡片发生漂移。
- 实际改动：`VmProvisioningDialog.vue` 删除首选 IP 置顶逻辑；可用候选始终沿用 IP 池枚举顺序，点击只更新 `preferredIp`、`selected` class 和首选提示，不改变候选数组顺序。未修改 IP 可用性判断、探测结果和创建预案数据。
- 测试说明：
  1. 打开创建虚拟机弹框并展开候选 IP，记录前 3 张卡的顺序，例如 `192.168.2.32 / 192.168.2.34 / 192.168.2.35`。
  2. 点击第二张卡 `192.168.2.34`。
  3. 预期：顺序仍为 `.32 / .34 / .35`；只有第二张卡的选中外框、主题文字和“首选 192.168.2.34”提示变化，不应移动到第一张。
  4. 再点击第一张卡，确认顺序仍稳定，首选提示和选中态正确切换。
- 验证：本地 Chrome 实测点击 `.34` 后候选索引仍为 `0=.32、1=.34、2=.35`，索引 1 变为 selected；随后已恢复首选 `.32`。`npm --workspace apps/web run build` 与 `git diff --check` 通过。

### 2026-07-21：资源扩容控件边框与滚动层级归一

- 对应条目：3.8.1 `VmResizeDialog.vue` 步进器、磁盘选择器和正文滚动容器。
- 状态：已修复本轮范围；小于 700px 的五列进一步重排仍待后续专项处理。
- 原问题：
  - 步进器输入聚焦时在已有 1px 外框内部再绘制 inset 边框，形成视觉双框。
  - 磁盘选择器残留 `--el-component-size: 28px`；虽被后层高度规则撑到 30px，但尺寸来源不一致，且组件自身未明确单层边框状态。
  - 扩容正文没有 max-height 和唯一滚动容器，窄窗口下 Dialog 可能超出视口；背景页面滚动条同时保留，形成双滚动观感。
- 实际改动：
  - `VmResizeDialog.vue` 将步进器 focus 改为外框 `border-color`，内部 label 不再绘制 inset。
  - 磁盘选择器统一消费 `--vrc-control-height` 30px，明确 `1px solid var(--vrc-border)`、surface 背景和无默认 shadow；hover/focus 只使用 border token。
  - `.vm-resize-content` 增加 `.vrc-scroll-container`、`max-height: calc(88vh - 124px)` 和稳定 gutter；扩容弹框存在期间锁定根页面滚动，关闭后自动恢复。
  - 自绘挂载目录 radio 卡补充 `focus-visible` 外框和 focus ring；未修改扩容请求、磁盘选择、账号验证或提交逻辑。
- 测试说明：
  1. 打开任意运行中 VM 的“资源扩容”，确认 CPU/内存/磁盘步进器与磁盘选择器均为 30px、单层 1px 弱边框。
  2. 点击“处理器增加量”：外框仍为 1px，只切换为强边框；输入区域内部不得再出现第二层 inset 或外扩阴影。
  3. 点击“选择目标磁盘”：控件高度保持 30px，focus 前后盒子尺寸不变；关闭下拉后布局不位移。
  4. 在 980×700 和 700×700 下检查：Dialog 顶部、footer 均在视口内，正文单独纵向滚动，资源五列无横向滚动，背景页面不出现可操作的第二条滚动条。
  5. 取消关闭弹框，确认根页面滚动恢复；不得点击“确认扩容”。
- 验证：
  - 本地 Chrome 计算样式：stepper focus 后 `borderWidth=1px`、label `boxShadow=none`、外层不显示 focus ring；磁盘 select `--el-component-size=30px`、wrapper 高 30px、边框 1px。
  - 980×700 下 Dialog 为 948×618px、顶部 42px、底部 660px；正文 `clientHeight=492`、`scrollHeight=665`、`overflow-y=auto`，页面根高度仍为 700px。
  - 700×700 下资源行 `clientWidth=scrollWidth=617`，无横向溢出；正文 `clientHeight=492`、`scrollHeight=767`。弹框打开时根节点 `overflow-y=hidden`，关闭并等待退场动画后恢复 `visible`。
  - 验收仅打开/取消弹框，未提交扩容、未改变 VM 或 XenServer/Proxmox 状态。`npm --workspace apps/web run build` 与 `git diff --check` 通过。

### 2026-07-21：系统镜像 Dialog 密度与动作归一

- 对应条目：2.1 `ISO Dialog`。
- 状态：已修复。
- 口径更正：前面“表格最大视口基本符合”的结论不准确。原实现使用固定 `height="420"`，只有两行镜像时仍保留大面积空白；这是数据密度问题，不属于已符合项。
- 原问题：
  - 搜索框和刷新入口放在同一个未分组容器中，查询与动作语义不清。
  - 刷新使用页面专属蓝色文字按钮，未复用全局 28px 工具栏按钮和 `VrcToolbarIcon`。
  - 表格固定 420px，少量数据不能随内容收缩；旧 `.cache-refresh-link` 即使不再使用仍残留多层样式。
- 实际改动：
  - `App.vue` 将弹窗头拆成摘要、`iso-dialog-query-group` 和 `iso-dialog-action-group`；刷新使用全局 `toolbar-action-button`、`VrcToolbarIcon name="refresh"`、Tooltip 和 `aria-label`。
  - 表格从固定 `height` 改为 `max-height="420"`：少量数据按真实行数收缩，超过上限后由 Element Plus 数据区滚动并固定表头，不再依赖手写表头/行高计算。
  - `styles.css` 将摘要固定为首行，查询和刷新固定为第二行；搜索消费统一 muted 查询控件规则，刷新消费统一主题边框/文字 token；删除无调用方的 `.cache-refresh-link` 及其页面覆盖。
  - 未修改 ISO 查询、刷新、筛选、排序或后端接口逻辑；浏览器验收只读取镜像列表，未修改虚拟机、存储或服务器状态。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，选择已有连接和物理机，点击资源摘要中的“ISO”打开“系统镜像”。
  2. 在只有 1～2 行镜像时检查：表格应紧跟最后一行结束，弹窗下方不再保留约 300px 空白；搜索框高 30px，刷新为 28×28px 图标按钮，悬停显示“刷新系统镜像”。
  3. 输入镜像名、ISO 库或路径关键字：只过滤当前列表，不改变表格列和弹窗宽度；清空后恢复完整列表。
  4. 在包含至少 10 行镜像的只读测试数据或物理机上打开弹窗：表格总高不得超过 420px，表头保持固定，只滚动表格数据区。
  5. 在 `980×700` 和 `700×700` 检查：摘要始终独占第一行，搜索和刷新位于第二行且不重叠，弹窗完整位于视口内。切换浅色/深色，搜索背景、刷新边框和表格文字应跟随主题 token。
- 验证：
  - `npm --workspace apps/web run build` 通过；仅保留既有 `@vueuse/core` PURE 注释和大 chunk 警告。`git diff --check` 通过。
  - 本地隔离 Chrome 读取 `pve-20` 的真实两行 ISO：980px 下表格总高 120px、数据区 80px、弹窗总高 294px；没有固定高度空白，数据区 `clientHeight=scrollHeight=80px`。
  - 输入第一条镜像名后，筛选结果变为 1 行且表格同步收缩到 80px；清空搜索后恢复 2 行和 120px，筛选过程中弹窗宽度未变化。
  - 隔离浏览器仅在前端内存中复制现有行生成 12 行后，表格总高封顶 420px；内层滚动容器 `clientHeight=380px`、`scrollHeight=480px`、`overflow-y=auto`，表头独立保持 40px。测试结束后已恢复原两行数组，未发送后端写请求。
  - 700×700 深色实测：弹窗顶部 56px、底部 350px，完整位于视口；搜索宽 594px、刷新 28×28px，二者无重叠。深色 surface、搜索 muted surface、边框和正文均读取全局主题 token。

### 2026-07-22：系统镜像 Dialog 行布局与重复间距复核

- 对应条目：2.1 `ISO Dialog`，延续 2026-07-21 的密度整改。
- 状态：已修复。
- 规范依据：`UI样式规范归档.md` 5.2 已明确“查询靠左、刷新等动作靠右、空间不足时查询先换行”；`UI设计规范.md` 4.4 同样要求查询属于左侧数据过滤、操作按钮属于右侧动作。本轮不重复新增规范，按既有规则修正实现。
- 口径更正：前一版只在 820px 以下让摘要与查询换行，桌面端仍采用摘要、搜索、刷新同排；同时只清除了 `.el-dialog__body` padding，没有识别 Element Plus `.el-dialog` 自身已有 16px padding，导致内部容器再次增加 16px。此前“桌面布局已归一”的表述不完整。
- 根因与判断：
  - 实测 `.iso-dialog` 自身 padding 为 16px，标题距 Dialog 左边实际 17px（含 1px 边框）。
  - `.iso-dialog-head` 和 `.iso-table-wrap` 又各自增加左右 16px，使摘要、查询和表格距 Dialog 左边达到 33px；表格底部也由内部 16px 与 Dialog 16px 叠加为 33px。
  - 应保留 Dialog 的统一 16px 安全边距，以维持标题和关闭按钮位置；应删除业务内容容器的重复 padding，而不是清空整个 Dialog padding。
- 实际改动：
  - `styles.css` 将摘要设置为 `grid-column: 1 / -1`，在全部桌面/窄屏宽度下独占第一行；查询和刷新固定在第二行，查询贴左、刷新贴右，中间使用弹性空白；820px 以下查询自动占满剩余宽度。
  - `.iso-dialog-head` 改为 `padding: 0 0 10px`，`.iso-table-wrap` 改为 `padding: 0`；仅保留 `.iso-dialog` 自身 16px padding。
  - ISO 标题区底部 padding 从 Element 默认 16px 收敛到 10px，避免标题与首行摘要之间再叠加内部顶部 8px。
  - 未修改镜像查询、筛选、刷新或表格数据逻辑。
- 测试说明：
  1. 打开“系统镜像”，确认摘要卡独占第一行；搜索框与刷新图标在第二行，搜索贴左、刷新贴右，不再和 58px 高摘要卡并排居中。
  2. 对齐检查：标题、摘要卡、表格左边线应在同一垂直线上；摘要卡和表格右边线也应一致。
  3. 使用浏览器计算样式检查 `.iso-dialog`：padding 应为 16px；`.iso-dialog-head` 应为 `0 0 10px`；`.iso-table-wrap` 应为 0。
  4. 测量 Dialog 四周：标题/摘要/表格距左边实际均为 17px，表格距右边和底边也均为 17px，不应再出现 33px 双层间隙。
  5. 在 `980×700` 浅色和 `700×700` 深色下复核：摘要位于查询上方，搜索与刷新无重叠，弹窗完整位于视口。
- 验证：
  - 1285×926 实测：第二行网格为 `280px / 554px / 28px`，搜索左坐标 199.5px 与摘要、表格一致，刷新右坐标 1085.5px 与摘要、表格一致；摘要底部 183px、查询顶部 191px，行间距 8px。
  - 980×700 浅色实测：标题、摘要、搜索、表格左坐标均为 47px；刷新和表格右坐标均为 933px；外侧右边和底部间隙均为 17px。
  - 700×700 深色实测：标题、摘要、表格左坐标均为 33px；搜索宽 594px，与刷新无重叠；Dialog 顶部 56px、底部 350px，完整位于视口。
  - 700×700 下临时使用 12 行前端内存数据复核：表格封顶 420px、数据区 `clientHeight=380px`、`scrollHeight=480px`；Dialog 底部 650px，仍在视口内，表格到底边保持 17px。测试后已恢复真实两行数据。
  - `npm --workspace apps/web run build` 与 `git diff --check` 通过；仅保留既有 PURE 注释和大 chunk 警告。

### 2026-07-22：全量样式整改、活动日志与 VM 操作列复核

- 对应条目：2.1～2.5、3.2～3.9，以及本轮用户对活动日志、VM 操作列、扩容入口和响应式的逐项反馈。
- 状态：已修复本轮确认范围。
- 口径更正：
  - 前面“活动日志保留左侧语义线”的说法不准确。准确口径是日志项四边均为 1px 弱边框，状态只改变右侧文字色。
  - 前面“资源扩容移到磁盘列、操作列固定 146px”的说法不准确。准确口径是扩容保留在操作列；支持扩容时列宽 176px，不支持时 144px。
  - 日志列表右侧较大间隙不是浏览器默认行为，而是显式 `scrollbar-gutter: stable` 预留约 11px 槽位；普通短列表不应预留。
- 实际改动：
  - `App.vue`：活动日志筛选改为标准 `el-segmented`；日志行改为单击可聚焦按钮；设置页自绘开关改为 `el-switch`；账号导入改为标准 Tabs 和固定 footer；Host/SR/Chrome 表格补唯一滚动容器；IP 池删除/清空与定时任务删除复用统一确认入口。
  - `styles.css`：日志搜索纳入公共 muted 查询输入规则，状态筛选统一 28px 外盒/22px 选中项/12px/400/无投影；日志项去掉左侧粗线和状态色边框；侧栏日志图标透明且无边框；短列表取消稳定滚动槽，Dialog 内容左右实测均为 17px。
  - `HostVmPanel.vue`：系统列 170px 且表头/正文左对齐；扩容恢复为操作列第五个图标；操作列按 Provider 能力使用 176/144px，磁盘列只展示容量；五个动作统一 26px、原生 `title` 和 `aria-label`。Esc 关闭扩容 Dialog 后，回焦按钮不显示背景、边框或阴影。
  - `styles.css`：700px 下 VM 工具栏标题取消错误的 232px 纵向 flex-basis，VM 详情 Dialog 高度扩至视口安全范围，避免表格数据区被挤成 0px；页面保持无横向溢出，表格内部横向滚动。
  - `VmScheduleDialog.vue`：目标查询与批量动作分组；编辑/删除补 title 和可见焦点；正式创建、编辑、任务管理继续使用同一组件。
  - `VmResizeDialog.vue`：700px/980px 下资源字段响应式重排；数字减少按钮使用真实 disabled；正文使用唯一滚动容器；步进器、选择器保持 30px 单层边框。
  - `styles.css`、`ConsoleDialog.vue`：终端色值归入主题 token，清理重复 Console 规则并固定唯一滚动层级；业务正式代码不再使用未定义的 `--vrc-text-secondary`。
  - `apps/electron/main.cjs`：启动动画最短显示 1800ms，主界面就绪后约 460ms 交叉淡入；`apps/web/src/prototypes/README.md` 明确原型不进入生产入口。
  - `confirmAction.ts`：新增共享危险确认 helper，业务代码不再各自拼装 `ElMessageBox.confirm`。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，打开 `http://127.0.0.1:5173/`。
  2. 左侧展开“操作记录”并打开“详情”：图标不得有背景/边框；搜索框为 30px、最大 320px、muted 背景；“全部/处理中/成功”等为 28/22px segmented，文字不加粗且无投影；日志项四边边框等宽，右侧不得多出空白槽。
  3. 在“设置 / 外观”切换浅色、深色和三个主题，再回到日志 Dialog：搜索、segmented、列表和状态文字必须全部跟随 token，深色下不得出现看不清的原始浅色主题值。
  4. 打开支持扩容的 Proxmox VM 清单：操作列应为 176px，顺序为开机、关机、强制重启、扩容、删除；磁盘列不得出现“扩容”文字。不支持扩容的平台操作列应为 144px 且只有四个图标。
  5. 点击扩容图标，只打开 Dialog 不提交；按 Esc 关闭，确认焦点回到扩容图标后仍为透明背景、透明边框、无阴影。
  6. 在 980×700 和 700×700 检查 VM 详情：700px 下 Dialog 高度为视口减 32px，表格数据区必须可见；页面本身无横向溢出，宽表只在表格内部横向滚动。
  7. 打开“虚拟机定时任务”：查询筛选靠左、批量动作独立分组，目标表数据区滚动；只检查创建/编辑/取消，不点击“创建计划”或任何 VM 动作。
  8. 进入设置各分组，检查标准 switch、Tabs、表格空态、账号导入 footer 和 Chrome 本地连接表滚动；确认 active 列表只使用统一弱外框，不铺主题色背景。
- 验证结果：
  - `npm --workspace apps/web run typecheck` 通过。
  - `npm --workspace apps/web run build` 通过；仅有既有 `@vueuse/core` PURE 注释和大 chunk 提示。
  - `npm --workspace apps/web test` 通过，13/13。
  - `node --check apps/electron/main.cjs` 通过；`git diff --check` 通过。
  - 活动日志在 980×700、700×700 均无页面横向溢出；Dialog 左右内容间距均为 17px。700px 下搜索 320×30px、segmented 258×28px，日志项与列表同宽。
  - 玄武铜深色实测：搜索和 segmented 外盒使用深色 muted surface，选中块使用深色 surface，日志项四边均为相同弱边框且无左侧状态线。验收后已恢复“玄武铜 + 跟随系统”。
  - `pve-26` 真实 4 行 VM 清单实测：操作列表头/内容均为 176px，每行 5 个 26px 图标，磁盘列无扩容入口；扩容 Dialog 按 Esc 后回焦按钮计算样式为透明背景/边框、`box-shadow: none`。
  - 700×700 VM 详情实测：修正前表格数据区为 0px；修正后 Dialog 高 668px、表格 149px、数据滚动区 109px，页面横向溢出为 0。
  - 定时任务 Dialog 在 980×700 下为 880px 宽，目标筛选为 30px 单行；只打开和取消，未创建任务。
  - Electron 启动/退出时序仅完成语法与代码路径检查，本轮未实际打包启动进行动画目测。
  - 浏览器验收只读取资源、打开并取消 Dialog；未提交扩容、未执行开关机/重启/删除/创建计划，未改变 XenServer、Proxmox、VM、存储或网络状态。
- 多 agent 协作：
  - `vm_list` 负责 Host/VM 清单；其“扩容移到磁盘列、操作列固定 146px”方案经主 agent 复核后已按用户最新要求纠正为操作列 176/144px。
  - `vm_dialogs` 负责定时任务和扩容 Dialog 的响应式、焦点和 disabled 状态。
  - `theme_console` 负责主题/Console token、Electron 启动时序和原型隔离。
  - 三个子 agent 均已完成并回收；最终代码、规范口径和浏览器验收由主 agent 统一复核。

### 2026-07-22：IP 池、维护统计、日志入口与扩容 Dialog 回归整改

- 对应反馈：本轮用户列出的 1～5 项界面回归。
- 状态：5 项均已完成代码整改或核实；未修改任何业务数据和虚拟化资源状态。
- 口径补充：
  - 设置日志页截图中的“右侧加粗边框”实际不是 segmented 选项卡边框，而是每条 `.settings-log-row` 遗留的左侧 3px 状态线。完整日志 Dialog 的 segmented 已符合 28/22px、无业务边框、无投影规范，不应误改。
  - “查看完整记录”是明确命令，当前 Element 普通按钮实测 30px、12px/400、四边 1px 弱边框，符合命令按钮规范，本轮核实无需改。
  - 扩容正文右侧空隙不是浏览器默认保留，而是 `16px` 右 padding 与 `scrollbar-gutter: stable` 固定槽叠加；无溢出时会形成约 31px 视觉间距。
- 分项处理：
  1. `IP 池内部边框与间距`，状态：已修复。`.ip-pool-card` 清除继承的 12px gap 并保持 overflow hidden；`.ip-pool-layout` 删除额外 `0 12px 12px` padding。保留单一外框和内部一条分割线，桌面竖线从内容区顶到底，左栏内容只保留自身 10px 安全间距。
  2. `日志边框与按钮`，状态：已修复/已核实无需改。设置页 `.settings-log-row` 删除 3px 状态左线，完整日志和设置日志统一四边 1px 弱边框；状态只改变标题/状态文字色。segmented 和“查看完整记录”按钮已符合规范，未为追求改动量增加页面专属样式。
  3. `维护统计卡`，状态：已修复。`.maintenance-summary-grid article` 使用普通 `--vrc-surface`、四边 1px、7px 圆角、50px 最小高度和 15px 主数值；不再使用 muted 整块底色制造状态卡观感。
  4. `首页底部操作记录`，状态：已修复。`.activity-line` 删除 2px 状态左线，统一 `--vrc-surface-raised` 和四边 1px；成功、处理中、失败、信息只改变标题文字色，hover/focus 继续使用主题 token。
  5. `虚拟机扩容 Dialog`，状态：已修复。`.vm-resize-content` 改为 `scrollbar-gutter: auto`，无溢出时不再固定预留右槽；`.vm-resize-footer` 改用 Dialog 主表面 `--vrc-surface`，保持固定 footer、无顶部分割线和 30px 命令按钮。
- 规范追加：
  - `UI样式规范归档.md` 增加设置页两栏分割线贯穿、禁止外层 gap/padding 截断和禁止 card-in-card 的规则。
  - 增加普通 Dialog footer 必须与主表面同色、普通正文默认 `scrollbar-gutter: auto` 的规则；固定表头表格的数据区仍可按列线补偿需求使用 `stable`。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，打开“设置 / IP 池”。桌面宽度下检查列表与编辑器之间只有一条竖线，竖线从标题下内容区顶部贯穿到底部；搜索框和第一条 IP 池距左栏边缘约 10px。将窗口缩到 980px 左右后，两栏上下排列，横向分割线必须完整贯穿。
  2. 打开“设置 / 日志”。每条日志四边应均为 1px 同色弱边框，左侧不得出现 3px 状态线；“查看完整记录”为 30px 普通命令按钮。打开完整记录后，搜索框为 30px muted 查询样式，状态筛选外盒 28px、选中项 22px、无粗边和投影。
  3. 打开“设置 / 维护”。四个统计卡背景应与普通 surface 一致，四边 1px，不出现整块灰米/灰绿状态底；数值为 15px 且不挤压标签。切换深色后背景和边框必须同步切换。
  4. 返回总览并展开左侧底部“操作记录”。每条记录使用 raised surface 和四边 1px；成功、信息等状态只改变标题文字色，左边不得出现绿色/橙色粗线。
  5. 打开一台运行中的 VMware VM 清单，点击操作列“资源扩容”；只查看不提交。无正文溢出时，内部主布局距 Dialog 左右应均为约 17px；footer 背景应与 Dialog 主体相同。缩短窗口高度制造正文溢出时，只允许正文滚动，footer 保持固定，滚动条按需出现。
  6. 在玄武铜浅色/深色各复核一次，再检查石墨青或雾青：active IP 池仅弱外框，日志状态文字、维护统计卡、扩容 footer 必须全部消费主题 token，不出现硬编码浅色值。
- 浏览器实测：
  - 1280×720 浅色：IP 池 layout/list/editor 的纵向范围均为 `148..651px`，竖线完整贯穿；列表项距左栏 10px，页面横向溢出为 0。
  - 980×700：IP 池折叠后列表底线与编辑区起点对齐，横向分割线无断点。
  - 1280×720 玄武铜深色：设置日志、完整日志、首页操作记录均为四边 `1px` 同色；维护统计卡背景等于 `--vrc-surface`；IP 池分割线仍完整贯穿。
  - 真实 VMware 扩容 Dialog 只读实测：Dialog 960px，正文 `clientWidth=scrollWidth=958px`、`scrollbar-gutter=auto`，无溢出；主布局距左右均为 17px。footer 计算背景与 `--vrc-surface=#161d21` 一致。
- 自动验证：
  - `npm --workspace apps/web run typecheck`、`npm --workspace apps/web run build`、`npm --workspace apps/web test`、`node --check apps/electron/main.cjs`、`git diff --check` 均通过；Web 测试为 13/13，构建仅保留既有 PURE 注释和大 chunk 提示。
  - 本轮浏览器只读取资源清单、打开并取消扩容 Dialog；未点击确认扩容，未执行开关机、重启、删除或任何 XenServer/VM 变更。
- 多 agent 协作：
  - `ip_pool_layout` 负责 IP 池两栏分割线与密度；`settings_activity` 负责维护统计卡及两处日志入口；`resize_dialog_spacing` 负责扩容正文和 footer。
  - 三个子 agent 均已完成并回收；主 agent 已逐项复核源码、计算样式和真实 Dialog，文档与最终验收结论由主 agent 统一收口。

### 2026-07-22：Chrome 插件 Tab2 本地连接表格铺满

- 对应反馈：Chrome 插件第二个 Tab“本地连接库”列表底部没有铺满。
- 状态：已修复。
- 真实问题与根因：
  - Tab2 左右并排时，右侧“新增连接 + 存储口径”总高为 370px，并由 CSS Grid 将左侧面板同步拉高到 370px。
  - 左侧面板仍是普通 block 流，Element 表格空态被固定为 228px；表头和空态合计后表格只有 268px，未消费面板剩余高度，底部留下 47px 空白带。
  - 这不是数据为空必须保留的留白，也不是滚动条预留；属于左侧面板高度轨道没有归一。
- 实际改动：
  - `App.vue` 给 Tab2 布局和左侧面板增加 `chrome-extension-vault-layout` / `chrome-extension-vault-panel` 语义类，并给本地连接表设置 `height="100%"`；未影响“服务地址”Tab。
  - `styles.css` 将 Tab2 左侧面板改为 `auto minmax(0, 1fr)` 两行：标题区按内容高度，表格容器和 Element Table 消费全部剩余高度。
  - 980px 以下恢复 `auto auto` 与表格内容自适应高度；两列改为上下排列后不会为了匹配已移到下方的表单而制造大面积空表格。
  - `UI样式规范归档.md` 增加并排表格/表单场景的剩余高度轨道规则，明确禁止固定 empty 高度造成面板底部空白带。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，进入“设置 / Chrome 插件”，切换到“本地连接库”。
  2. 在没有本地连接时检查：左侧表头以下的 empty 区应连续铺到左侧面板底边；空态文字在可用数据区内垂直居中，底部不得出现独立空白带。
  3. 对齐检查：左侧表格面板底边与右侧“存储口径”卡片底边应处于同一水平线；表格自身到底部只保留 1px 外框。
  4. 新增只用于本机测试的连接后检查：数据行保持 48px，超过可用高度时只滚动表格数据区，表头固定；完成后可删除测试连接。本轮自动验收未新增或删除连接。
  5. 将窗口缩到 980px 以下：左侧列表和右侧新增表单应上下排列，空列表恢复内容自适应高度，不应被强行拉成与下方表单等高。
  6. 切换浅色/深色：表头继续使用 muted surface，空态和数据区使用普通 surface，边框及文字全部跟随主题 token。
- 浏览器实测：
  - 1280×720 浅色，修正前左侧面板 370px、表格 268px，扣除 54px 标题后仍有 47px 底部空白。
  - 修正后左侧面板仍为 370px，轨道为 `54px 314px`，表格增至 314px、empty 区增至 274px；表格到底边仅剩 1px 外框，左右面板底边差为 0。
  - 玄武铜深色下表格和面板均使用 `--vrc-surface`，底部间距仍为 1px，页面横向溢出为 0。
- 自动验证：
  - `npm --workspace apps/web run typecheck`、`npm --workspace apps/web run build`、`npm --workspace apps/web test`、`git diff --check` 均通过；Web 测试为 13/13，构建仅保留既有 PURE 注释和大 chunk 提示。
  - 本轮只切换设置页 Tabs 和主题进行浏览器检查；未保存 Chrome 连接，未执行任何 VM/XenServer 变更。

### 2026-07-22：列表型选中态主文字与图标主题化

- 对应反馈：资源总览、连接列表、设置导航等选中项是否需要字体变色。
- 状态：已优化。
- 判断与根因：
  - 应增加文字反馈，但不能让整项所有文字都变色。选中主标题和图标使用主题 active text，副说明、IP、端口继续 muted，才能兼顾定位效率和高密度扫读。
  - 当前候选 IP 已使用 `--vrc-active-text`，但资源总览仅图标使用基础 accent，连接主名称和设置导航仍使用普通正文色，三类列表型 active 反馈不一致。
  - 深色模式不能直接使用基础 accent；应继续消费现有 `--vrc-active-text`，由深色 token 与正文色混合提高对比度。
- 实际改动：
  - `styles.css` 将资源总览 active 的主标题/图标、连接 active 的主名称、设置导航 active 的文字/图标统一为 `--vrc-active-text`。
  - 同步覆盖设置主题项、设置连接项和 IP 池项的 active 主标题，避免截图入口修好而其他选项仍使用普通正文色。
  - active 背景继续保持 `--vrc-surface`，外框继续使用 `--vrc-active-border`；副说明、IP、端口不变色，所有主文字保持 `font-weight: 400`。hover 只调整边框，不提前显示选中文字色。
  - `UI样式规范归档.md` 将列表型 active 规则明确为“弱外框 + 主值/图标 active text + 次级信息 muted”，并要求深色消费前景语义 token。
- 测试说明：
  1. 在资源总览、任意连接和设置分组之间依次切换，只有当前选中项的主标题与图标应变为主题色；背景保持普通 surface，外框保持弱 active border。
  2. 连接选中后检查：连接名称变色，IP 和端口继续 muted；三列位置和字重不发生变化。
  3. 资源总览选中后检查：“资源总览”和左侧图标变色，“查看全部物理机”继续 muted。
  4. 设置导航选中后检查：图标和“创建模板”等主文字同色；从“创建模板”切换到“IP 池”时，前一项立即恢复普通 muted/正文色。
  5. 在石墨青、玄武铜、雾青的浅色/深色各检查一次：选中文字必须随主题变化，深色下不得使用过暗的原始 accent。
  6. 键盘 Tab 聚焦与 active 要区分：焦点仍使用统一 focus ring，不能用持续背景色或加粗模拟选中。
- 浏览器实测：
  - 玄武铜浅色：资源总览、连接名称、设置导航的 active 主文字/图标均为 `rgb(155, 95, 53)`；副说明/IP/端口均为 `rgb(118, 111, 99)`，主文字字重 400，页面横向溢出为 0。
  - 玄武铜深色：`--vrc-active-text` 由铜色与 `--vrc-text` 混合提亮，三类主文字/图标计算色一致；副说明/IP/端口为深色 muted，背景保持 `rgb(22, 29, 33)`。
- 自动验证：
  - `npm --workspace apps/web run typecheck`、`npm --workspace apps/web run build`、`npm --workspace apps/web test`、`git diff --check` 均通过；Web 测试为 13/13，构建仅保留既有 PURE 注释和大 chunk 提示。
  - 本轮浏览器只执行页面导航和主题切换；未执行任何连接保存、VM 或 XenServer 变更。

### 2026-07-22：设置卡片与日志行背景归一

- 对应反馈：设置 / 外观和设置 / 日志页面出现大面积米色背景。
- 状态：已优化。
- 真实问题与根因：
  - 未选主题卡和底部偏好项分别使用 `--vrc-surface-muted`，设置日志、完整日志和首页操作记录使用 `--vrc-surface-raised`；玄武铜浅色下这些 token 与主表面色差较大，同层内容被误表现成整块状态区。
  - active 主题卡已经使用普通 `--vrc-surface`，导致选中卡反而比未选卡更浅，背景层级与选中语义相互冲突。
- 实际改动：
  - `.settings-theme-card`、`.settings-tile`、`.settings-log-row`、`.activity-log-item`、`.activity-line` 统一改用 `--vrc-surface`。
  - 主题卡 active 继续只改变 `--vrc-active-border`、主文字和图标颜色，不增加选中背景；日志状态继续只改变标题或状态文字颜色。
  - 自定义主题中的设置行原本未铺独立背景，本轮核实无需增加页面专属覆盖；查询输入、表头和弱提示仍保留 muted surface。
  - `UI样式规范归档.md` 收紧 surface token 使用边界，删除“raised 用于选中卡片”的旧口径。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，进入“设置 / 外观”。三个主题卡和底部四个偏好项背景应与内容主表面一致，不再出现整块米色；卡片仍保留四边 1px 弱边框。
  2. 依次选择石墨青、玄武铜、雾青：只有当前主题卡的边框、主标题和图标变为主题 active 色，卡片背景不得变化，副说明保持 muted。
  3. 进入“设置 / 日志”：每条日志背景应为普通 surface，状态只改变标题文字；再点击“查看完整记录”，Dialog 日志行同样不得出现 raised 色块。
  4. 返回首页检查底部“操作记录”：日志行背景与所在面板一致，四边弱边框仍可见，左侧不得出现状态粗线。
  5. 分别在浅色和深色下重复步骤 1～4；确认普通卡和日志行消费 `--vrc-surface`，查询输入、表头、弱提示区仍使用 `--vrc-surface-muted`，页面无横向溢出。
- 自动验证：
  - `npm --workspace apps/web run typecheck` 通过。
  - `npm --workspace apps/web run build` 通过；仅有既有 `@vueuse/core` PURE 注释和大 chunk 提示。
  - `npm --workspace apps/web test` 通过，13/13；`git diff --check` 通过。
  - 浏览器 1280×720 实测：玄武铜浅色下 `--vrc-surface=#fcfaf5`，主题卡、偏好 tile、设置日志和完整日志行计算背景均为 `rgb(252, 250, 245)`，横向溢出为 0。
  - 玄武铜深色下 `--vrc-surface=#161d21`，上述卡片与日志行计算背景均为 `rgb(22, 29, 33)`；active 主题卡仅边框和主文字变色。验收后已恢复“玄武铜 + 跟随系统”。

### 2026-07-22：侧栏设置入口选中态柔化

- 对应反馈：侧栏品牌区设置按钮选中外框过粗，需要更柔和。
- 状态：已优化。
- 真实问题与根因：设置入口进入 active 后仍继承通用 `.icon-button.active` 的 2px outline 和 2px 外扩，同时点击焦点又叠加 2px focus ring、accent-soft 背景；多层强调叠加后形成明显粗框。
- 实际改动：
  - 设置入口基础盒子增加透明 1px 边框，保证 hover / active 切换时尺寸不抖动。
  - active 改为单层 1px `--vrc-active-border`、普通 surface 背景、active text 和极浅 4px 投影，并显式清除通用 outline。
  - `focus-visible` 只在 active 规格外增加 8% 透明度的 2px halo，点击或按 Esc 回焦时不再出现多层粗框；浅色和深色均消费主题 token。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，从资源总览点击右上设置齿轮；按钮盒子应保持 32x32px，选中后只有 1px 弱边框和很浅的投影，不出现外扩粗线。
  2. 鼠标移出按钮后检查 active：背景应与侧栏主表面一致，齿轮和边框使用当前主题色，按钮尺寸和品牌区布局不得移动。
  3. 使用键盘 Tab 聚焦设置入口：可出现低透明 halo，但不得同时出现第二层实线 outline；按 Enter 打开设置后仍保持柔和。
  4. 在玄武铜浅色和深色各检查一次，再切换任一其他主题；边框、文字和 halo 必须跟随 token，深色下不得消失或发亮成白框。
- 自动验证：
  - `npm --workspace apps/web run typecheck` 通过。
  - `npm --workspace apps/web run build` 通过；仅有既有 `@vueuse/core` PURE 注释和大 chunk 提示。
  - `npm --workspace apps/web test` 通过，13/13；`git diff --check` 通过。
  - 玄武铜浅色 1280×720 实测：设置入口为 32x32px、1px active border、`outline-style: none`；点击焦点只叠加 8% 透明度 halo，未出现第二层实线框。
  - 玄武铜深色实测：设置入口仍为 1px active border、surface 背景和 8% 浅投影，文字与边框消费深色主题 token；页面布局无偏移。验收后已恢复“玄武铜 + 跟随系统”。

### 2026-07-22：侧栏与工作区主分界线归一

- 对应反馈：物理机侧栏与右侧总览 / 设置区域交界处线条叠加；设置页根容器圆角导致顶部不贴合；建议增加轻阴影建立层级。
- 状态：已优化。
- 真实问题与根因：
  - `.sidebar` 使用 1px 右边框，直接相邻的 `.overview-panel` / `.settings-workspace-panel` 又继承通用 `.panel` 的 1px 左边框，两条线落在同一网格分界处，视觉接近 2px。
  - 设置根面板同时继承 7px 圆角，左上角露出工作区底色，导致主分界线顶部出现缺口，和直角侧栏无法贴合。
- 实际改动：
  - 保留侧栏 1px 右边框，统一清除工作区直属 `.panel` 的左边框和外层圆角；覆盖 loading、overview、settings 三类根面板，内部卡片圆角不受影响。
  - 新增 `--vrc-sidebar-shadow`：浅色使用向右 4px、4.5% 黑色阴影，深色使用向右 4px、20% 黑色阴影；侧栏提升到同级工作区之上，确保阴影只向内容区柔和扩散。
  - `UI样式规范归档.md` 增加“主分界只由一侧绘制”的硬规则，禁止边框叠加和圆角缺口。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，打开物理机总览；侧栏与表格区之间只能看到一条 1px 分隔线，右侧根面板 `border-left-width` 应为 0。
  2. 点击设置齿轮；设置根面板左上角必须为直角并从顶部贴合侧栏，不能出现背景色缺口，内部设置导航和内容卡仍保留各自圆角。
  3. 在浅色下观察分界线右侧：允许有很淡的 4-12px 扩散阴影，但不能看成第二条灰线；滚动左侧连接列表时阴影位置保持固定。
  4. 切换深色复核：分界阴影应表现为暗层级，不得出现白边或发光；页面横向宽度和 220px 侧栏轨道不得变化。
  5. 再检查 loading 页面和任意单物理机页面，确认根区域没有恢复双边框；内部面板、表格和卡片边框不受影响。
- 自动验证：
  - `npm --workspace apps/web run typecheck` 通过。
  - `npm --workspace apps/web run build` 通过；仅有既有 `@vueuse/core` PURE 注释和大 chunk 提示。
  - `npm --workspace apps/web test` 通过，13/13；`git diff --check` 通过。
  - 玄武铜浅色 1280×720 实测：侧栏宽 220px、右边框 1px、阴影计算值为 `4px 0 12px rgba(35, 42, 35, 0.043)`；overview / settings 根面板左边框与圆角均为 0，横向溢出为 0。
  - 玄武铜深色实测：侧栏右边框为 1px 深色 border，阴影为 `4px 0 14px rgba(0, 0, 0, 0.2)`；设置根面板仍为直角且无左边框，未出现白边或发光。验收后已恢复“玄武铜 + 跟随系统”。

### 2026-07-22：霓虹夜幕 VM 列表隔行背景归一

- 对应反馈：霓虹夜幕主题的 VM 列表中，深色行正常，但每个隔行显示为白色，破坏深色主题连续性。
- 状态：已修复。
- 真实问题与根因：
  - `HostVmPanel.vue` 使用 Element Plus `el-table stripe`，隔行最终由 `td.el-table__cell` 的 Element 默认变量参与渲染。
  - `neon-carbon` 即使在“浅色/跟随系统”明暗模式下仍使用深色主题 surface，但 `data-tone` 为 `light`，原有仅挂在 `[data-tone="dark"]` 下的覆盖不会生效；Element 默认 `--el-fill-color-lighter` 为 `#fafafa`，因此偶数行出现白色背景。
- 实际改动：
  - `apps/web/src/styles.css` 在共享表格规则中直接覆盖所有 `.el-table--striped ... td.el-table__cell`，隔行背景统一由 `--vrc-surface` 与 `--vrc-surface-muted` 混合计算；不再按 VM 页面或单一连接单独处理。
  - 普通行、hover、current-row 和禁用行的既有语义规则保持不变，未修改排序、筛选、数据或 VM 操作逻辑。
  - `docs/UI样式规范归档.md` 增加暗色主题隔行不得读取 Element 默认浅色变量的长期规则。
- 测试说明：
  1. 启动 `npm --workspace apps/web run dev`，打开任意有多行数据的物理机 VM 列表。
  2. 在“设置 / 外观”选择“霓虹夜幕”，明暗模式依次选择“浅色”“深色”“跟随系统”；返回 VM 列表，普通行和隔行都必须保持暗色 surface，不得出现白色或浅灰条带。
  3. 在霓虹夜幕下移动鼠标到隔行，检查 hover 仍使用主题强调色混合背景；如有当前行/禁用行，检查其状态背景不被隔行规则覆盖。
  4. 切换玄武铜、石墨青或雾青浅色主题，确认隔行仍是各自 surface token 的轻微混合，表头、分割线、文字和行高未变化。
  5. 通过浏览器开发者计算样式确认：隔行 `td.el-table__cell` 的 `background-color` 不再为 `rgb(250, 250, 250)` 或其他白色值；普通行和隔行均来自当前主题 token。
- 浏览器实测：
  - 霓虹夜幕 + 浅色模式复现修复前隔行 `rgb(250, 250, 250)`；修复后普通行 `rgb(26, 32, 41)`，隔行计算为 `color-mix(in srgb, #1a2029 74%, #242c37)`，无白色条带。
  - 霓虹夜幕 + 深色模式普通行 `rgb(22, 29, 33)`，隔行计算为同一暗色 token 混合；列表无横向溢出。
  - 修复后截图确认 1～8 行背景连续使用夜幕深色层级，名称、状态和操作列未发生布局漂移。
  - 自动验证：
  - `npm --workspace apps/web run typecheck` 通过。
  - `npm --workspace apps/web run build` 通过；仅有既有 `@vueuse/core` PURE 注释和大 chunk 提示。
  - `npm --workspace apps/web test` 通过，13/13；`git diff --check` 通过。
  - 浏览器验收结束后已恢复“玄武铜 + 跟随系统”，未执行任何 VM/XenServer 状态变更。

### 2026-07-22：关机 VM 名称不再保留控制台链接样式

- 对应反馈：同样是已关机的虚拟机，部分行名称仍呈现下划线、指针和链接色，和普通文本混在一起，导致用户把“状态”和“入口”看混。
- 状态：已修复。
- 真实问题与根因：
  - `HostVmPanel.vue` 直接用 `resolveVmConsoleTarget` 决定名称列是否渲染为链接；该解析函数不会替界面做“停机态是否允许点击”的语义判断。
  - `styles.css` 里即便对停机行做了弱化，若仍渲染成链接元素，默认下划线和指针光标仍会抢主次。
- 实际改动：
  - `apps/web/src/components/HostVmPanel.vue` 仅在 `running` 行渲染控制台名称链接；停机行统一退回普通文本，不再出现下划线或点击手势。
  - `apps/web/src/styles.css` 将停机行的控制台链接兜底样式收敛为普通文本语义，避免残留 link 外观。
  - `docs/UI样式规范归档.md` 补充规则：控制台入口只在运行中 VM 上保留，关机行名称必须按普通文本渲染。
- 测试说明：
  1. 在物理机 VM 列表中切到“关机”筛选，逐行检查名称列：所有停机 VM 名称都应显示为普通文本，不得出现下划线、指针光标或蓝/棕色链接感。
  2. 切回“全部”后，运行中的 VM 仍可保留控制台名称链接；停机 VM 仍维持普通文本，不因主题切换改变语义。
  3. 在玄武铜、石墨青、霓虹夜幕等主题下重复检查，确认状态色只影响状态列，不再误导名称列的主次判断。

### 2026-07-22：VM 操作列按钮统一中性前景

- 对应反馈：操作列里开机、关机、重启、扩容、删除按钮颜色不一致，用户会把颜色当成主要提示，造成判断负担。
- 状态：已修复。
- 真实问题与根因：
  - `styles.css` 之前对 `vm-action-link` 按 `action-start / shutdown / force-reboot / resize / delete` 分别着色，导致同一列出现绿色、蓝色、橙色和危险色混排。
  - 操作语义本来已经由图标、tooltip、禁用态和确认流程表达，颜色再次分工只会让视觉噪音变大。
- 实际改动：
  - `apps/web/src/styles.css` 移除 `vm-action-link` 的动作分色规则，统一使用中性文本色；hover 只保留统一的弱边框和底色反馈。
  - 补充清理后置主题段里的 `vm-action-link.action-start / shutdown / force-reboot / delete` 遗留选择器，避免它们按 CSS 顺序覆盖统一中性色。
  - `docs/UI样式规范归档.md` 补充：VM 行内单行操作按钮不再按动作单独染色，动作差异只通过图标、tooltip 和禁用态表达。
- 测试说明：
  1. 打开任一物理机 VM 列表，观察操作列五个图标：所有可用按钮应使用同一中性色，不再出现绿色、蓝色、橙色或危险红混排。
  2. 悬停任一按钮，检查反馈仅为统一弱边框/浅背景，不因动作不同出现不同颜色。
  3. 切换玄武铜、石墨青、霓虹夜幕等主题，确认按钮只随主题整体明暗变化，不随动作类型变化。

### 2026-07-22：关机 VM 整行内容再降一级

- 对应反馈：关机行名称已去掉链接感，但整行内容仍偏接近运行态，尤其 CPU、内存、IP 等列没有跟着一起变淡。
- 状态：已修复。
- 真实问题与根因：
  - 之前只给部分列写了停机态颜色，其他正文列仍沿着默认 `--vrc-text` 走，导致同一行出现“有些淡、有些不淡”。
  - 关机状态的视觉目标不是单列降噪，而是让整行整体退后一级，同时把状态列保留为主识别点。
- 实际改动：
  - `apps/web/src/styles.css` 把停机行的整行文本基础色收敛到 `--vrc-text-subtle`，状态列保留略强的 `--vrc-text-muted`；控制台入口仍只在运行中保留。
  - `docs/UI样式规范归档.md` 补充口径：停机行采用整行弱化，不能只挑几列变淡。
- 测试说明：
  1. 打开任一 VM 列表，切到“关机”筛选，观察名称、CPU、内存、磁盘、IP、关机时间是否都比运行中更淡，但仍可读。
  2. 再看状态列“已关机”，应比同一行其他字段略强，作为主识别点。
  3. 切换玄武铜、石墨青、霓虹夜幕后重复检查，确认停机态只随主题 token 统一变浅，不会出现单列深浅不一。

### 2026-07-22：动作执行中名称入口禁用

- 对应反馈：关机中虚拟机的服务器名称仍像可点击链接，和“正在执行动作”的状态冲突。
- 状态：已修复。
- 真实问题与根因：
  - 名称列只按 `running` 与否判断控制台入口，未把 `pending / running` 的动作执行态算进去，导致关机中仍会短暂保留链接外观。
  - 动作执行期间的主要信息应该是状态列，不应再给控制台入口造成“可改、可点”的错觉。
- 实际改动：
  - `apps/web/src/components/HostVmPanel.vue` 将动作执行中的 VM 也视为名称入口禁用态。
  - `apps/web/src/styles.css` 为 `.vm-row-action-operating` 增加名称链接兜底样式，确保动作执行中不保留下划线、指针和点击感。
  - `docs/UI样式规范归档.md` 补充：控制台入口只在运行中且未处于动作执行中的 VM 上保留。
- 测试说明：
  1. 在 VM 列表里触发关机或重启，观察对应行名称立即退回普通文本，不得再显示蓝/棕色链接样式。
  2. 操作完成后，只有真正处于运行态且无动作执行中的 VM 才恢复控制台名称入口。
  3. 切换不同主题复核，确保动作执行态名称始终是弱化文本，而不是可点击链接。

### 2026-07-22：删除 VM 不再弹出双重提示

- 对应反馈：删除虚拟机后，页面同时出现“删除完成”和“目标 VM 已删除，关联的创建验收任务已自动终止。”两条提醒。
- 状态：已修复。
- 真实问题与根因：
  - 删除动作本身已经有成功反馈；后端又会把关联的创建验收任务标记为终止，前端轮询任务状态时把这个终止信息再当成错误 toast 发了一次。
  - 这样会让用户误以为删除失败或产生了额外异常。
- 实际改动：
  - `apps/web/src/App.vue` 记录删除请求返回的 `stoppedProvisionTaskIds`，后续轮询到这些任务终止时不再弹错误 toast。
  - 任务终止仍会保留在活动记录和任务状态里，但不再作为第二个顶层提醒打断用户。
- 测试说明：
  1. 删除一台带有创建验收任务的 VM，只应看到一次明确的删除结果提醒。
  2. 任务面板或活动记录可继续看到任务被终止的状态，但不会再额外弹出“已自动终止”的错误 toast。
  3. 普通删除、批量删除和主题切换后重复验证，确保没有恢复成双提示。

### 2026-07-22：VM 删除图标增加桶身内线

- 对应反馈：删除按钮垃圾桶图标过于空，单条竖线又显得不和谐，期望把垃圾筐略加宽并塞下两道竖线。
- 状态：已修复。
- 真实问题与根因：
  - `VrcVmActionIcon.vue` 的删除图标只有桶盖、把手和桶身外轮廓，小尺寸下桶身显得偏空。
  - 单条居中竖线会把视觉重心压在中轴上，不如两条短竖线更接近常见垃圾桶图形。
- 实际改动：
  - `apps/web/src/components/VrcVmActionIcon.vue` 略微加宽删除图标桶盖、把手和桶身轮廓，并在桶身内增加两条居中短竖线。
  - `docs/UI样式规范归档.md` 同步调整删除图标规范，明确删除桶身可略宽并保留两条短竖线。
- 测试说明：
  1. 打开 VM 列表检查删除按钮：垃圾桶桶身内应有两条居中短竖线，未启用和禁用态都能看出桶形。
  2. 检查 hover/focus：按钮仍只使用统一弱边框，不恢复红色、重边框或红底。
  3. 切换浅色、深色和不同主题，确认内竖线跟随 `currentColor`，不出现硬编码颜色。

### 2026-07-22：创建虚拟机 workflow 步骤卡去除重复外框

- 对应反馈：创建虚拟机底部 workflow 的步骤卡外框和外围容器边框重合，运行中步骤显得太硬，视觉上像双层边框。
- 状态：已修复。
- 真实问题与根因：
  - `footer-workflow` 外层已经有整体边框，`footer-workflow-step.step-running` 又叠了一层 `inset 0 0 0 1px` 的强调框，导致运行中的步骤看起来像被单独框了一圈。
  - 这个强调框和外层容器边框颜色接近，在浅色主题下尤其容易叠成一条更重的线。
- 实际改动：
  - `apps/web/src/styles.css` 删除运行中步骤卡的 inset 外框，只保留底部 2px 进度强调和轻背景渐变。
  - `docs/UI样式规范归档.md` 补充：创建虚拟机底部 workflow 只保留外层容器边框，单个步骤卡不再加外圈强调框。
- 测试说明：
  1. 打开创建虚拟机弹框，观察底部 workflow：所有步骤卡只保留统一分隔，不应出现某个运行步骤额外加粗的四周框线。
  2. 观察运行中步骤：应以底部进度线和状态点表达，不再靠双层边框凸显。
  3. 切换玄武铜、石墨青、霓虹夜幕等主题，确认外层容器边框与内部步骤底色仍然统一，不出现双线、重边或漂白边。

### 2026-07-22：输入控件 focus 去除外扩阴影

- 对应反馈：input 获取焦点后外边框出现阴影，搜索框看起来像多了一层外框。
- 状态：已修复。
- 真实问题与根因：
  - 全局焦点规则曾把 `.el-input__wrapper.is-focus`、`.el-select__wrapper.is-focused` 和按钮放在同一组里，导致输入控件继承 `--vrc-focus-ring`。
  - VM 列表搜索框、总览搜索框、调度目标筛选和扩容控件还有局部 focus 规则，即使全局表单规则写了 `box-shadow: none`，仍会在更靠后的样式里被覆盖。
- 实际改动：
  - `apps/web/src/styles.css` 将全局焦点阴影限定到 button / `.el-button`，输入、select、textarea focus 只改变边框色；同步清理 VM 列表、总览、活动日志、ISO 查询和导入 textarea 的局部 focus 阴影。
  - `apps/web/src/components/VmScheduleDialog.vue` 清理目标筛选 input/select 的局部 focus ring。
  - `apps/web/src/components/VmResizeDialog.vue` 清理扩容 stepper 与磁盘 select 的 focus ring，保留 1px 强边框反馈。
  - `docs/UI样式规范归档.md` 更新规范：查询控件和普通表单 focus 均不得出现外扩阴影或第二层描边。
- 测试说明：
  1. 打开 VM 列表，在“搜索名称 / UUID / IP”输入框点击聚焦：背景仍为 muted，边框只变为主题强调弱混合色，`box-shadow` 应为 `none`。
  2. 分别检查物理机总览搜索、操作记录搜索、ISO 查询、定时任务目标筛选 input/select、扩容磁盘 select：focus 后都不应出现外扩阴影或双层外框。
  3. 切换浅色、深色和霓虹夜幕主题重复检查：输入 focus 只靠边框色表达；按钮和非输入行项目的键盘 focus 不受本次改动影响。

### 2026-07-23：外观页 Switch 控件恢复完整显示

- 对应反馈：设置 / 外观里的“显示水印”“拖拽中节流刷新”两个开关样式不对，只剩细线，开关主体显示不出来。
- 状态：已修复。
- 真实问题与根因：
  - 全局样式没有给 Element Plus `el-switch` 建立统一尺寸契约，只有定时任务、更新中心等局部页面写了 switch 宽高。
  - 外观页设置行是左右 flex 布局，右侧还有控制台预览列；未固定宽度的 switch 在窄列/挤压场景下会参与收缩，最终只露出轨道边缘。
- 实际改动：
  - `apps/web/src/styles.css` 新增全局 switch token：`--vrc-switch-width: 34px`、`--vrc-switch-height: 20px`、`--vrc-switch-action-size: 16px`。
  - 全局 `.el-switch`、`.el-switch__core`、`.el-switch__action` 固定尺寸并设置 `flex: 0 0 34px`，避免在外观页设置行被挤压；开/关轨道继续消费主题 token，兼容浅色和深色主题。
  - `docs/UI样式规范归档.md` 补充：普通表单 / 设置页 switch 在 flex 行内必须固定宽度、禁止收缩。
- 测试说明：
  1. 打开“设置 / 外观”，分别切到 CLI 与图形预览模式，检查“显示水印”和“拖拽中节流刷新”：开关应完整显示为 34×20px 轨道 + 16px 圆点，不得只剩竖线。
  2. 点击两个开关，确认开启态轨道使用当前主题 accent，关闭态使用弱边框混合色，圆点位置正常切换。
  3. 切换浅色、深色和霓虹夜幕主题，确认开关在不同主题下都有足够对比度；同时检查定时任务“状态一致时跳过”和更新中心“自动检查更新”没有尺寸回退。

### 2026-07-23：外观页水印密度选项补齐宽度

- 对应反馈：外观页“密度” segmented 的选项看起来没显示全，`标准` 被压窄后只剩下 `标.` 这种截断效果。
- 状态：已修复。
- 真实问题与根因：
  - 这组 `el-segmented` 没有专属宽度类，直接落在 `appearance-setting-row` 的 flex 布局里，和右侧控件一起竞争宽度。
  - 三段式选项的文字长度不一致，默认自适应宽度被行内布局挤压后，第二项最先发生截断。
- 实际改动：
  - `apps/web/src/App.vue` 给水印密度 segmented 补上 `appearance-watermark-density-segmented`。
  - `apps/web/src/styles.css` 为该 segmented 固定 176px 宽度，和光标 segmented 保持同类紧凑但不截断的尺寸。
  - `docs/UI样式规范归档.md` 补充：三段式 segmented 也要预留足够宽度，不能把文字压成省略号。
- 测试说明：
  1. 打开“设置 / 外观”，在“密度”一行确认 `疏 / 标准 / 密` 三项完整可见，不得出现 `标.` 之类截断。
  2. 切换 `疏 / 标准 / 密`，观察选中项背景和文字颜色是否正常，尺寸不应随选项切换发生跳动。
  3. 切换浅色、深色和霓虹夜幕主题，确认 segmented 仍完整显示，且和“作用范围”一行保持同一视觉契约。

### 2026-07-23：外观页偏好项消费链路审计

- 对应反馈：控制台字体选择后看起来没效果，并要求顺便检查外观页是否还有“有选项但不起作用”的功能。
- 状态：已修复 2 项，已核实 8 项。
- 真实问题与根因：
  - 控制台字体实际已经接入：设置页 CLI 预览消费 `--appearance-console-font`，真实 `ConsoleDialog` 和创建向导控制台入口消费 `currentConsoleFont.family`。但 `JetBrains Mono / Cascadia Mono` 只引用本机字体，不打包字体；本机未安装时浏览器会回退到系统等宽字体。`Menlo（macOS）` 和“系统等宽”在 macOS 上视觉差异也很小，容易误判为未生效。
  - `图标按钮显示 tooltip` 之前只写入 `document.documentElement.dataset.iconTooltips`，生产工具栏的 Element Tooltip 没有消费这个开关。
  - `长名称单行省略` 之前只写入 `document.documentElement.dataset.truncateLongNames`，没有对应 CSS 覆盖，切换后名称显示不变化。
- 实际改动：
  - `apps/web/src/App.vue` 将 `showIconTooltips` 传入 VM 面板、控制台和定时任务弹框，并给总览工具栏、连接加载、ISO 刷新等操作型 Tooltip 增加禁用条件。
  - `apps/web/src/components/HostVmPanel.vue` 新增 `showIconTooltips` prop，批量操作、创建、导出、刷新等图标按钮 Tooltip 跟随外观开关；容量指标溢出 Tooltip 不归入该开关。
  - `apps/web/src/components/ConsoleDialog.vue` 新增 `showIconTooltips` prop，控制台常用命令、重连、复制、资源监控、放大等工具按钮 Tooltip 跟随外观开关。
  - `apps/web/src/components/VmScheduleDialog.vue` 新增 `showIconTooltips` prop，目标选择/清空图标按钮 Tooltip 跟随外观开关。
  - `apps/web/src/styles.css` 为 `data-truncate-long-names="false"` 补 CSS，关闭省略时连接名、总览名称、VM 名称、表格链接、维护介质名称允许换行。
  - `docs/UI样式规范归档.md` 补充外观页偏好项必须有明确消费点，以及本机字体缺失时自然回退的口径。
- 已核实无需改：
  1. `界面字体 / 文字大小`：通过 `--vrc-ui-font`、`--vrc-ui-font-size` 作用到 `.app-shell`，设置页预览也单独消费当前字体。
  2. `控制台字体 / 字号 / 行高`：设置页 CLI 预览和真实 xterm 控制台均已接入；字体是否可见取决于本机是否安装对应字体。
  3. `控制台配色`：写入终端主题变量，并传入 `terminalTheme`。
  4. `光标样式 / 闪烁`：设置页预览和真实 xterm 控制台均已接入。
  5. `安全水印显示 / 作用范围 / 密度 / 透明度`：设置页预览、ConsoleDialog 和工作区水印均已接入。
  6. `图形控制台缩放方式 / 画面质量`：传入 ConsoleDialog，noVNC 客户端按 `displayScaleMode / displayQuality` 应用。
  7. `拖拽中节流刷新`：传入 ConsoleDialog 的 resize 行为。
  8. `减少动效 / 工作区背景`：分别通过 `data-reduce-motion` 和工作区背景 CSS 变量生效。
- 测试说明：
  1. 控制台字体：在“设置 / 外观 / Linux CLI”切换 `系统等宽 / Menlo`，预览区文本 `font-family` 应变化；切换 `JetBrains Mono / Cascadia Mono` 前先确认本机已安装，否则浏览器会 fallback，视觉可能不变。
  2. 打开真实 Linux CLI 控制台，检查 xterm 文本字体、字号、行高、光标样式与外观设置一致。
  3. 关闭“图标按钮显示 tooltip”，悬停总览工具栏、VM 批量操作、VM 面板创建/导出/刷新、控制台工具按钮、定时任务目标选择按钮，不应再弹出操作 tooltip；表格溢出和容量指标 tooltip 不受该开关影响。
  4. 关闭“长名称单行省略”，连接列表、VM 名称、总览物理机名称和表格链接应允许换行；重新开启后恢复单行省略。
  5. 切换浅色、深色和霓虹夜幕主题，重复检查 tooltip 开关和长名称开关，确认没有主题专属覆盖导致失效。

### 2026-07-23：创建虚拟机系统镜像下拉内容补齐

- 对应反馈：虚拟机扩容/创建流程里的镜像下拉框样式不对，ISO 内容显示不全。
- 状态：已修复；2026-07-23 根据截图复核后修正浮层宽度、阴影和间距。
- 真实问题与根因：
  - 代码实际入口是 `VmProvisioningDialog.vue` 的“系统镜像”下拉；当前 `VmResizeDialog.vue` 扩容弹框没有镜像选择字段，只有磁盘和挂载目录选择。
  - 镜像下拉使用了 `fit-input-width`，浮层被强制压到输入框同宽；同时复用普通下拉 `30px` 单行选项和两列 grid，长 ISO 名称与副说明会被横向挤压或垂直裁切。
- 实际改动：
  - `apps/web/src/components/VmProvisioningDialog.vue` 移除系统镜像 `el-select` 的 `fit-input-width`，并给镜像名称补 `option-title` 结构类。
  - `apps/web/src/styles.css` 将 `.vrc-provision-iso-dropdown` 改为信息型下拉：浮层可按内容扩宽到视口安全范围，选项最小 44px，主标题和副说明上下排列并用主题文字 token；保留普通 IP 池等下拉的 30px 单行规则不受影响。
  - 复核截图后继续修正：去掉固定 `520px` 最小宽度，改为短内容不制造右侧空白、长内容按最长 option 扩宽到视口安全上限；系统镜像下拉显式 `offset=0`、隐藏 popper arrow，并清除 `el-select__popper` 默认阴影。
  - `docs/UI样式规范归档.md` 补充信息密集型 select 规范：镜像/模板/存储库类下拉不强制跟输入框等宽，选项采用主标题 + 副说明两行结构。
- 测试说明：
  1. 打开创建虚拟机弹框，在“创建参数 / 系统镜像”点击下拉；下拉上边缘应贴合 select 下边缘，不出现明显竖向空隙。
  2. ISO 较少或名称较短时，下拉宽度不应固定撑出大片右侧空白；ISO 名称较长时，下拉应按最长 option 自动扩宽，但不超出视口安全边距。
  3. 检查下拉浮层只保留主题弱边框，不应出现外扩阴影；选中项、hover 项颜色应跟随当前主题，不能出现硬编码蓝/绿/白。
  4. 输入关键字过滤 ISO，检查匹配项仍保持两行结构；长文件名最多在视口安全上限处省略，不应被固定窄宽裁掉。
  5. 切换石墨青、玄武铜、霓虹夜幕等主题重复打开下拉，确认浮层背景、文字、副说明、选中态都跟随 token。
  6. 顺手检查同弹框的 IP 池下拉：它仍是普通 30px 单行主副信息布局，不应被镜像下拉的两行样式误伤。

### 2026-07-23：页面误选中与复制能力分层

- 对应反馈：页面在拖拽或点击后出现大面积文本选中，像是“整屏都被复制高亮”。
- 状态：已修复。
- 真实问题与根因：
  - 资源总览、侧栏、工具栏、表头和操作按钮本质上是交互 chrome，却默认继承了浏览器可选中文本行为；当鼠标拖动穿过页面时，会把标题、卡片和表格行一起高亮。
  - 不能用全局 `user-select: none` 一刀切解决，因为 VM 名称、系统、CPU、内存、磁盘、IP、关机时间等数据本身需要允许复制。
- 实际改动：
  - `apps/web/src/styles.css` 将导航、标题、指标卡、工具栏、表头、checkbox、segmented、switch、操作按钮等结构/交互区域设为 `user-select: none`。
  - 同一文件给输入框、textarea 和新增的 `vrc-copyable-text` 重新放开 `user-select: text`，并把 VM 表格正文设为默认不可选中，避免拖拽时整片高亮。
  - `apps/web/src/components/HostVmPanel.vue` 给 VM 名称、系统、CPU、内存、磁盘、IP、关机时间等数据字段补 `vrc-copyable-text`，保留这些关键值的复制能力。
  - `docs/UI样式规范归档.md` 补充分层规则：交互 chrome 禁选，但可复制数据必须显式开放。
- 测试说明：
  1. 在资源总览页按住鼠标从左上拖到右下，不应再出现整页蓝色选中块。
  2. 在 VM 表格里拖拽时，表头、按钮和大块 chrome 不应被选中；名称、系统、CPU、内存、磁盘、IP、关机时间等 `vrc-copyable-text` 仍可单独拖选复制。
  3. 点击/拖动侧栏、工具栏、按钮和 segmented，不应留下持续的文本选中状态。
