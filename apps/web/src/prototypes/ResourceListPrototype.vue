<script setup lang="ts">
import { computed, ref } from "vue";
import { Clock, Close, Search, Setting } from "@element-plus/icons-vue";
import VrcLogoMark from "../components/VrcLogoMark.vue";
import VrcToolbarIcon from "../components/VrcToolbarIcon.vue";
import VrcVmActionIcon from "../components/VrcVmActionIcon.vue";

type ActiveList = "hosts" | "vms";
type SortOrder = "ascending" | "descending" | null;
type PowerFilter = "all" | "running" | "stopped";

interface SortState {
  prop: string;
  order: SortOrder;
}

interface HostRow {
  id: string;
  name: string;
  address: string;
  platform: string;
  state: "online" | "warning" | "offline";
  cpuUsage: number;
  cpuCores: number;
  memoryFree: number;
  memoryTotal: number;
  storageFree: number;
  storageTotal: number;
  runningVms: number;
  totalVms: number;
  updatedAt: string;
}

interface VmRow {
  id: string;
  name: string;
  host: string;
  platform: string;
  state: "running" | "stopped" | "suspended";
  system: string;
  vcpu: number;
  memory: number;
  disk: number;
  diskCount: number;
  ip: string;
}

const hostRows: HostRow[] = [
  { id: "h1", name: "xenserver-01", address: "192.168.2.31", platform: "XenServer", state: "online", cpuUsage: 43, cpuCores: 56, memoryFree: 67.8, memoryTotal: 191.8, storageFree: 1834, storageTotal: 15366, runningVms: 18, totalVms: 22, updatedAt: "刚刚" },
  { id: "h2", name: "xenserver-02", address: "192.168.2.32", platform: "XenServer", state: "warning", cpuUsage: 82, cpuCores: 48, memoryFree: 18.2, memoryTotal: 128, storageFree: 420, storageTotal: 8192, runningVms: 21, totalVms: 24, updatedAt: "12 秒前" },
  { id: "h3", name: "pve-node-01", address: "192.168.2.41", platform: "Proxmox VE", state: "online", cpuUsage: 36, cpuCores: 64, memoryFree: 94.6, memoryTotal: 256, storageFree: 2960, storageTotal: 12288, runningVms: 15, totalVms: 19, updatedAt: "20 秒前" },
  { id: "h4", name: "pve-node-02", address: "192.168.2.42", platform: "Proxmox VE", state: "online", cpuUsage: 59, cpuCores: 64, memoryFree: 72.1, memoryTotal: 256, storageFree: 1640, storageTotal: 12288, runningVms: 17, totalVms: 18, updatedAt: "24 秒前" },
  { id: "h5", name: "esxi-prod-01", address: "192.168.2.51", platform: "VMware", state: "warning", cpuUsage: 76, cpuCores: 48, memoryFree: 11.4, memoryTotal: 192, storageFree: 780, storageTotal: 10240, runningVms: 25, totalVms: 27, updatedAt: "31 秒前" },
  { id: "h6", name: "esxi-prod-02", address: "192.168.2.52", platform: "VMware", state: "online", cpuUsage: 28, cpuCores: 48, memoryFree: 88.7, memoryTotal: 192, storageFree: 3420, storageTotal: 10240, runningVms: 12, totalVms: 16, updatedAt: "35 秒前" },
  { id: "h7", name: "xenserver-dr", address: "192.168.3.31", platform: "XenServer", state: "offline", cpuUsage: 0, cpuCores: 32, memoryFree: 0, memoryTotal: 128, storageFree: 0, storageTotal: 6144, runningVms: 0, totalVms: 9, updatedAt: "8 分钟前" },
  { id: "h8", name: "pve-lab-01", address: "192.168.4.41", platform: "Proxmox VE", state: "online", cpuUsage: 18, cpuCores: 32, memoryFree: 46.4, memoryTotal: 96, storageFree: 910, storageTotal: 4096, runningVms: 7, totalVms: 11, updatedAt: "42 秒前" },
  { id: "h9", name: "esxi-dev-01", address: "192.168.4.51", platform: "VMware", state: "online", cpuUsage: 51, cpuCores: 32, memoryFree: 29.3, memoryTotal: 128, storageFree: 1260, storageTotal: 6144, runningVms: 13, totalVms: 15, updatedAt: "48 秒前" },
];

const vmRows: VmRow[] = [
  { id: "vm1", name: "prod-api-01", host: "xenserver-01", platform: "XenServer", state: "running", system: "Rocky Linux 9.4", vcpu: 8, memory: 16, disk: 320, diskCount: 2, ip: "10.20.1.21" },
  { id: "vm2", name: "prod-api-02", host: "xenserver-01", platform: "XenServer", state: "running", system: "Rocky Linux 9.4", vcpu: 8, memory: 16, disk: 320, diskCount: 2, ip: "10.20.1.22" },
  { id: "vm3", name: "prod-db-primary", host: "esxi-prod-01", platform: "VMware", state: "running", system: "Windows Server 2022", vcpu: 16, memory: 64, disk: 2048, diskCount: 4, ip: "10.20.2.11" },
  { id: "vm4", name: "prod-db-standby", host: "esxi-prod-02", platform: "VMware", state: "stopped", system: "Windows Server 2022", vcpu: 16, memory: 64, disk: 2048, diskCount: 4, ip: "10.20.2.12" },
  { id: "vm5", name: "redis-cluster-01", host: "pve-node-01", platform: "Proxmox VE", state: "running", system: "Ubuntu 24.04 LTS", vcpu: 4, memory: 12, disk: 120, diskCount: 1, ip: "10.20.3.31" },
  { id: "vm6", name: "redis-cluster-02", host: "pve-node-02", platform: "Proxmox VE", state: "running", system: "Ubuntu 24.04 LTS", vcpu: 4, memory: 12, disk: 120, diskCount: 1, ip: "10.20.3.32" },
  { id: "vm7", name: "jenkins-runner", host: "pve-lab-01", platform: "Proxmox VE", state: "suspended", system: "Debian 12", vcpu: 6, memory: 8, disk: 180, diskCount: 2, ip: "10.20.4.18" },
  { id: "vm8", name: "test-windows-01", host: "esxi-dev-01", platform: "VMware", state: "stopped", system: "Windows 11 Enterprise", vcpu: 4, memory: 8, disk: 256, diskCount: 1, ip: "10.20.4.51" },
  { id: "vm9", name: "monitoring-main", host: "xenserver-02", platform: "XenServer", state: "running", system: "Ubuntu 22.04 LTS", vcpu: 8, memory: 24, disk: 640, diskCount: 3, ip: "10.20.5.10" },
  { id: "vm10", name: "archive-service", host: "xenserver-02", platform: "XenServer", state: "stopped", system: "CentOS 7", vcpu: 2, memory: 4, disk: 4096, diskCount: 5, ip: "10.20.5.60" },
  { id: "vm11", name: "k8s-control-01", host: "pve-node-01", platform: "Proxmox VE", state: "running", system: "Rocky Linux 9.3", vcpu: 8, memory: 16, disk: 240, diskCount: 2, ip: "10.20.6.11" },
  { id: "vm12", name: "k8s-worker-01", host: "pve-node-02", platform: "Proxmox VE", state: "running", system: "Rocky Linux 9.3", vcpu: 12, memory: 32, disk: 480, diskCount: 2, ip: "10.20.6.21" },
];

const activeList = ref<ActiveList>("hosts");
const sortStyle = ref<"a" | "b" | "c">("a");
const hostSearch = ref("");
const hostPlatform = ref("all");
const hostState = ref("all");
const hostSort = ref<SortState>({ prop: "name", order: "ascending" });

const vmSearch = ref("");
const vmHost = ref("all");
const vmPower = ref<PowerFilter>("all");
const vmSort = ref<SortState>({ prop: "name", order: "ascending" });
const selectedVms = ref<VmRow[]>([]);

const platformOptions = ["XenServer", "Proxmox VE", "VMware"];
const hostOptions = Array.from(new Set(vmRows.map((row) => row.host))).sort();

const filteredHosts = computed(() => {
  const keyword = hostSearch.value.trim().toLowerCase();
  const rows = hostRows.filter((row) => {
    const keywordMatched = !keyword || `${row.name} ${row.address} ${row.platform}`.toLowerCase().includes(keyword);
    const platformMatched = hostPlatform.value === "all" || row.platform === hostPlatform.value;
    const stateMatched = hostState.value === "all" || row.state === hostState.value;
    return keywordMatched && platformMatched && stateMatched;
  });
  return sortRows(rows, hostSort.value);
});

const hostFilterCount = computed(() => Number(!!hostSearch.value.trim()) + Number(hostPlatform.value !== "all") + Number(hostState.value !== "all"));

const filteredVms = computed(() => {
  const keyword = vmSearch.value.trim().toLowerCase();
  const rows = vmRows.filter((row) => {
    const keywordMatched = !keyword || `${row.name} ${row.ip} ${row.system}`.toLowerCase().includes(keyword);
    const hostMatched = vmHost.value === "all" || row.host === vmHost.value;
    const powerMatched = vmPower.value === "all" || (vmPower.value === "running" ? row.state === "running" : row.state === "stopped");
    return keywordMatched && hostMatched && powerMatched;
  });
  return sortRows(rows, vmSort.value);
});

const vmFilterCount = computed(() => Number(!!vmSearch.value.trim()) + Number(vmHost.value !== "all") + Number(vmPower.value !== "all"));

function sortRows<T extends object>(rows: T[], sort: SortState) {
  if (!sort.prop || !sort.order) return rows;
  const direction = sort.order === "ascending" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = (left as Record<string, unknown>)[sort.prop];
    const b = (right as Record<string, unknown>)[sort.prop];
    if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
    return String(a ?? "").localeCompare(String(b ?? ""), "zh-CN", { numeric: true }) * direction;
  });
}

function handleHostSort({ prop, order }: { prop: string; order: SortOrder }) {
  hostSort.value = { prop, order };
}

function handleVmSort({ prop, order }: { prop: string; order: SortOrder }) {
  vmSort.value = { prop, order };
}

function resetHostFilters() {
  hostSearch.value = "";
  hostPlatform.value = "all";
  hostState.value = "all";
  hostSort.value = { prop: "name", order: "ascending" };
}

function resetVmFilters() {
  vmSearch.value = "";
  vmHost.value = "all";
  vmPower.value = "all";
  vmSort.value = { prop: "name", order: "ascending" };
}

function memoryUsage(row: HostRow) {
  return row.memoryTotal ? Math.round(((row.memoryTotal - row.memoryFree) / row.memoryTotal) * 100) : 0;
}

function storageUsage(row: HostRow) {
  return row.storageTotal ? Math.round(((row.storageTotal - row.storageFree) / row.storageTotal) * 100) : 0;
}

function stateLabel(value: HostRow["state"]) {
  return value === "online" ? "正常" : value === "warning" ? "预警" : "离线";
}

function powerLabel(value: VmRow["state"]) {
  if (value === "running") return "运行中";
  if (value === "stopped") return "已关机";
  return "已暂停";
}

function handleVmSelection(rows: VmRow[]) {
  selectedVms.value = rows;
}
</script>

<template>
  <main class="app-shell resource-list-prototype">
    <aside class="sidebar">
      <div class="sidebar-head">
        <div class="brand-lockup">
          <span class="brand-mark sidebar-logo" aria-hidden="true"><VrcLogoMark shadow /></span>
          <div class="brand-copy"><h1>资源控制台</h1><p>16 个连接</p></div>
        </div>
        <button class="icon-button settings-entry-button" type="button" aria-label="设置"><el-icon><Setting /></el-icon></button>
      </div>
      <section class="sidebar-section"><el-input class="sidebar-search" placeholder="输入名称、平台或地址" :prefix-icon="Search" /></section>
      <div class="connection-groups">
        <section class="connection-group overview-group">
          <button class="overview-entry active" type="button"><span class="overview-entry-icon">↗</span><span class="overview-entry-main"><strong>资源总览</strong><small>查看全部物理机</small></span></button>
        </section>
        <section class="connection-group">
          <div class="group-title"><span>XenServer</span></div>
          <button class="connection-item" type="button"><span class="status-dot online"></span><span class="connection-main"><strong>xenserver-01</strong><small>192.168.2.31</small></span><span class="connection-port">22</span></button>
          <button class="connection-item" type="button"><span class="status-dot online"></span><span class="connection-main"><strong>xenserver-02</strong><small>192.168.2.32</small></span><span class="connection-port">22</span></button>
        </section>
        <section class="connection-group">
          <div class="group-title"><span>Proxmox VE</span></div>
          <button class="connection-item" type="button"><span class="status-dot online"></span><span class="connection-main"><strong>pve-node-01</strong><small>192.168.2.41</small></span><span class="connection-port">8006</span></button>
        </section>
        <section class="connection-group">
          <div class="group-title"><span>VMware</span></div>
          <button class="connection-item" type="button"><span class="status-dot online"></span><span class="connection-main"><strong>esxi-prod-01</strong><small>192.168.2.51</small></span><span class="connection-port">443</span></button>
        </section>
      </div>
      <button class="activity-toggle" type="button"><span class="activity-toggle-icon"><el-icon><Clock /></el-icon></span><span>操作记录</span><strong>8</strong></button>
    </aside>

    <section class="workspace resource-list-workspace" :class="`sort-style-${sortStyle}`">
      <header class="resource-list-head">
        <div class="overview-title-group"><h3>资源列表</h3><span>物理机与虚拟机常用查询和排序。</span></div>
        <div class="resource-list-head-actions">
          <label class="sort-style-picker"><span>排序样式</span><el-segmented v-model="sortStyle" :options="[{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 'c' }]" /></label>
          <el-tabs v-model="activeList" class="resource-list-tabs">
            <el-tab-pane label="物理机总览" name="hosts" />
            <el-tab-pane label="虚拟机列表" name="vms" />
          </el-tabs>
        </div>
      </header>

      <section v-if="activeList === 'hosts'" class="resource-list-panel">
        <div class="resource-list-toolbar">
          <div class="resource-list-heading"><h3>物理机资源列表</h3><span>{{ filteredHosts.length }} / {{ hostRows.length }} 台</span></div>
          <div class="resource-query-row">
            <el-input v-model="hostSearch" class="resource-search" :prefix-icon="Search" placeholder="搜索名称 / IP" clearable />
            <el-select v-model="hostPlatform" class="compact-select" aria-label="平台筛选"><el-option label="全部平台" value="all" /><el-option v-for="item in platformOptions" :key="item" :label="item" :value="item" /></el-select>
            <el-select v-model="hostState" class="compact-select state-select" aria-label="状态筛选"><el-option label="全部状态" value="all" /><el-option label="正常" value="online" /><el-option label="预警" value="warning" /><el-option label="离线" value="offline" /></el-select>
            <el-tooltip v-if="hostFilterCount" content="清空当前筛选" placement="top"><button type="button" class="list-tool-button" aria-label="清空物理机筛选" @click="resetHostFilters()"><el-icon><Close /></el-icon></button></el-tooltip>
          </div>
          <div class="resource-list-actions">
            <el-tooltip content="导出当前查询结果" placement="top"><button type="button" class="list-tool-button" aria-label="导出物理机列表"><VrcToolbarIcon name="export" /></button></el-tooltip>
            <el-tooltip content="刷新物理机列表" placement="top"><button type="button" class="list-tool-button" aria-label="刷新物理机列表"><VrcToolbarIcon name="refresh" /></button></el-tooltip>
          </div>
        </div>
        <div class="resource-table-wrap">
          <el-table :data="filteredHosts" height="100%" row-key="id" stripe :default-sort="{ prop: 'name', order: 'ascending' }" @sort-change="handleHostSort">
            <el-table-column type="index" label="序号" width="54" align="center" />
            <el-table-column prop="name" label="物理机" min-width="160" sortable="custom" show-overflow-tooltip><template #default="{ row }"><span class="primary-cell"><button class="table-link drilldown-link">{{ row.name }}</button><small>{{ row.address }}</small></span></template></el-table-column>
            <el-table-column prop="platform" label="平台" min-width="96" align="center" />
            <el-table-column prop="state" label="状态" width="72" align="center"><template #default="{ row }"><span class="state-text" :class="`host-state-${row.state}`">{{ stateLabel(row.state) }}</span></template></el-table-column>
            <el-table-column prop="cpuUsage" label="CPU 使用率" min-width="138" align="right" sortable="custom"><template #default="{ row }"><span class="resource-value"><strong>{{ row.cpuUsage }}%</strong><span class="row-meter" :class="{ warning: row.cpuUsage >= 75 }"><i :style="{ width: `${row.cpuUsage}%` }"></i></span><small>{{ row.cpuCores }} 核</small></span></template></el-table-column>
            <el-table-column prop="memoryFree" label="内存余量" min-width="142" align="right" sortable="custom"><template #default="{ row }"><span class="resource-value"><strong>{{ row.memoryFree }} GiB</strong><span class="row-meter" :class="{ warning: memoryUsage(row) >= 85 }"><i :style="{ width: `${memoryUsage(row)}%` }"></i></span><small>共 {{ row.memoryTotal }} GiB</small></span></template></el-table-column>
            <el-table-column prop="storageFree" label="存储余量" min-width="148" align="right" sortable="custom"><template #default="{ row }"><span class="resource-value"><strong>{{ row.storageFree.toLocaleString() }} GiB</strong><span class="row-meter" :class="{ warning: storageUsage(row) >= 85 }"><i :style="{ width: `${storageUsage(row)}%` }"></i></span><small>共 {{ row.storageTotal.toLocaleString() }} GiB</small></span></template></el-table-column>
            <el-table-column prop="totalVms" label="VM" width="78" align="center" sortable="custom"><template #default="{ row }">{{ row.runningVms }} / {{ row.totalVms }}</template></el-table-column>
            <el-table-column prop="updatedAt" label="更新" width="90" align="center" />
          </el-table>
        </div>
      </section>

      <section v-else class="resource-list-panel">
        <div class="resource-list-toolbar">
          <div class="resource-list-heading"><h3>虚拟机列表</h3><span>{{ filteredVms.length }} / {{ vmRows.length }} 台<template v-if="selectedVms.length"> · 已选 {{ selectedVms.length }} 台</template></span></div>
          <div class="resource-query-row vm-query-row">
            <el-input v-model="vmSearch" class="resource-search" :prefix-icon="Search" placeholder="搜索名称 / IP / 系统" clearable />
            <el-select v-model="vmHost" class="compact-select host-select" aria-label="物理机筛选"><el-option label="全部物理机" value="all" /><el-option v-for="item in hostOptions" :key="item" :label="item" :value="item" /></el-select>
            <el-segmented v-model="vmPower" class="vm-power-filter" :options="[{ label: '全部', value: 'all' }, { label: '开机', value: 'running' }, { label: '关机', value: 'stopped' }]" />
            <el-tooltip v-if="vmFilterCount" content="清空当前筛选" placement="top"><button type="button" class="list-tool-button" aria-label="清空虚拟机筛选" @click="resetVmFilters()"><el-icon><Close /></el-icon></button></el-tooltip>
          </div>
          <div v-if="selectedVms.length" class="prototype-batch-actions">
            <el-tooltip content="批量开机" placement="top"><button class="vm-batch-action action-start"><VrcVmActionIcon name="start" /></button></el-tooltip>
            <el-tooltip content="批量关机" placement="top"><button class="vm-batch-action action-shutdown"><VrcVmActionIcon name="shutdown" /></button></el-tooltip>
            <el-tooltip content="批量删除" placement="top"><button class="vm-batch-action action-delete"><VrcVmActionIcon name="delete" /></button></el-tooltip>
          </div>
          <div class="resource-list-actions">
            <el-tooltip content="导出当前查询结果" placement="top"><button type="button" class="list-tool-button" aria-label="导出虚拟机列表"><VrcToolbarIcon name="export" /></button></el-tooltip>
            <el-tooltip content="刷新虚拟机列表" placement="top"><button type="button" class="list-tool-button" aria-label="刷新虚拟机列表"><VrcToolbarIcon name="refresh" /></button></el-tooltip>
          </div>
        </div>
        <div class="resource-table-wrap">
          <el-table :data="filteredVms" height="100%" row-key="id" stripe :default-sort="{ prop: 'name', order: 'ascending' }" @sort-change="handleVmSort" @selection-change="handleVmSelection">
            <el-table-column type="selection" width="40" align="center" reserve-selection />
            <el-table-column type="index" label="序号" width="48" align="center" />
            <el-table-column prop="name" label="名称" min-width="142" sortable="custom" show-overflow-tooltip><template #default="{ row }"><button class="vm-console-link drilldown-link">{{ row.name }}</button></template></el-table-column>
            <el-table-column prop="host" label="物理机" min-width="110" sortable="custom" show-overflow-tooltip />
            <el-table-column prop="state" label="状态" width="76" align="center" sortable="custom"><template #default="{ row }"><span class="state-text" :class="`vm-state-${row.state}`">{{ powerLabel(row.state) }}</span></template></el-table-column>
            <el-table-column prop="system" label="系统" min-width="120" show-overflow-tooltip />
            <el-table-column prop="vcpu" label="vCPU" width="80" align="center" sortable="custom"><template #default="{ row }">{{ row.vcpu }} 核</template></el-table-column>
            <el-table-column prop="memory" label="内存" width="70" align="center" sortable="custom"><template #default="{ row }">{{ row.memory }} GiB</template></el-table-column>
            <el-table-column prop="disk" label="磁盘" width="96" align="center" sortable="custom"><template #default="{ row }"><span class="disk-total">{{ row.disk.toLocaleString() }} GiB</span><small class="disk-subtitle">{{ row.diskCount }} 块</small></template></el-table-column>
            <el-table-column prop="ip" label="IP" width="112" align="center" sortable="custom" />
            <el-table-column label="操作" width="146" align="center" fixed="right" class-name="vm-operation-column" label-class-name="vm-operation-column"><template #default="{ row }"><div class="vm-action-cell"><button class="vm-action-link action-start" :disabled="row.state === 'running'" title="开机"><VrcVmActionIcon name="start" /></button><button class="vm-action-link action-shutdown" :disabled="row.state !== 'running'" title="关机"><VrcVmActionIcon name="shutdown" /></button><button class="vm-action-link action-force-reboot" :disabled="row.state !== 'running'" title="强制重启"><VrcVmActionIcon name="forceReboot" /></button><button class="vm-action-link action-delete" :disabled="row.state === 'running'" title="删除"><VrcVmActionIcon name="delete" /></button></div></template></el-table-column>
          </el-table>
        </div>
      </section>
    </section>
  </main>
</template>

<style scoped>
.resource-list-workspace {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 14px 12px 10px;
  overflow: hidden;
}

.resource-list-head {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  min-height: 46px;
}

.resource-list-head h3,
.resource-list-heading h3 {
  margin: 0;
  color: var(--vrc-text);
  font-size: 15px;
  font-weight: 600;
}

.resource-list-head .overview-title-group span,
.resource-list-heading span {
  color: var(--vrc-text-muted);
  font-size: 11px;
}

.resource-list-tabs {
  width: 248px;
}

.resource-list-head-actions,
.sort-style-picker {
  display: flex;
  align-items: center;
}

.resource-list-head-actions {
  gap: 18px;
}

.sort-style-picker {
  gap: 7px;
  color: var(--vrc-text-muted);
  font-size: 11px;
  font-weight: 400;
  white-space: nowrap;
}

.sort-style-picker :deep(.el-segmented) {
  width: 112px;
  height: 28px;
  padding: 2px;
  background: var(--vrc-surface-muted);
  border: 1px solid transparent;
  border-radius: 7px;
}

.sort-style-picker :deep(.el-segmented__item) {
  min-height: 22px;
  padding: 0 9px;
  color: var(--vrc-text-muted);
  font-size: 12px;
  font-weight: 400;
  border-radius: 5px;
}

.sort-style-picker :deep(.el-segmented__item-selected) {
  color: var(--vrc-text);
  background: var(--vrc-surface);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--vrc-text) 8%, transparent);
}

.resource-list-tabs :deep(.el-tabs__header) {
  margin: 0;
}

.resource-list-tabs :deep(.el-tabs__nav-wrap::after) {
  height: 1px;
  background: var(--vrc-border);
}

.resource-list-tabs :deep(.el-tabs__item) {
  height: 36px;
  padding: 0 12px;
  color: var(--vrc-text-muted);
  font-size: 12px;
  font-weight: 400;
}

.resource-list-tabs :deep(.el-tabs__item.is-active) {
  color: var(--vrc-accent);
}

.resource-list-tabs :deep(.el-tabs__active-bar) {
  height: 2px;
  background: var(--vrc-accent);
}

.resource-list-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  margin-top: 10px;
  overflow: hidden;
  background: var(--vrc-surface);
  border: 1px solid var(--vrc-border);
  border-radius: 8px;
}

.resource-list-toolbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--vrc-border);
}

.resource-list-heading {
  flex: 0 0 140px;
  min-width: 0;
}

.resource-list-heading h3 {
  overflow: hidden;
  font-size: 13px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resource-query-row {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.resource-search {
  flex: 1 1 180px;
  max-width: 240px;
  min-width: 160px;
}

.compact-select {
  width: 110px;
}

.state-select {
  width: 104px;
}

.host-select {
  width: 132px;
}

.resource-query-row :deep(.el-input__wrapper),
.resource-query-row :deep(.el-select__wrapper) {
  min-height: 28px;
  height: 28px;
  background: var(--vrc-surface-muted);
  border: 1px solid transparent;
  border-radius: 7px;
  box-shadow: none;
}

.resource-query-row :deep(.el-input__wrapper.is-focus),
.resource-query-row :deep(.el-select__wrapper.is-focused) {
  background: var(--vrc-surface-muted);
  border-color: color-mix(in srgb, var(--vrc-accent) 50%, var(--vrc-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vrc-accent) 12%, transparent);
}

.resource-query-row :deep(.el-input__inner),
.resource-query-row :deep(.el-select__selected-item),
.resource-query-row :deep(.el-select__placeholder) {
  height: 26px;
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 400;
  line-height: 26px;
}

.resource-list-actions,
.prototype-batch-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.prototype-batch-actions {
  padding-left: 8px;
  border-left: 1px solid var(--vrc-border);
}

.list-tool-button {
  display: grid;
  place-items: center;
  width: 28px;
  min-width: 28px;
  height: 28px;
  padding: 0;
  color: var(--vrc-text-muted);
  background: transparent;
  border: 1px solid var(--vrc-border);
  border-radius: 7px;
  cursor: pointer;
}

.list-tool-button:hover,
.list-tool-button:focus-visible {
  color: var(--vrc-accent);
  border-color: color-mix(in srgb, var(--vrc-accent) 32%, var(--vrc-border));
  outline: 0;
}

.list-tool-button :deep(.el-icon),
.list-tool-button :deep(.vrc-toolbar-icon) {
  width: 16px;
  height: 16px;
  font-size: 16px;
}

.resource-table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.resource-table-wrap :deep(.el-table) {
  color: var(--vrc-text);
  font-size: 12px;
}

.resource-table-wrap :deep(.el-table th.el-table__cell) {
  height: 40px;
  color: var(--vrc-text-muted);
  background: var(--vrc-surface-muted);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
}

.resource-table-wrap :deep(.el-table th.is-sortable > .cell) {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  white-space: nowrap;
}

.resource-table-wrap :deep(.el-table th.is-center.is-sortable > .cell) {
  justify-content: center;
}

.resource-table-wrap :deep(.el-table th.is-right.is-sortable > .cell) {
  justify-content: flex-end;
}

.resource-table-wrap :deep(.el-table .caret-wrapper) {
  margin-left: 3px;
  overflow: hidden;
  border-radius: 0;
  opacity: 0.42;
  transition:
    opacity 140ms ease,
    background-color 140ms ease;
}

.resource-table-wrap :deep(.el-table th.is-sortable:hover .caret-wrapper),
.resource-table-wrap :deep(.el-table .caret-wrapper:hover) {
  opacity: 0.76;
}

.resource-table-wrap :deep(.el-table th.ascending .caret-wrapper),
.resource-table-wrap :deep(.el-table th.descending .caret-wrapper) {
  opacity: 1;
}

.resource-table-wrap :deep(.el-table .caret-wrapper:focus-visible) {
  outline: 0;
  box-shadow: none;
}

.resource-table-wrap :deep(.el-table .sort-caret.ascending) {
  border-bottom-color: color-mix(in srgb, var(--vrc-text-muted) 68%, transparent);
}

.resource-table-wrap :deep(.el-table .sort-caret.descending) {
  border-top-color: color-mix(in srgb, var(--vrc-text-muted) 68%, transparent);
}

.resource-table-wrap :deep(.el-table .ascending .sort-caret.ascending) {
  border-bottom-color: var(--vrc-accent);
}

.resource-table-wrap :deep(.el-table .descending .sort-caret.descending) {
  border-top-color: var(--vrc-accent);
}

.sort-style-a .resource-table-wrap :deep(.el-table .caret-wrapper) {
  width: 18px;
  height: 20px;
}

.sort-style-a .resource-table-wrap :deep(.el-table .sort-caret) {
  left: 5px;
  border-width: 4px;
}

.sort-style-a .resource-table-wrap :deep(.el-table .sort-caret.ascending) {
  top: 1px;
}

.sort-style-a .resource-table-wrap :deep(.el-table .sort-caret.descending) {
  bottom: 1px;
}

.sort-style-b .resource-table-wrap :deep(.el-table .caret-wrapper) {
  width: 20px;
  height: 24px;
}

.sort-style-b .resource-table-wrap :deep(.el-table .sort-caret) {
  left: 5px;
  border-width: 5px;
  transition: opacity 140ms ease;
}

.sort-style-b .resource-table-wrap :deep(.el-table .sort-caret.ascending) {
  top: 1px;
}

.sort-style-b .resource-table-wrap :deep(.el-table .sort-caret.descending) {
  bottom: 1px;
}

.sort-style-b .resource-table-wrap :deep(.el-table th.ascending .sort-caret.descending),
.sort-style-b .resource-table-wrap :deep(.el-table th.descending .sort-caret.ascending) {
  opacity: 0.08;
}

.sort-style-c .resource-table-wrap :deep(.el-table .caret-wrapper) {
  width: 24px;
  height: 24px;
  margin-left: 3px;
  border-radius: 5px;
}

.sort-style-c .resource-table-wrap :deep(.el-table th.is-sortable:hover .caret-wrapper),
.sort-style-c .resource-table-wrap :deep(.el-table .caret-wrapper:hover),
.sort-style-c .resource-table-wrap :deep(.el-table th.ascending .caret-wrapper),
.sort-style-c .resource-table-wrap :deep(.el-table th.descending .caret-wrapper) {
  background: var(--vrc-accent-soft);
}

.sort-style-c .resource-table-wrap :deep(.el-table .sort-caret) {
  left: 8px;
  border-width: 4px;
}

.sort-style-c .resource-table-wrap :deep(.el-table .sort-caret.ascending) {
  top: 3px;
}

.sort-style-c .resource-table-wrap :deep(.el-table .sort-caret.descending) {
  bottom: 3px;
}

.resource-table-wrap :deep(.el-table td.el-table__cell) {
  height: 56px;
  padding: 7px 0;
}

.resource-table-wrap :deep(.el-table__body tr:hover > td.el-table__cell) {
  background: color-mix(in srgb, var(--vrc-accent) 6%, var(--vrc-surface)) !important;
}

.primary-cell,
.resource-value {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.primary-cell small,
.resource-value small {
  color: var(--vrc-text-subtle);
  font-size: 10px;
  font-weight: 400;
}

.resource-value {
  justify-items: end;
  min-width: 112px;
}

.resource-value strong {
  color: var(--vrc-text);
  font-size: 12px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.row-meter {
  display: block;
  width: 92px;
  height: 3px;
  overflow: hidden;
  background: color-mix(in srgb, var(--vrc-border) 58%, var(--vrc-surface));
  border-radius: 999px;
}

.row-meter i {
  display: block;
  height: 100%;
  background: var(--vrc-accent);
  border-radius: inherit;
}

.row-meter.warning i {
  background: var(--vrc-warning);
}

.host-state-online,
.vm-state-running {
  color: var(--vrc-success);
}

.host-state-warning,
.vm-state-suspended {
  color: var(--vrc-warning);
}

.host-state-offline,
.vm-state-stopped {
  color: var(--vrc-text-muted);
}

@media (max-width: 1320px) {
  .resource-list-heading {
    display: none;
  }

  .resource-search {
    max-width: 200px;
  }
}
</style>
