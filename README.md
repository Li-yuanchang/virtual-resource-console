# Virtual Resource Console

虚拟机资源管理平台，用于在 macOS、Windows、Linux 上统一查看和管理虚拟化环境资源。

项目当前以 XenServer 资源盘点、物理机与虚拟机总览、控制台接入、ISO / 模板创建虚拟机和回收分析为主要能力，同时预留 VMware、Proxmox VE、KVM-libvirt 等 Provider 扩展。

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
- 支持 VM 详情、磁盘列表、快照和指标快照查询
- 支持 VNC / Web Console 接入 XenServer、VMware、Proxmox 控制台
- 支持受控执行开机、关机、删除等操作，后端要求确认令牌

### 4. 创建虚拟机

- 支持基于 ISO 或平台模板创建 VM
- 支持规格模板、环境模板、IP 池和批量创建计划
- 支持 XenServer Kickstart / unattended ISO 安装链路
- 支持创建任务进度、预检查、IP 占用探测和租约释放

### 5. 回收分析

- 对虚拟机运行状态、CPU、磁盘、网络等指标进行统一建模
- 输出 P0 / P1 / P2 / P3 / KEEP 等回收建议等级
- 用于识别长期关机、低活跃、高占用低使用的 VM
- 回收建议只作为人工决策依据，不自动删除或关机

---

## 技术架构

```
Vue 3 + Element Plus Web UI
        │
        │ HTTP / WebSocket
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
        └── Local Stores

Electron Desktop Shell
        └── 复用同一套 Web UI
```

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
│   │       ├── console/                 # Web Console / VNC 网关
│   │       └── analysis/                # 回收状态机
│   ├── web/                 # Vue 3 前端
│   │   └── src/
│   │       ├── App.vue                  # 主控制台
│   │       ├── components/              # 资源面板、创建 VM、控制台弹窗
│   │       └── domain/                  # 前端策略与品牌映射
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
docker run -d --name vrc -p 3987:3987 -v "$HOME/.virtual-resource-console:/root/.virtual-resource-console" virtual-resource-console
```

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
- provisioning 配置、IP 租约、ISO 缓存和任务记录
- `runtime-policy.json`：本机运行识别策略，例如 IP 白名单、VM 名称转 IP、口令模板和 XenServer 网卡映射
- `ip-pools.json`：本机 IP 池配置，例如默认 DNS、地址池、物理机网段匹配规则和可分配主机号

这些文件属于本机运行数据，不应提交到 GitHub。

### 本机运行策略

`runtime-policy.json` 只放运行识别和平台规则。它不随仓库提交，适合保存内网 IP 白名单、VM 名称转 IP 规则、root 初始口令模板、XenServer 网卡选择规则等本地口径。IP 池不放在这里，避免运行策略和地址池维护混在一起。

默认读取路径：

```text
~/.virtual-resource-console/runtime-policy.json
```

首次使用可以复制仓库里的示例文件：

```bash
mkdir -p ~/.virtual-resource-console
cp config/runtime-policy.example.json ~/.virtual-resource-console/runtime-policy.json
chmod 600 ~/.virtual-resource-console/runtime-policy.json
```

也可以通过环境变量指定其它路径：

```bash
export VRC_RUNTIME_POLICY_FILE=/path/to/runtime-policy.json
```

如果配置文件不存在或读取失败，系统会使用安全默认值继续启动，不会因为缺少该文件报错；只是不会带入你的现场网段识别、口令模板或网卡映射。

#### 配置示例

下面是一个脱敏示例，使用文档保留网段 `192.0.2.0/24`。实际使用时请替换成自己的环境值，不要把真实配置提交到仓库。

```json
{
  "managedIpPattern": "^192\\.0\\.2\\.[0-9]{1,3}$",
  "ipInference": {
    "enabled": true,
    "shortIpBasePrefix": "192.0",
    "shortIpThirdOctets": ["2"],
    "hostOnlyPrefix": "192.0.2"
  },
  "provisioning": {
    "rootPasswordTemplate": ""
  },
  "xenserver": {
    "networkDeviceRules": [
      {
        "ipPrefix": "192.0.2.",
        "device": "eth0"
      }
    ]
  }
}
```

#### 字段说明

| 字段 | 说明 |
|------|------|
| `managedIpPattern` | 可识别和展示的 IPv4 白名单正则；为空时接受合法 IPv4 |
| `ipInference.enabled` | 是否允许从 VM 名称推断 IP |
| `ipInference.shortIpBasePrefix` | 短 IP 推断的前两段，例如 `192.0` |
| `ipInference.shortIpThirdOctets` | 允许识别的第三段，例如名称里出现 `2.111` 时可推断为 `192.0.2.111` |
| `ipInference.hostOnlyPrefix` | 只有主机号时使用的前三段，例如名称 `111-test` 可推断为 `192.0.2.111` |
| `provisioning.rootPasswordTemplate` | 初始 root 口令模板；为空时不自动生成 root 口令 |
| `xenserver.networkDeviceRules` | XenServer 创建 VM 时按 IP 前缀选择 PIF 设备 |

`rootPasswordTemplate` 支持以下占位符：

| 占位符 | 含义 |
|--------|------|
| `{first}` | IP 第一段 |
| `{second}` | IP 第二段 |
| `{third}` | IP 第三段 |
| `{fourth}` | IP 第四段 |
| `{ip}` | 完整 IP |

### 本机 IP 池配置

`ip-pools.json` 只放地址池。创建、安装、租约等功能可以读取它，但这个文件本身不承载那些流程。

默认读取路径：

```text
${VRC_DATA_DIR:-~/.virtual-resource-console}/ip-pools.json
```

这是强制配置。API 不再兼容旧 `providerIpPools`，也不会在文件缺失时静默使用内置兜底；缺少文件或格式不正确会直接报错。首次使用可以复制仓库里的默认配置文件：

```bash
mkdir -p ~/.virtual-resource-console
cp config/ip-pools.example.json ~/.virtual-resource-console/ip-pools.json
chmod 600 ~/.virtual-resource-console/ip-pools.json
```

Electron 桌面包会随包携带 `config/ip-pools.example.json` 并在首次启动时复制为数据目录的 `ip-pools.json`；服务器、Docker 或裸 Node 部署需要在部署步骤里显式放好这个文件。

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

`runtime-policy.json` 和 `ip-pools.json` 都由 API 进程启动后读取。修改后建议重启本地服务：

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
| `VRC_RUNTIME_POLICY_FILE` | 自定义运行策略配置文件路径 |
| `VRC_XEN_INSTALL_MEDIA_MODE` | XenServer 安装介质模式 |
| `VRC_XEN_HOST_INSTALL_SOURCE_PORT` | XenServer 物理机安装源租约起始端口，默认 `3988` |
| `VRC_XEN_HOST_INSTALL_SOURCE_PORT_COUNT` | XenServer 物理机安装源端口探测数量，默认 `20` |
| `VRC_XEN_HOST_INSTALL_SOURCE_ROOT` | XenServer 物理机安装源临时目录，默认 `/var/run/vrc-install-source` |

XenServer 创建 VM 时生成的 `vrc-*.iso` 是临时启动介质，不会进入 ISO 镜像缓存；任务完成并切回硬盘启动后会按登记记录自动清理。

请使用本机 shell、`.env.local` 或部署环境配置这些变量，不要把包含真实地址、账号、密码、token 的文件提交到仓库。

---

## 安全边界

- 默认使用只读盘点和查询能力
- 不确定是否会改变虚拟化平台状态的命令，按变更操作处理
- 开机、关机、删除、创建 VM、挂载 ISO、修改 CPU / 内存 / 磁盘等操作必须经过界面确认和后端参数校验
- 连接密码在后端日志中做脱敏处理
- README 和仓库源码不包含任何真实服务器账号、密码或连接清单

---

## API 概览

| 能力 | 接口 |
|------|------|
| 健康检查 | `GET /api/health` |
| 连接管理 | `GET /api/connections`, `POST /api/connections`, `DELETE /api/connections/:id` |
| 连接测试 | `POST /api/connections/test` |
| 资源清单 | `POST /api/inventory/pools`, `POST /api/inventory/hosts`, `POST /api/inventory/vms` |
| 存储与 ISO | `POST /api/inventory/virtual-disks`, `POST /api/inventory/iso-images` |
| VM 操作 | `POST /api/vms/action` |
| VM 改名 | `POST /api/vms/rename` |
| VM 定时任务 | `GET /api/vm-schedules`, `POST /api/vm-schedules`, `PUT /api/vm-schedules/:id`, `PATCH /api/vm-schedules/:id/enabled`, `DELETE /api/vm-schedules/:id` |
| 指标快照 | `POST /api/metrics/snapshot` |
| 创建 VM | `POST /api/provisioning/preflight`, `POST /api/provisioning/vms` |
| 创建任务 | `GET /api/provisioning/tasks`, `GET /api/provisioning/tasks/:taskId` |
| 控制台 | `/api/console/xenserver`, `/api/console/vmware`, `/api/console/proxmox` |
| 控制台上传 | `POST /api/console/upload`, `GET /api/console/upload/:uploadId/events` |

---

## 开发说明

- 新增平台时优先实现 `apps/api/src/providers/provider.ts` 中定义的 Provider 能力
- UI 不直接处理平台私有字段，平台差异应在 Provider 或前端 domain 策略内收敛
- 资源盘点接口应避免首屏一次性读取所有 VM、磁盘、快照和指标
- 变更类能力需要保留确认、审计和失败提示语义
- 前端样式遵循已有 Element Plus 与项目主题变量，不新增一次性颜色体系

## 文档索引

| 文档 | 内容 |
|------|------|
| `docs/分发与打包策略.md` | Chrome 插件、内网服务器、macOS / Windows 桌面客户端和多形态交付策略 |

其它设计、原型和排查文档默认保留在本地 `docs/` 目录，不随仓库提交。

---

## License

MIT
