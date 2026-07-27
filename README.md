# Virtual Resource Console

虚拟机资源管理平台，用于在 macOS、Windows、Linux 上统一查看和管理虚拟化环境资源。

项目当前已接入 XenServer、VMware、Proxmox VE，提供资源盘点、物理机与虚拟机总览、控制台接入、ISO / 模板创建虚拟机、虚拟机扩容和回收分析能力。KVM/libvirt 目前仅保留能力描述，尚未注册 Provider。

---

## 核心功能

### 1. 多平台连接管理

- 支持保存 XenServer、VMware、Proxmox VE 等虚拟化平台连接
- 本地加密保存连接密码，页面接口只返回连接摘要
- 支持连接测试、连接列表、连接删除和最近使用记录
- 默认按只读资源盘点使用，涉及虚拟机变更操作时需要明确确认

### 2. 资源总览

- 查看物理机、存储、网络和虚拟机清单
- 按连接、物理机、资源状态聚合展示资源使用情况
- 首屏优先加载物理机和资源概览，虚拟机明细按需查询
- 支持虚拟机名称、UUID、IP、状态等条件筛选

### 3. 虚拟机管理

- 展示 VM 电源状态、CPU、内存、磁盘、IP、Guest OS、Tools 状态
- 支持 VM 详情、磁盘列表和指标快照查询；平台快照接口已预留，当前暂未返回快照数据
- 支持 VNC / Web Console 接入 XenServer、VMware、Proxmox 控制台
- 支持受控执行开机、关机、删除、改名和扩容等操作，后端要求确认令牌
- 支持 Linux CLI 终端；终端使用短时一次性 SSH PTY 会话，不把系统密码放入 WebSocket URL

### 4. 创建虚拟机

- 支持基于 ISO 或平台模板创建 VM
- 支持规格模板、环境模板、IP 池和批量创建计划
- 支持 XenServer、VMware、Proxmox VE 的模板克隆或 unattended ISO 安装策略
- 支持 Linux Kickstart、Windows unattended 和手动 ISO 安装链路
- 支持创建任务进度、预检查、IP 占用探测和租约释放

### 5. 虚拟机扩容

- 支持 CPU、内存、原有虚拟磁盘扩展和新增虚拟磁盘
- 支持在 Guest 内完成分区、LVM、文件系统和挂载目录生效
- Guest 系统凭据按连接 ID 和 VM ID 加密保存，可选使用 JumpServer 作为扩容执行通道

### 6. 桌面端与发布

- Electron 桌面端复用 Web UI，支持 macOS 和 Windows 打包
- 支持桌面端更新检查、下载和安装；免安装版更新需要替换新版 ZIP
- Chrome 插件只连接 VRC 服务，不直接连接虚拟化平台，也不保存平台密码

### 7. 回收分析

- 对虚拟机运行状态、CPU、磁盘、网络等指标进行统一建模
- 输出 P0 / P1 / P2 / P3 / KEEP 等回收建议等级
- 用于识别长期关机、低活跃、高占用低使用的 VM
- 回收建议只作为人工决策依据，不自动删除或关机

---

## 技术架构

```
Vue 3 + Element Plus Web UI
        │
        │ HTTP / SSE / WebSocket
        ▼
Fastify + TypeScript API
        │
        ├── Provider SPI
        │   ├── XenServer Provider
        │   ├── VMware Provider
        │   └── Proxmox Provider
        │
        ├── Console Gateway
        ├── Provisioning Service
        ├── Install Source Service
        ├── Terminal Gateway
        └── Local Stores

Electron Desktop Shell
        └── 复用同一套 Web UI

Chrome Extension
        └── 连接本机或内网 VRC 服务
```

### Provider 能力范围

| Provider | 资源盘点 | 控制台 | 创建 VM | 改名 | 扩容 | 快照查询 |
|----------|----------|--------|---------|------|------|----------|
| XenServer | 已接入 | 已接入 | 已接入 | 已接入 | 已接入 | 暂未返回数据 |
| VMware | 已接入 | 已接入 | 已接入 | 已接入 | 已接入 | 暂未返回数据 |
| Proxmox VE | 已接入 | 已接入 | 已接入 | 已接入 | 已接入 | 暂未返回数据 |
| KVM/libvirt | 未接入 | 未接入 | 未接入 | 未接入 | 未接入 | 未接入 |

表中的“已接入”表示 Provider 和统一 API 已提供该能力入口，具体平台版本、权限和安装介质仍需按目标环境进行验收。

| 模块 | 技术栈 |
|------|--------|
| Web 前端 | Vue 3, TypeScript, Vite, Element Plus, ECharts, noVNC |
| API 服务 | Fastify, TypeScript, zod, ssh2, ws |
| 桌面端 | Electron |
| 项目组织 | npm workspaces |
| 本地存储 | `~/.virtual-resource-console/` |

---

## 项目结构

```
virtual-resource-console/
├── apps/
│   ├── api/                 # 本地 API / BFF / Provider 适配层
│   │   └── src/
│   │       ├── index.ts                 # HTTP API 与业务编排入口
│   │       ├── xenserver.ts             # XenServer Provider
│   │       ├── vmware.ts                # VMware Provider
│   │       ├── proxmox.ts               # Proxmox Provider
│   │       ├── providers/               # Provider SPI 与注册表
│   │       ├── console/                 # Web Console / VNC 网关
│   │       ├── terminal/                # Linux CLI / SSH PTY 网关
│   │       ├── analysis/                # 回收状态机
│   │       ├── *Store.ts                # 本机缓存、任务和配置存储
│   ├── web/                 # Vue 3 前端
│   │   └── src/
│   │       ├── App.vue                  # 主控制台
│   │       ├── components/              # 资源面板、创建 VM、控制台弹窗
│   │       └── domain/                  # 前端策略与品牌映射
│   ├── chrome-extension/    # Chrome 插件
│   └── electron/            # Electron 桌面壳
├── scripts/                 # 本地启动、停止、状态检查脚本
├── package.json             # workspace 脚本入口
└── tsconfig.base.json
```

---

## 快速开始

### 环境要求

- Node.js 20+
- npm 10+
- macOS / Windows / Linux
- 可访问目标虚拟化平台的网络环境

### 安装依赖

```bash
npm install
```

### Web 开发模式

```bash
npm run dev
```

默认服务：

- API: `http://127.0.0.1:3987`
- Web: `http://127.0.0.1:5173`

### 内网单端口部署

构建后，API 会在同一个端口托管 Web 静态资源。部署到内网服务器后，普通用户直接访问服务地址即可，不需要安装 CLI。

```bash
npm install
npm run build
HOST=0.0.0.0 PORT=3987 npm run start:server
```

访问地址：

```text
http://<内网服务器 IP 或域名>:3987/
```

接口仍然位于同源 `/api/*`，例如：

```text
http://<内网服务器 IP 或域名>:3987/api/health
```

也可以使用 Docker：

```bash
docker build -t virtual-resource-console .
mkdir -p "$HOME/.virtual-resource-console"
cp config/ip-pools.example.json "$HOME/.virtual-resource-console/ip-pools.json"
# 按目标环境修改 ip-pools.json 后再启动容器
docker run -d --name vrc -p 3987:3987 -v "$HOME/.virtual-resource-console:/root/.virtual-resource-console" virtual-resource-console
```

IP 池配置是创建 VM、IP 探测和租约功能的必需配置。Docker 不会自动把仓库中的示例文件写入数据卷；如果要在设置页保存配置，数据卷必须保持可写。

XenServer 无人值守安装源由目标物理机按任务发布，不需要配置客户端本机安装源地址。

### Chrome 插件

插件是轻入口：它不直接连接 XenServer，也不保存平台密码，只连接本机或内网 VRC 服务。

构建插件：

```bash
npm run pack:extension
```

Chrome 开发模式调试：

1. 打开 `chrome://extensions/`。
2. 开启 Developer mode。
3. Load unpacked 选择 `apps/chrome-extension/dist`。
4. 在插件里填写 `http://<内网服务器 IP 或域名>:3987`，点击“检测服务”。

如果希望插件自动启动本机 VRC 服务，macOS 上先安装 Native Messaging Host：

```bash
npm run install:native-host
```

安装后，插件里的“启动本机服务”会优先请求 Native Host 启动 `127.0.0.1:3987`。如果没有安装 Native Host，会尝试 `vrc://start` 唤起本机客户端；仍不可用时，按内网服务器地址使用。

### Electron 桌面端开发

```bash
npm run dev:electron
```

桌面端打包：

```bash
npm run dist:mac
npm run dist:win
```

准备桌面端更新资源：

```bash
npm run release:update
```

### 本地后台启动

```bash
npm run local:start
npm run local:status
npm run local:stop
```

`local:start` 会启动 API 和 Web，并将日志写入本地 `.runtime/logs/`。该目录不会提交到仓库。

---

## 构建与校验

```bash
# 类型检查
npm run typecheck

# 构建 API 和 Web
npm run build

# 运行 API 和 Web 单元测试
npm --workspace apps/api test
npm --workspace apps/web test

# 单独构建前端
npm --workspace apps/web run build

# 单独构建后端
npm --workspace apps/api run build
```

---

## 配置与数据安全

本项目不会要求把服务器账号、密码、连接文档提交到仓库。

### 本地数据目录

运行时数据保存在：

```text
~/.virtual-resource-console/
```

主要包含：

- `connections.json`：平台连接摘要和加密后的密码
- `key.bin`：本机加密密钥
- `vm-system-credentials.json`：可选的 Guest 系统凭据密文
- `preferences.json`、`provisioning.json`：界面偏好和创建配置
- `ip-leases.json`、`generated-isos.json`、ISO 缓存和创建任务记录
- `inventory-snapshots.json`、`vm-search-index.json`：资源快照和 VM 搜索索引
- `ip-pools.json`：本机 IP 池配置，例如默认 DNS、地址池、物理机网段匹配规则和可分配主机号

这些文件属于本机运行数据，不应提交到 GitHub。

### 本机 IP 池配置

`ip-pools.json` 是地址池和可管理网段的唯一来源。创建、安装、租约、VM 搜索索引和名称转 IP 都读取它；新增网段时先在设置页扩展 IP 池，后续资源刷新会自动使用新网段，无需再维护单独的运行策略文件。

默认读取路径：

```text
${VRC_DATA_DIR:-~/.virtual-resource-console}/ip-pools.json
```

这是强制配置。API 不再兼容旧 `providerIpPools`，也不会在文件缺失时静默使用内置兜底；缺少文件或格式不正确会直接报错。首次使用可以复制仓库里的默认 IP 池配置：

```bash
mkdir -p ~/.virtual-resource-console
cp config/ip-pools.json ~/.virtual-resource-console/ip-pools.json
chmod 600 ~/.virtual-resource-console/ip-pools.json
```

`config/ip-pools.json` 随仓库维护默认的 129 / 2 / 127 三个网段；`config/ip-pools.example.json` 只作为脱敏示例。`scripts/start-local.sh` 会在数据目录不存在 `ip-pools.json` 时把默认文件写入一次，已有文件不会被覆盖。Electron 桌面包不在安装或升级时覆盖数据目录里的 `ip-pools.json`；用户后续通过设置页新增、导入、编辑并保存。服务器、Docker 或裸 Node 部署需要在部署步骤里显式放好这个文件。

也可以通过环境变量指定其它路径：

```bash
export VRC_DATA_DIR=/path/to/vrc-data
export VRC_IP_POOLS_FILE=/path/to/ip-pools.json
```

`VRC_IP_POOLS_FILE` 指定的是完整文件路径，优先级最高；只想整体迁移 VRC 运行数据目录时，配置 `VRC_DATA_DIR` 即可。

配置示例：

```json
{
  "defaultDns": ["1.1.1.1"],
  "ipPools": [
    {
      "id": "pool-example-a",
      "name": "203.0.113 专用网段",
      "prefix": "203.0.113",
      "gateway": "203.0.113.254",
      "startHost": 20,
      "endHost": 250,
      "hostPrefixes": ["203.0.113"]
    },
    {
      "id": "pool-example-b",
      "name": "192.0.2 通用网段",
      "prefix": "192.0.2",
      "gateway": "192.0.2.254",
      "startHost": 20,
      "endHost": 250
    },
    {
      "id": "pool-example-c",
      "name": "198.51.100 通用网段",
      "prefix": "198.51.100",
      "gateway": "198.51.100.1",
      "networkName": "Pool-wide network associated with eth1",
      "startHost": 20,
      "endHost": 250
    }
  ]
}
```

默认选择规则很轻：当前物理机 IP 前三段命中 `hostPrefixes` 时，该 IP 池排在第一位并默认选中；没有命中的专用池不会被隐藏，用户仍可手动切换。没有 `hostPrefixes` 的池是通用池。

IP 池字段说明：

| 字段 | 说明 |
|------|------|
| `id` | IP 池唯一 ID |
| `name` | 页面展示名称 |
| `prefix` | 网段前三段，例如 `192.0.2` |
| `gateway` | 网关地址 |
| `dns` | 可选；不填时使用 `defaultDns` |
| `startHost` / `endHost` | 可分配主机号范围 |
| `hostPrefixes` | 可选；适用的物理机 IP 前三段，例如 `203.0.113`；不填表示通用池 |
| `networkName` | 可选；创建 VM 时优先使用指定网络 / VLAN / PortGroup |
| `vlan` | 可选；用于页面展示和后续扩展 |

#### 配置生效方式

`ip-pools.json` 由 API 按需读取。通过设置页保存后无需重启服务，后续资源和搜索索引刷新会直接使用最新网段；手工修改文件后也可以重启本地服务确认：

```bash
npm run local:stop
npm run local:start
```

开发模式下也可以停止并重新执行：

```bash
npm run dev
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `HOST` | API 监听地址，默认本地脚本使用 `0.0.0.0` |
| `PORT` | API 端口，默认 `3987` |
| `VRC_DATA_DIR` | VRC 本机运行数据根目录，默认 `~/.virtual-resource-console` |
| `VRC_IP_POOLS_FILE` | IP 池配置完整路径，优先于 `VRC_DATA_DIR` |
| `VRC_WEB_DIST_DIR` | 自定义 Web 静态资源目录；未设置时使用 `apps/web/dist` |
| `VRC_RUNTIME_MODE` | 运行模式：`web`、`electron` 或 `chrome-native` |
| `VRC_SHARED_WEB_MODE` | 设为 `true` 后禁用服务端持久化连接和依赖连接的定时任务 |
| `VRC_DISABLE_PERSISTENT_CONNECTIONS` | 设为 `true` 后强制禁用持久化连接 |
| `VRC_XEN_INSTALL_MEDIA_MODE` | XenServer 安装介质模式 |
| `VRC_XEN_HOST_INSTALL_SOURCE_PORT` | XenServer 物理机安装源租约起始端口，默认 `3988` |
| `VRC_XEN_HOST_INSTALL_SOURCE_PORT_COUNT` | XenServer 物理机安装源端口探测数量，默认 `20` |
| `VRC_XEN_HOST_INSTALL_SOURCE_ROOT` | XenServer 物理机安装源临时目录，默认 `/var/run/vrc-install-source` |
| `VRC_DESKTOP_UPDATE_DIR` | 桌面端更新文件目录；API 会通过 `/desktop-updates/*` 提供静态文件 |
| `VRC_UPDATE_URL` | 桌面端在线更新源；不配置时客户端不会检查在线更新 |

XenServer 创建 VM 时生成的 `vrc-*.iso` 是临时启动介质，不会进入 ISO 镜像缓存；任务完成并切回硬盘启动后会按登记记录自动清理。

请使用本机 shell、`.env.local` 或部署环境配置这些变量，不要把包含真实地址、账号、密码、token 的文件提交到仓库。

---

## 安全边界

- 默认使用只读盘点和查询能力
- 不确定是否会改变虚拟化平台状态的命令，按变更操作处理
- 开机、关机、删除、创建 VM、挂载 ISO、修改 CPU / 内存 / 磁盘等操作必须经过界面确认和后端参数校验
- 连接密码在后端日志中做脱敏处理
- 保存到本机的数据中的 Guest 系统凭据和平台连接密码使用本机密钥加密；密码、私钥和长期 token 不放入 URL、localStorage 或任务响应
- 当前活动记录仅在会话内保存，持久化审计尚未接入
- README 和仓库源码不包含任何真实服务器账号、密码或连接清单

### 共享 Web 模式

面向多人访问的内网 Web 部署建议设置：

```bash
VRC_SHARED_WEB_MODE=true HOST=0.0.0.0 PORT=3987 npm run start:server
```

该模式不保存服务端平台连接，不返回持久化连接列表，并禁用依赖服务端连接的 VM 定时任务。需要保存连接、任务和本机凭据时，应使用本机 Electron、Chrome Native 或单用户 Web 模式，并限制服务访问范围。

---

## API 概览

| 能力 | 接口 |
|------|------|
| 健康检查 | `GET /api/health` |
| Provider 能力 | `GET /api/providers` |
| 连接管理 | `GET /api/connections`, `POST /api/connections`, `DELETE /api/connections/:id` |
| 连接测试 | `POST /api/connections/test` |
| 资源清单 | `POST /api/inventory/pools`, `POST /api/inventory/hosts`, `POST /api/inventory/vms`, `POST /api/inventory/vm-summary`, `POST /api/inventory/vm-search-index` |
| 存储与 ISO | `POST /api/inventory/virtual-disks`, `POST /api/inventory/vm-disks`, `POST /api/inventory/vm-guest-storage`, `POST /api/inventory/iso-images` |
| 资源增量事件 | `GET /api/inventory/events`（SSE） |
| VM 操作 | `POST /api/vms/action`, `POST /api/vms/rename`, `POST /api/vms/resize` |
| VM 定时任务 | `GET /api/vm-schedules`, `POST /api/vm-schedules`, `PUT /api/vm-schedules/:id`, `PATCH /api/vm-schedules/:id/enabled`, `DELETE /api/vm-schedules/:id` |
| 指标快照 | `POST /api/metrics/snapshot` |
| 创建 VM | `POST /api/provisioning/preflight`, `POST /api/provisioning/vms` |
| 创建任务与事件 | `GET /api/provisioning/tasks`, `GET /api/provisioning/tasks/:taskId`, `GET /api/provisioning/tasks/:taskId/events`（SSE） |
| IP 池与租约 | `GET/PATCH /api/ip-pools/policy`, `GET/POST /api/provisioning/ip-leases`, `POST /api/provisioning/ip-probe` |
| 控制台 | `POST /api/console/*/session` 后通过 `/api/console/xenserver`、`/api/console/vmware`、`/api/console/proxmox` 建立 WebSocket |
| 控制台上传 | `POST /api/console/upload`, `GET /api/console/upload/:uploadId/events` |
| Linux CLI | `POST /api/terminal/session` 后通过 `/api/terminal?sessionId=...` 建立 WebSocket |
| 介质维护 | `GET /api/maintenance/generated-isos`, `POST /api/maintenance/generated-isos/cleanup` |

---

## 开发说明

- 新增平台时优先实现 `apps/api/src/providers/provider.ts` 中定义的 Provider 能力
- UI 不直接处理平台私有字段，平台差异应在 Provider 或前端 domain 策略内收敛
- 资源盘点接口应避免首屏一次性读取所有 VM、磁盘、快照和指标
- 变更类能力需要保留确认、失败提示和操作上下文；持久化审计单独建设
- 前端样式遵循已有 Element Plus 与项目主题变量，不新增一次性颜色体系

## 文档索引

| 文档 | 内容 |
|------|------|
| `docs/分发与打包策略.md` | Chrome 插件、内网服务器、macOS / Windows 桌面客户端和多形态交付策略 |
| `docs/平台能力与前后端接口归一方案.md` | Provider 能力、统一 DTO、创建计划和任务状态契约 |
| `docs/架构设计与演进约束.md` | 多平台架构、无人值守安装、终端和安全边界 |
| `docs/虚拟机存储扩容策略.md` | Guest 存储探测、磁盘扩容和系统内生效策略 |

其它设计、原型和排查文档默认保留在本地 `docs/` 目录，不随仓库提交。

---

## License

MIT
