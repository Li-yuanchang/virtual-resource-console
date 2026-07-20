<script setup lang="ts">
import { Search, Setting } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, reactive, ref, watch } from "vue";
import HostVmPanel from "../components/HostVmPanel.vue";
import VrcLogoMark from "../components/VrcLogoMark.vue";
import VmRenameDialog from "../components/VmRenameDialog.vue";
import type { HostNode, ProviderType, VmNode } from "../types";

interface PrototypeScenario {
  id: string;
  name: string;
  providerType: ProviderType;
  providerLabel: string;
  host: HostNode;
  vms: VmNode[];
}

const gib = 1024 ** 3;

const scenarios = reactive<PrototypeScenario[]>([
  {
    id: "conn-xen",
    name: "生产资源池",
    providerType: "xenserver",
    providerLabel: "XenServer",
    host: { id: "host-xen-12", connectionId: "conn-xen", poolId: "pool-prod", providerId: "host-xen-12", name: "xenserver-12", address: "192.0.2.22", vendor: "XenServer", version: "7.1 CU1", cpuModel: "Intel Xeon Gold", cpuSockets: 2, cpuCores: 48, memoryTotalBytes: 1534.6 * gib, memoryFreeBytes: 478.3 * gib, status: "online" },
    vms: [
      vm("conn-xen", "host-xen-12", "xen-vm-127", "127.83_生产_智能问答_知识产品中心_马鑫林", "running", 8, 16, 200, "198.51.100.83", "Rocky Linux 9.4"),
      vm("conn-xen", "host-xen-12", "xen-vm-102", "127.102-生产-轻骑兵平台资产中心生产环境", "running", 4, 16, 500, "198.51.100.102", "Rocky Linux 9.4"),
      vm("conn-xen", "host-xen-12", "xen-vm-232", "127.232_生产运营支撑文件服务器_公司", "running", 4, 4, 1024, "198.51.100.232", "CentOS 7.9"),
      vm("conn-xen", "host-xen-12", "xen-vm-233", "127.233_生产_运营支撑生产环境", "halted", 8, 16, 300, "198.51.100.233", "CentOS 7.9"),
    ],
  },
  {
    id: "conn-vmware",
    name: "VMware 生产集群",
    providerType: "vmware",
    providerLabel: "VMware",
    host: { id: "host-esxi-17", connectionId: "conn-vmware", providerId: "host-esxi-17", name: "esxi-prod-17", address: "203.0.113.17", vendor: "VMware", version: "ESXi 8.0 U3", cpuModel: "Intel Xeon Gold", cpuSockets: 2, cpuCores: 56, memoryTotalBytes: 1024 * gib, memoryFreeBytes: 382 * gib, status: "online" },
    vms: [
      { ...vm("conn-vmware", "host-esxi-17", "vm-2041", "prod-order-api-01", "running", 8, 24, 240, "203.0.113.81", "VMware Photon OS"), metadata: { managedObjectId: "vm-2041" } },
      { ...vm("conn-vmware", "host-esxi-17", "vm-2042", "prod-order-api-02", "running", 8, 24, 240, "203.0.113.82", "VMware Photon OS"), metadata: { managedObjectId: "vm-2042" } },
      { ...vm("conn-vmware", "host-esxi-17", "vm-2068", "reporting-worker-01", "halted", 4, 12, 180, "203.0.113.116", "Ubuntu Server 24.04"), metadata: { managedObjectId: "vm-2068" } },
    ],
  },
  {
    id: "conn-pve",
    name: "PVE 运维节点",
    providerType: "proxmox",
    providerLabel: "Proxmox VE",
    host: { id: "pve-20", connectionId: "conn-pve", providerId: "pve-20", name: "pve-20", address: "198.51.100.20", vendor: "Proxmox", version: "PVE 8.4", cpuModel: "AMD EPYC", cpuSockets: 2, cpuCores: 64, memoryTotalBytes: 768 * gib, memoryFreeBytes: 294 * gib, status: "online" },
    vms: [
      vm("conn-pve", "pve-20", "pve-20:301", "ops-monitor-01", "running", 4, 8, 100, "198.51.100.61", "Debian 12"),
      vm("conn-pve", "pve-20", "pve-20:302", "ops-monitor-02", "running", 4, 8, 100, "198.51.100.62", "Debian 12"),
      vm("conn-pve", "pve-20", "pve-20:318", "backup-runner-01", "halted", 8, 16, 500, "198.51.100.118", "Rocky Linux 9.4"),
    ],
  },
]);

const activeScenarioId = ref(scenarios[0].id);
const detailVisible = ref(true);
const renameVisible = ref(false);
const renameTarget = ref<VmNode | null>(null);
const saving = ref(false);
const search = ref("");
const powerFilter = ref<"all" | "running" | "stopped">("all");
const selectedVmIds = ref<string[]>([]);

const activeScenario = computed(() => scenarios.find((item) => item.id === activeScenarioId.value) ?? scenarios[0]);
const filteredVms = computed(() => {
  const keyword = search.value.trim().toLocaleLowerCase("zh-CN");
  return activeScenario.value.vms.filter((item) => {
    const powerMatched = powerFilter.value === "all" || (powerFilter.value === "running" ? item.powerState === "running" : item.powerState === "halted");
    return powerMatched && (!keyword || [item.name, item.providerId, ...item.ipAddresses].some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword)));
  });
});
const vmTotals = computed(() => ({
  all: activeScenario.value.vms.length,
  running: activeScenario.value.vms.filter((item) => item.powerState === "running").length,
  halted: activeScenario.value.vms.filter((item) => item.powerState === "halted").length,
  vcpu: activeScenario.value.vms.reduce((sum, item) => sum + item.cpuCount, 0),
  runningVcpu: activeScenario.value.vms.filter((item) => item.powerState === "running").reduce((sum, item) => sum + item.cpuCount, 0),
  memoryBytes: activeScenario.value.vms.reduce((sum, item) => sum + item.memoryBytes, 0),
  diskBytes: activeScenario.value.vms.reduce((sum, item) => sum + (item.diskVirtualBytes ?? 0), 0),
}));
const resourceSummary = computed(() => [
  { key: "cpu", used: vmTotals.value.runningVcpu, free: Math.max(activeScenario.value.host.cpuCores - vmTotals.value.runningVcpu, 0), over: 0, percent: 42, subline: `${vmTotals.value.runningVcpu} 运行 vCPU · 共配置 ${vmTotals.value.vcpu} vCPU` },
  { key: "memory", used: 642, free: 382, over: 0, percent: 63, subline: "剩余 382 GiB" },
  { key: "storage", used: 11900, free: 3870, over: 0, percent: 75, subline: "剩余 3,870 GiB · 虚拟分配 18,420 GiB" },
]);

function vm(connectionId: string, hostId: string, providerId: string, name: string, powerState: VmNode["powerState"], cpu: number, memory: number, disk: number, ip: string, guestOs: string): VmNode {
  return { id: providerId, connectionId, hostId, providerId, name, powerState, cpuCount: cpu, memoryBytes: memory * gib, diskVirtualBytes: disk * gib, diskCount: 1, diskSizeSummary: `${disk} GiB`, ipAddresses: [ip], guestOs, toolsStatus: "installed", reclaimLevel: "KEEP", reclaimReason: "" };
}

function selectScenario(id: string) {
  activeScenarioId.value = id;
  search.value = "";
  powerFilter.value = "all";
  selectedVmIds.value = [];
  detailVisible.value = true;
}

function selectScenarioRow(row: PrototypeScenario) {
  selectScenario(row.id);
}

function openRename(target: VmNode) {
  renameTarget.value = target;
  renameVisible.value = true;
}

function handleVmSelectionChange(rows: VmNode[]) {
  selectedVmIds.value = rows.map((row) => row.providerId);
}

watch(detailVisible, (visible) => {
  if (!visible) selectedVmIds.value = [];
});

function submitRename(payload: { vm: VmNode; newName: string }) {
  saving.value = true;
  window.setTimeout(() => {
    payload.vm.name = payload.newName;
    saving.value = false;
    renameVisible.value = false;
    ElMessage.success(`${activeScenario.value.providerLabel} 虚拟机名称已更新`);
  }, 650);
}

function notifyPrototype(action: string) {
  ElMessage.info(`${action}在改名原型中不执行`);
}
</script>

<template>
  <main class="app-shell vm-rename-prototype">
    <aside class="sidebar">
      <div class="sidebar-head">
        <div class="brand-lockup">
          <span class="brand-mark sidebar-logo" aria-hidden="true">
            <VrcLogoMark shadow />
          </span>
          <div class="brand-copy"><h1>资源控制台</h1><p>3 个连接</p></div>
        </div>
        <button class="icon-button settings-entry-button" type="button" aria-label="设置"><el-icon><Setting /></el-icon></button>
      </div>
      <section class="sidebar-section">
        <el-input class="sidebar-search" placeholder="输入名称、平台或地址" :prefix-icon="Search" />
      </section>
      <div class="connection-groups">
        <section class="connection-group overview-group">
          <button class="overview-entry active" type="button">
            <span class="overview-entry-icon">V</span>
            <span class="overview-entry-main"><strong>资源总览</strong><small>3 个连接 · 3 台物理机</small></span>
          </button>
        </section>
        <section class="connection-group">
          <div class="group-title"><span>已保存连接</span></div>
          <button v-for="scenario in scenarios" :key="scenario.id" class="connection-item" :class="{ active: scenario.id === activeScenarioId }" type="button" @click="selectScenario(scenario.id)">
            <span class="status-dot online"></span>
            <span class="connection-main"><strong>{{ scenario.name }}</strong><small>{{ scenario.providerLabel }} · {{ scenario.host.address }}</small></span>
            <span class="connection-port">{{ scenario.vms.length }} VM</span>
          </button>
        </section>
      </div>
    </aside>

    <section class="workspace">
      <section class="panel overview-panel">
        <div class="overview-header">
          <div class="overview-title-group"><h3>物理机总览</h3><span>选择物理机查看虚拟机清单。</span></div>
        </div>
        <el-table :data="scenarios" height="100%" stripe @row-click="selectScenarioRow">
          <el-table-column type="index" label="序号" width="64" align="center" />
          <el-table-column prop="providerLabel" label="平台" width="140" align="center" />
          <el-table-column label="物理机" min-width="220"><template #default="{ row }"><button class="drilldown-link" @click.stop="selectScenario(row.id)">{{ row.host.name }}</button></template></el-table-column>
          <el-table-column label="管理 IP" width="160" align="center"><template #default="{ row }">{{ row.host.address }}</template></el-table-column>
          <el-table-column label="状态" width="100" align="center"><template #default>在线</template></el-table-column>
          <el-table-column label="VM" width="100" align="center"><template #default="{ row }">{{ row.vms.length }}</template></el-table-column>
        </el-table>
      </section>

      <el-dialog v-model="detailVisible" title="虚拟机信息" width="80vw" class="vm-detail-dialog" top="4vh" :close-on-click-modal="false" destroy-on-close>
        <HostVmPanel
          v-model:search="search"
          v-model:power-filter="powerFilter"
          :connection="{ id: activeScenario.id, providerType: activeScenario.providerType, host: activeScenario.host.address, port: 443, username: 'administrator' }"
          :host="activeScenario.host"
          :network-count="5"
          :resource-summary="resourceSummary"
          :host-memory-percent="63"
          :storage-totals="{ usedGiB: 11900, physicalGiB: 15770, virtualGiB: 18420, usagePercent: 75 }"
          :vm-totals="vmTotals"
          :has-vm-summary="true"
          :loading-vm-summary="false"
          :vms="filteredVms"
          :vms-total="activeScenario.vms.length"
          :selected-vm-ids="selectedVmIds"
          :vm-action-states="{}"
          :loading-vms="false"
          :allow-vm-rename="true"
          variant="dialog"
          table-height="100%"
          metric-grid-class="dialog-metric-grid"
          table-panel-class="dialog-table-panel"
          @rename-vm="openRename"
          @open-console="notifyPrototype('控制台')"
          @create-vm="notifyPrototype('创建虚拟机')"
          @export="notifyPrototype('导出')"
          @refresh="notifyPrototype('刷新列表')"
          @selection-change="handleVmSelectionChange"
          @vm-action="notifyPrototype('虚拟机操作')"
          @batch-vm-action="notifyPrototype('批量操作')"
          @schedule-vms="notifyPrototype('定时任务')"
        />
      </el-dialog>

      <VmRenameDialog
        v-model="renameVisible"
        :vm="renameTarget"
        :provider-type="activeScenario.providerType"
        :existing-names="activeScenario.vms.filter((item) => item.providerId !== renameTarget?.providerId).map((item) => item.name)"
        :saving="saving"
        @submit="submitRename"
      />
    </section>
  </main>
</template>

<style scoped>
.vm-rename-prototype .overview-panel {
  gap: 12px;
}

.vm-rename-prototype .overview-header {
  flex: 0 0 auto;
}
</style>
