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
- `runtime-policy.json`：本机运行策略，例如 IP 白名单、默认 IP 池、DNS、口令模板和 XenServer 网卡映射

这些文件属于本机运行数据，不应提交到 GitHub。

### 本机运行策略

可通过以下文件维护环境相关策略：

```text
~/.virtual-resource-console/runtime-policy.json
```

仓库提供了不含真实环境信息的示例：

```bash
cp config/runtime-policy.example.json ~/.virtual-resource-console/runtime-policy.json
```

运行策略支持配置：

- `managedIpPattern`：可识别和展示的 IPv4 白名单正则
- `ipInference`：从 VM 名称推断 IP 的短 IP / 主机号规则
- `provisioning.defaultDns`：创建 VM 默认 DNS
- `provisioning.rootPasswordTemplate`：初始 root 口令模板，支持 `{first}`、`{second}`、`{third}`、`{fourth}`、`{ip}`
- `provisioning.providerIpPools`：各 Provider 的默认 IP 池
- `xenserver.networkDeviceRules`：XenServer 创建 VM 时按 IP 前缀选择 PIF 设备

### 环境变量

| 变量 | 说明 |
|------|------|
| `HOST` | API 监听地址，默认本地脚本使用 `0.0.0.0` |
| `PORT` | API 端口，默认 `3987` |
| `VRC_RUNTIME_POLICY_FILE` | 自定义运行策略配置文件路径 |
| `VRC_INSTALL_SOURCE_BASE_URL` | 创建 VM 时暴露给新 VM 访问的安装源地址 |
| `VRC_ALLOW_CROSS_SUBNET_INSTALL_SOURCE` | 是否允许跨网段安装源校验，默认关闭 |
| `VRC_XEN_INSTALL_MEDIA_MODE` | XenServer 安装介质模式 |

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
| 指标快照 | `POST /api/metrics/snapshot` |
| 创建 VM | `POST /api/provisioning/preflight`, `POST /api/provisioning/vms` |
| 创建任务 | `GET /api/provisioning/tasks`, `GET /api/provisioning/tasks/:taskId` |
| 控制台 | `/api/console/xenserver`, `/api/console/vmware`, `/api/console/proxmox` |

---

## 开发说明

- 新增平台时优先实现 `apps/api/src/providers/provider.ts` 中定义的 Provider 能力
- UI 不直接处理平台私有字段，平台差异应在 Provider 或前端 domain 策略内收敛
- 资源盘点接口应避免首屏一次性读取所有 VM、磁盘、快照和指标
- 变更类能力需要保留确认、审计和失败提示语义
- 前端样式遵循已有 Element Plus 与项目主题变量，不新增一次性颜色体系

---

## License

MIT
