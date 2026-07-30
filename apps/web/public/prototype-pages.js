(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function toast(message) {
    let node = $("#prototype-toast");
    if (!node) {
      node = document.createElement("div");
      node.id = "prototype-toast";
      node.className = "toast-static";
      node.setAttribute("role", "status");
      document.body.append(node);
    }
    node.textContent = message;
    node.classList.add("visible");
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => node.classList.remove("visible"), 1700);
  }

  function bindSegmented(root, onChange) {
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button || button.disabled) return;
      $$('button[data-value]', root).forEach((item) => item.classList.toggle("active", item === button));
      onChange(button.dataset.value, button);
    });
  }

  function setSortButtonState(root, key, order) {
    $$(".sort-button", root).forEach((button) => {
      button.dataset.order = button.dataset.sort === key ? order : "";
    });
  }

  function nextSort(sort, key) {
    if (sort.key !== key) return { key, order: "asc" };
    return { key, order: sort.order === "asc" ? "desc" : "asc" };
  }

  function sortedRows(rows, sort) {
    return [...rows].sort((left, right) => {
      const a = left[sort.key];
      const b = right[sort.key];
      const value = typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a ?? "").localeCompare(String(b ?? ""), "zh-CN", { numeric: true });
      return sort.order === "asc" ? value : -value;
    });
  }

  function bindStaticActions(root = document) {
    $$('[data-toast]', root).forEach((button) => {
      button.addEventListener("click", () => toast(button.dataset.toast));
    });
  }

  function initResourceList() {
    const hostRows = [
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
    const vmRows = [
      { id: "vm1", name: "prod-api-01", host: "xenserver-01", state: "running", system: "Rocky Linux 9.4", vcpu: 8, memory: 16, disk: 320, diskCount: 2, ip: "10.20.1.21" },
      { id: "vm2", name: "prod-api-02", host: "xenserver-01", state: "running", system: "Rocky Linux 9.4", vcpu: 8, memory: 16, disk: 320, diskCount: 2, ip: "10.20.1.22" },
      { id: "vm3", name: "prod-db-primary", host: "esxi-prod-01", state: "running", system: "Windows Server 2022", vcpu: 16, memory: 64, disk: 2048, diskCount: 4, ip: "10.20.2.11" },
      { id: "vm4", name: "prod-db-standby", host: "esxi-prod-02", state: "stopped", system: "Windows Server 2022", vcpu: 16, memory: 64, disk: 2048, diskCount: 4, ip: "10.20.2.12" },
      { id: "vm5", name: "redis-cluster-01", host: "pve-node-01", state: "running", system: "Ubuntu 24.04 LTS", vcpu: 4, memory: 12, disk: 120, diskCount: 1, ip: "10.20.3.31" },
      { id: "vm6", name: "redis-cluster-02", host: "pve-node-02", state: "running", system: "Ubuntu 24.04 LTS", vcpu: 4, memory: 12, disk: 120, diskCount: 1, ip: "10.20.3.32" },
      { id: "vm7", name: "jenkins-runner", host: "pve-lab-01", state: "suspended", system: "Debian 12", vcpu: 6, memory: 8, disk: 180, diskCount: 2, ip: "10.20.4.18" },
      { id: "vm8", name: "test-windows-01", host: "esxi-dev-01", state: "stopped", system: "Windows 11 Enterprise", vcpu: 4, memory: 8, disk: 256, diskCount: 1, ip: "10.20.4.51" },
      { id: "vm9", name: "monitoring-main", host: "xenserver-02", state: "running", system: "Ubuntu 22.04 LTS", vcpu: 8, memory: 24, disk: 640, diskCount: 3, ip: "10.20.5.10" },
      { id: "vm10", name: "archive-service", host: "xenserver-02", state: "stopped", system: "CentOS 7", vcpu: 2, memory: 4, disk: 4096, diskCount: 5, ip: "10.20.5.60" },
      { id: "vm11", name: "k8s-control-01", host: "pve-node-01", state: "running", system: "Rocky Linux 9.3", vcpu: 8, memory: 16, disk: 240, diskCount: 2, ip: "10.20.6.11" },
      { id: "vm12", name: "k8s-worker-01", host: "pve-node-02", state: "running", system: "Rocky Linux 9.3", vcpu: 12, memory: 32, disk: 480, diskCount: 2, ip: "10.20.6.21" },
    ];
    const state = {
      active: "hosts",
      hostSort: { key: "name", order: "asc" },
      vmSort: { key: "name", order: "asc" },
      vmPower: "all",
      selected: new Set(),
    };
    const hostBody = $("#host-table-body");
    const vmBody = $("#vm-table-body");
    const hosts = () => {
      const keyword = $("#host-search").value.trim().toLowerCase();
      const platform = $("#host-platform").value;
      const hostState = $("#host-state").value;
      return sortedRows(hostRows.filter((row) => {
        const text = `${row.name} ${row.address} ${row.platform}`.toLowerCase();
        return (!keyword || text.includes(keyword)) && (platform === "all" || row.platform === platform) && (hostState === "all" || row.state === hostState);
      }), state.hostSort);
    };
    const vms = () => {
      const keyword = $("#vm-search").value.trim().toLowerCase();
      const host = $("#vm-host").value;
      return sortedRows(vmRows.filter((row) => {
        const text = `${row.name} ${row.ip} ${row.system}`.toLowerCase();
        const powerMatched = state.vmPower === "all" || (state.vmPower === "running" ? row.state === "running" : row.state === "stopped");
        return (!keyword || text.includes(keyword)) && (host === "all" || row.host === host) && powerMatched;
      }), state.vmSort);
    };
    const hostStateLabel = (value) => value === "online" ? "正常" : value === "warning" ? "预警" : "离线";
    const vmStateLabel = (value) => value === "running" ? "运行中" : value === "stopped" ? "已关机" : "已暂停";
    function meter(value, warning) {
      return `<span class="row-meter-static ${warning ? "warning" : ""}"><i style="width:${value}%"></i></span>`;
    }
    function renderHosts() {
      const rows = hosts();
      $("#host-count").textContent = `${rows.length} / ${hostRows.length} 台`;
      hostBody.innerHTML = rows.length ? rows.map((row, index) => {
        const memoryUsage = Math.round(((row.memoryTotal - row.memoryFree) / row.memoryTotal) * 100);
        const storageUsage = Math.round(((row.storageTotal - row.storageFree) / row.storageTotal) * 100);
        return `<tr><td class="center">${index + 1}</td><td><span class="primary-cell-static"><button class="table-link-static" data-toast="打开 ${escapeHtml(row.name)}">${escapeHtml(row.name)}</button><small class="table-subline">${escapeHtml(row.address)}</small></span></td><td class="center">${escapeHtml(row.platform)}</td><td class="center"><span class="state-text-static state-${row.state}">${hostStateLabel(row.state)}</span></td><td class="right"><span class="meter-cell"><strong>${row.cpuUsage}%</strong>${meter(row.cpuUsage, row.cpuUsage >= 75)}<small>${row.cpuCores} 核</small></span></td><td class="right"><span class="meter-cell"><strong>${row.memoryFree} GiB</strong>${meter(memoryUsage, memoryUsage >= 85)}<small>共 ${row.memoryTotal}</small></span></td><td class="right"><span class="meter-cell"><strong>${row.storageFree.toLocaleString()} GiB</strong>${meter(storageUsage, storageUsage >= 85)}<small>共 ${row.storageTotal.toLocaleString()}</small></span></td><td class="center">${row.runningVms} / ${row.totalVms}</td><td class="center">${row.updatedAt}</td></tr>`;
      }).join("") : '<tr><td class="empty-row" colspan="9">没有符合当前筛选条件的物理机</td></tr>';
      bindStaticActions(hostBody);
      setSortButtonState($("#host-table"), state.hostSort.key, state.hostSort.order);
    }
    function renderVms() {
      const rows = vms();
      $("#vm-count").textContent = `${rows.length} / ${vmRows.length} 台${state.selected.size ? ` · 已选 ${state.selected.size} 台` : ""}`;
      vmBody.innerHTML = rows.length ? rows.map((row, index) => `<tr><td class="center"><input type="checkbox" data-vm-select="${row.id}" aria-label="选择 ${escapeHtml(row.name)}" ${state.selected.has(row.id) ? "checked" : ""}></td><td class="center">${index + 1}</td><td><button class="table-link-static" data-toast="打开 ${escapeHtml(row.name)} 控制台">${escapeHtml(row.name)}</button></td><td>${escapeHtml(row.host)}</td><td class="center"><span class="state-text-static state-${row.state}">${vmStateLabel(row.state)}</span></td><td>${escapeHtml(row.system)}</td><td class="center">${row.vcpu} 核</td><td class="center">${row.memory} GiB</td><td class="center">${row.disk.toLocaleString()} GiB<small class="disk-subline">${row.diskCount} 块</small></td><td class="center">${row.ip}</td><td class="center"><button class="row-action" title="开机" ${row.state === "running" ? "disabled" : ""} data-toast="开机指令已准备">▶</button><button class="row-action" title="关机" ${row.state !== "running" ? "disabled" : ""} data-toast="关机指令已准备">⏻</button><button class="row-action" title="强制重启" ${row.state !== "running" ? "disabled" : ""} data-toast="强制重启指令已准备">↻</button><button class="row-action danger" title="删除" ${row.state === "running" ? "disabled" : ""} data-toast="删除操作仅作原型展示">×</button></td></tr>`).join("") : '<tr><td class="empty-row" colspan="11">没有符合当前筛选条件的虚拟机</td></tr>';
      $("#batch-actions").hidden = !state.selected.size;
      bindStaticActions(vmBody);
      setSortButtonState($("#vm-table"), state.vmSort.key, state.vmSort.order);
    }
    $$("#host-search, #host-platform, #host-state").forEach((control) => control.addEventListener(control.tagName === "INPUT" ? "input" : "change", renderHosts));
    $$("#vm-search, #vm-host").forEach((control) => control.addEventListener(control.tagName === "INPUT" ? "input" : "change", renderVms));
    $("#host-reset").addEventListener("click", () => { $("#host-search").value = ""; $("#host-platform").value = "all"; $("#host-state").value = "all"; state.hostSort = { key: "name", order: "asc" }; renderHosts(); });
    $("#vm-reset").addEventListener("click", () => { $("#vm-search").value = ""; $("#vm-host").value = "all"; state.vmPower = "all"; $$('#vm-power button').forEach((button) => button.classList.toggle("active", button.dataset.value === "all")); state.vmSort = { key: "name", order: "asc" }; renderVms(); });
    bindSegmented($("#resource-tabs"), (value) => {
      state.active = value;
      $("#hosts-panel").hidden = value !== "hosts";
      $("#vms-panel").hidden = value !== "vms";
    });
    bindSegmented($("#sort-style"), (value) => {
      $("#resource-workspace").classList.remove("sort-style-a", "sort-style-b", "sort-style-c");
      $("#resource-workspace").classList.add(`sort-style-${value}`);
    });
    bindSegmented($("#vm-power"), (value) => { state.vmPower = value; renderVms(); });
    $$(".sort-button", $("#host-table")).forEach((button) => button.addEventListener("click", () => { state.hostSort = nextSort(state.hostSort, button.dataset.sort); renderHosts(); }));
    $$(".sort-button", $("#vm-table")).forEach((button) => button.addEventListener("click", () => { state.vmSort = nextSort(state.vmSort, button.dataset.sort); renderVms(); }));
    vmBody.addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-vm-select]");
      if (!checkbox) return;
      checkbox.checked ? state.selected.add(checkbox.dataset.vmSelect) : state.selected.delete(checkbox.dataset.vmSelect);
      renderVms();
    });
    $("#vm-select-all").addEventListener("change", (event) => {
      vms().forEach((row) => event.target.checked ? state.selected.add(row.id) : state.selected.delete(row.id));
      renderVms();
    });
    $("#host-export").addEventListener("click", () => toast(`已准备导出 ${hosts().length} 台物理机`));
    $("#vm-export").addEventListener("click", () => toast(`已准备导出 ${vms().length} 台虚拟机`));
    $("#host-refresh").addEventListener("click", () => toast("物理机列表已刷新"));
    $("#vm-refresh").addEventListener("click", () => toast("虚拟机列表已刷新"));
    renderHosts();
    renderVms();
  }

  function initResize() {
    const current = { cpu: 5, memory: 10, disk: 140 };
    const deltas = { cpu: 0, memory: 0, disk: 60 };
    let diskMode = "extend";
    let mount = "root";
    const mounts = {
      root: { path: "/", name: "根目录", current: 90, fs: "XFS" },
      data: { path: "/home", name: "数据目录", current: 50, fs: "XFS" },
    };
    function number(id) { return Number($(id).value) || 0; }
    function update() {
      deltas.cpu = number("#cpu-delta");
      deltas.memory = number("#memory-delta");
      deltas.disk = number("#disk-delta");
      $("#target-cpu").textContent = current.cpu + deltas.cpu;
      $("#target-memory").textContent = current.memory + deltas.memory;
      $("#target-disk").textContent = current.disk + deltas.disk;
      $("#disk-detail").textContent = diskMode === "extend" ? `磁盘 0 ${current.disk} → ${current.disk + deltas.disk}` : `新增 ${deltas.disk} GiB · 共 2 块`;
      $("#cpu-state").textContent = deltas.cpu ? "需关机" : "不变";
      $("#memory-state").textContent = deltas.memory ? "需关机" : "不变";
      $("#disk-state").textContent = diskMode === "extend" ? "需关机" : "可在线";
      $("#disk-state").className = `execution-state-static ${diskMode === "extend" ? "warning" : "online"}`;
      $("#extend-options").hidden = diskMode !== "extend";
      $("#new-disk-options").hidden = diskMode !== "add";
      $("#impact-mode").textContent = diskMode === "extend" ? "扩容目录" : "挂载目录";
      $("#impact-path").textContent = diskMode === "extend" ? mounts[mount].path : $("#new-mount").value;
      $("#impact-size").textContent = diskMode === "extend" ? `${mounts[mount].current} → ${mounts[mount].current + deltas.disk} GiB` : `${deltas.disk} GiB`;
      $("#impact-storage").textContent = `${(1834 - deltas.disk).toLocaleString()} GiB`;
      $("#change-count").textContent = [deltas.cpu, deltas.memory, deltas.disk].filter(Boolean).length;
      $("#confirm-resize").disabled = !deltas.cpu && !deltas.memory && !deltas.disk;
      $("#resize-summary").textContent = diskMode === "extend" ? "需要短暂停机" : (deltas.cpu || deltas.memory ? "需要短暂停机" : "支持在线执行");
      $("#chain-disk").textContent = diskMode === "extend" ? `${current.disk} → ${current.disk + deltas.disk} GiB` : `新增 ${deltas.disk} GiB`;
      $("#chain-final-label").textContent = diskMode === "extend" ? mounts[mount].path : "自动挂载";
      $("#chain-final-value").textContent = diskMode === "extend" ? `${mounts[mount].current} → ${mounts[mount].current + deltas.disk} GiB` : $("#new-mount").value;
    }
    $$(".stepper-static").forEach((stepper) => {
      stepper.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-step]");
        if (!button) return;
        const input = $("input", stepper);
        input.value = Math.max(0, Number(input.value || 0) + Number(button.dataset.step));
        update();
      });
      $("input", stepper).addEventListener("input", update);
    });
    $("#disk-mode").addEventListener("change", (event) => { diskMode = event.target.value; update(); });
    $("#new-mount").addEventListener("change", update);
    $("#extend-options").addEventListener("click", (event) => {
      const option = event.target.closest("[data-mount]");
      if (!option) return;
      mount = option.dataset.mount;
      $$("[data-mount]", $("#extend-options")).forEach((item) => item.classList.toggle("active", item === option));
      update();
    });
    $("#confirm-resize").addEventListener("click", () => toast("扩容参数校验通过，原型未下发真实任务"));
    $("#cancel-resize").addEventListener("click", () => toast("已取消，本页为静态原型"));
    $("#close-resize").addEventListener("click", () => toast("本页为弹框状态原型"));
    update();
  }

  function initSchedule() {
    const vms = [
      { id: "vm-01", name: "prod-app-01", state: "running", os: "Rocky Linux 9.4", cpu: 8, memory: 16, disk: 160, ip: "192.0.2.81", host: "xenserver-1", pool: "生产资源池 A" },
      { id: "vm-02", name: "prod-app-02", state: "running", os: "Rocky Linux 9.4", cpu: 8, memory: 16, disk: 160, ip: "192.0.2.82", host: "xenserver-1", pool: "生产资源池 A" },
      { id: "vm-03", name: "dev-runner-01", state: "running", os: "Ubuntu Server 24.04", cpu: 12, memory: 24, disk: 240, ip: "192.0.2.96", host: "xenserver-3", pool: "研发资源池" },
      { id: "vm-04", name: "dev-runner-02", state: "halted", os: "Ubuntu Server 24.04", cpu: 12, memory: 24, disk: 240, ip: "192.0.2.97", host: "xenserver-3", pool: "研发资源池" },
      { id: "vm-05", name: "test-db-01", state: "halted", os: "Windows Server 2022", cpu: 8, memory: 32, disk: 500, ip: "192.0.2.110", host: "esxi-17", pool: "VMware 实验集群" },
      { id: "vm-06", name: "ops-monitor-01", state: "running", os: "Debian 12", cpu: 4, memory: 8, disk: 100, ip: "192.0.2.66", host: "pve-20", pool: "Proxmox 运维节点" },
    ];
    let plans = [
      { id: 1, name: "测试环境每日开机", action: "start", cycle: "每天 08:30", count: 4, next: "明天 08:30", enabled: true, result: "今日 08:30 · 4/4 成功" },
      { id: 2, name: "开发环境日晚关机", action: "shutdown", cycle: "周一至周五 22:30", count: 3, next: "今天 22:30", enabled: true, result: "昨天 22:30 · 3/3 成功" },
      { id: 3, name: "月末维护开机", action: "start", cycle: "单次 07-31 20:00", count: 2, next: "07-31 20:00", enabled: false, result: "尚未执行" },
    ];
    const state = { power: "all", selected: new Set(["vm-01", "vm-02", "vm-03"]), targets: new Set(["vm-01", "vm-02", "vm-03"]), targetPower: "all", cycle: "once", action: "shutdown", view: "create", editing: null };
    const vmBody = $("#schedule-vm-body");
    const targetBody = $("#target-table-body");
    const taskBody = $("#task-table-body");
    const visibleVms = () => {
      const keyword = $("#schedule-search").value.trim().toLowerCase();
      return vms.filter((vm) => (!keyword || `${vm.name} ${vm.ip} ${vm.os}`.toLowerCase().includes(keyword)) && (state.power === "all" || (state.power === "running" ? vm.state === "running" : vm.state === "halted")));
    };
    const visibleTargets = () => {
      const keyword = $("#target-search").value.trim().toLowerCase();
      const host = $("#target-host").value;
      return vms.filter((vm) => (!keyword || `${vm.name} ${vm.ip} ${vm.os} ${vm.host}`.toLowerCase().includes(keyword)) && (host === "all" || vm.host === host) && (state.targetPower === "all" || (state.targetPower === "running" ? vm.state === "running" : vm.state === "halted")));
    };
    const stateLabel = (value) => value === "running" ? "运行中" : "已关机";
    function renderVmTable() {
      const rows = visibleVms();
      $("#schedule-vm-count").textContent = `${rows.length} / ${vms.length} · xenserver-1`;
      vmBody.innerHTML = rows.map((vm, index) => `<tr><td class="center"><input type="checkbox" data-select-vm="${vm.id}" ${state.selected.has(vm.id) ? "checked" : ""}></td><td class="center">${index + 1}</td><td><button class="table-link-static" data-toast="打开 ${escapeHtml(vm.name)} 控制台">${escapeHtml(vm.name)}</button></td><td class="center"><span class="state-text-static state-${vm.state === "running" ? "running" : "stopped"}">${stateLabel(vm.state)}</span></td><td>${escapeHtml(vm.os)}</td><td class="center">${vm.cpu} 核</td><td class="center">${vm.memory} GiB</td><td class="center">${vm.disk} GiB<small class="disk-subline">1 块</small></td><td class="center">${vm.ip}</td><td class="center"><button class="row-action" title="开机" ${vm.state === "running" ? "disabled" : ""}>▶</button><button class="row-action" title="关机" ${vm.state === "halted" ? "disabled" : ""}>⏻</button><button class="row-action danger" title="删除" ${vm.state === "running" ? "disabled" : ""}>×</button></td></tr>`).join("");
      const selected = vms.filter((vm) => state.selected.has(vm.id));
      $("#schedule-batch").hidden = !selected.length;
      $("#schedule-selected-count").textContent = `已选 ${selected.length} 台`;
      $("#batch-start").disabled = !selected.some((vm) => vm.state === "halted");
      $("#batch-shutdown").disabled = !selected.some((vm) => vm.state === "running");
      $("#batch-delete").disabled = selected.some((vm) => vm.state === "running");
      bindStaticActions(vmBody);
    }
    function renderTargets() {
      const rows = visibleTargets();
      targetBody.innerHTML = rows.length ? rows.map((vm, index) => `<tr><td class="center"><input type="checkbox" data-select-target="${vm.id}" ${state.targets.has(vm.id) ? "checked" : ""}></td><td class="center">${index + 1}</td><td><span class="target-name-static"><strong>${escapeHtml(vm.name)}</strong><small class="table-subline">${escapeHtml(vm.os)}</small></span></td><td><span class="target-name-static"><span>${escapeHtml(vm.host)}</span><small class="table-subline">${escapeHtml(vm.pool)}</small></span></td><td>${vm.ip}</td><td class="center"><span class="state-text-static state-${vm.state === "running" ? "running" : "stopped"}">${stateLabel(vm.state)}</span></td></tr>`).join("") : '<tr><td class="empty-row" colspan="6">没有符合当前筛选条件的虚拟机</td></tr>';
      const selected = vms.filter((vm) => state.targets.has(vm.id));
      $("#target-count").textContent = `已选 ${selected.length} 台`;
      $("#target-summary").textContent = `${vms.length} 台可选 · 已选 ${selected.filter((vm) => vm.state === "running").length} 台运行中 / ${selected.filter((vm) => vm.state === "halted").length} 台已关机`;
      $("#save-plan").disabled = !selected.length;
      updateFooter();
    }
    function renderTasks() {
      taskBody.innerHTML = plans.length ? plans.map((plan, index) => `<tr><td class="center">${index + 1}</td><td><span class="task-name-static"><strong>${escapeHtml(plan.name)}</strong><small class="table-subline">${escapeHtml(plan.result)}</small></span></td><td class="center"><span class="state-text-static ${plan.action === "start" ? "state-running" : "state-warning"}">${plan.action === "start" ? "▶ 开机" : "⏻ 关机"}</span></td><td>${escapeHtml(plan.cycle)}</td><td class="center">${plan.count} 台</td><td>${escapeHtml(plan.next)}</td><td class="center"><label class="switch-static"><input type="checkbox" data-toggle-plan="${plan.id}" ${plan.enabled ? "checked" : ""}><i></i></label></td><td class="center"><button class="row-action" data-edit-plan="${plan.id}" title="编辑">✎</button><button class="row-action danger" data-delete-plan="${plan.id}" title="删除">×</button></td></tr>`).join("") : '<tr><td class="empty-row" colspan="8">暂无定时任务</td></tr>';
      $("#task-count-label").textContent = `任务管理 ${plans.length}`;
      $("#task-summary").textContent = `${plans.filter((plan) => plan.enabled).length} 个启用 · ${plans.length} 个任务`;
    }
    function summary() {
      if (state.cycle === "once") return $("#once-at").value.replace("T", " ");
      if (state.cycle === "daily") return `每天 ${$("#execute-time").value}`;
      const days = $$('#weekdays input:checked').map((input) => input.value);
      return `${days.join("、")} ${$("#execute-time").value}`;
    }
    function updateFooter() {
      $("#dialog-summary").innerHTML = `<strong>${state.action === "start" ? "开机" : "关机"}</strong> · ${escapeHtml(summary())} · ${state.targets.size} 台 VM`;
    }
    function setDialogView(view) {
      state.view = view;
      $("#create-plan-panel").hidden = view !== "create";
      $("#task-plan-panel").hidden = view !== "tasks";
      $("#save-plan").hidden = view !== "create";
      $("#dialog-summary").textContent = view === "create" ? "" : "任务由服务端按计划执行，关闭页面不受影响";
      $$("#schedule-dialog-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.value === view));
      $("#dialog-cancel").textContent = view === "create" ? "取消" : "关闭";
      if (view === "create") updateFooter();
    }
    function openDialog(useSelected = false) {
      if (useSelected) state.targets = new Set(state.selected);
      $("#schedule-dialog-backdrop").hidden = false;
      setDialogView("create");
      renderTargets();
    }
    function closeDialog() { $("#schedule-dialog-backdrop").hidden = true; }
    $("#schedule-search").addEventListener("input", renderVmTable);
    bindSegmented($("#schedule-power"), (value) => { state.power = value; renderVmTable(); });
    vmBody.addEventListener("change", (event) => {
      const input = event.target.closest("[data-select-vm]");
      if (!input) return;
      input.checked ? state.selected.add(input.dataset.selectVm) : state.selected.delete(input.dataset.selectVm);
      renderVmTable();
    });
    $("#schedule-all-vms").addEventListener("change", (event) => { visibleVms().forEach((vm) => event.target.checked ? state.selected.add(vm.id) : state.selected.delete(vm.id)); renderVmTable(); });
    $("#open-schedule-global").addEventListener("click", () => { state.targets.clear(); openDialog(false); });
    $("#open-schedule-selected").addEventListener("click", () => openDialog(true));
    $$("[data-close-schedule]").forEach((button) => button.addEventListener("click", closeDialog));
    $("#schedule-dialog-backdrop").addEventListener("click", (event) => { if (event.target.id === "schedule-dialog-backdrop") closeDialog(); });
    bindSegmented($("#schedule-action"), (value) => { state.action = value; $("#shutdown-options").hidden = value !== "shutdown"; updateFooter(); });
    bindSegmented($("#schedule-cycle"), (value) => { state.cycle = value; $("#once-field").hidden = value !== "once"; $("#repeat-time-field").hidden = value === "once"; $("#weekdays").hidden = value !== "weekly"; updateFooter(); });
    bindSegmented($("#target-power"), (value) => { state.targetPower = value; renderTargets(); });
    $$("#target-search, #target-host").forEach((control) => control.addEventListener(control.tagName === "INPUT" ? "input" : "change", renderTargets));
    $$("#once-at, #execute-time, #weekdays input").forEach((control) => control.addEventListener("change", updateFooter));
    targetBody.addEventListener("change", (event) => {
      const input = event.target.closest("[data-select-target]");
      if (!input) return;
      input.checked ? state.targets.add(input.dataset.selectTarget) : state.targets.delete(input.dataset.selectTarget);
      renderTargets();
    });
    $("#select-visible-targets").addEventListener("click", () => { visibleTargets().forEach((vm) => state.targets.add(vm.id)); renderTargets(); });
    $("#clear-visible-targets").addEventListener("click", () => { visibleTargets().forEach((vm) => state.targets.delete(vm.id)); renderTargets(); });
    $("#target-select-all").addEventListener("change", (event) => { visibleTargets().forEach((vm) => event.target.checked ? state.targets.add(vm.id) : state.targets.delete(vm.id)); renderTargets(); });
    $("#schedule-dialog-tabs").addEventListener("click", (event) => { const button = event.target.closest("button[data-value]"); if (button) setDialogView(button.dataset.value); });
    $("#new-plan").addEventListener("click", () => { state.editing = null; $("#schedule-name").value = "工作日晚间关机"; setDialogView("create"); renderTargets(); });
    $("#save-plan").addEventListener("click", () => {
      const name = $("#schedule-name").value.trim();
      if (!name) return toast("请输入任务名称");
      if (!state.targets.size) return toast("请选择目标虚拟机");
      const plan = { id: state.editing || Date.now(), name, action: state.action, cycle: summary(), count: state.targets.size, next: state.cycle === "once" ? summary() : `下一次 ${$("#execute-time").value}`, enabled: true, result: "尚未执行" };
      if (state.editing) plans = plans.map((item) => item.id === state.editing ? { ...item, ...plan } : item); else plans.unshift(plan);
      state.editing = null;
      renderTasks();
      setDialogView("tasks");
      toast("定时任务已保存");
    });
    taskBody.addEventListener("click", (event) => {
      const edit = event.target.closest("[data-edit-plan]");
      const remove = event.target.closest("[data-delete-plan]");
      if (edit) {
        const plan = plans.find((item) => item.id === Number(edit.dataset.editPlan));
        if (!plan) return;
        state.editing = plan.id;
        $("#schedule-name").value = plan.name;
        state.action = plan.action;
        $$("#schedule-action button").forEach((button) => button.classList.toggle("active", button.dataset.value === plan.action));
        $("#shutdown-options").hidden = plan.action !== "shutdown";
        setDialogView("create");
        updateFooter();
      }
      if (remove) {
        plans = plans.filter((item) => item.id !== Number(remove.dataset.deletePlan));
        renderTasks();
        toast("定时任务已删除");
      }
    });
    taskBody.addEventListener("change", (event) => {
      const toggle = event.target.closest("[data-toggle-plan]");
      if (!toggle) return;
      const plan = plans.find((item) => item.id === Number(toggle.dataset.togglePlan));
      if (plan) plan.enabled = toggle.checked;
      renderTasks();
    });
    bindStaticActions();
    renderVmTable();
    renderTargets();
    renderTasks();
    updateFooter();
  }

  const page = document.body.dataset.prototype;
  if (page === "resource-list") initResourceList();
  if (page === "vm-resize") initResize();
  if (page === "vm-schedule") initSchedule();
})();
