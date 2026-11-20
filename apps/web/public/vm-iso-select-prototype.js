// VRC 创建虚拟机 · 系统镜像选择器原型脚本
// 数据形状对齐 apps/web/src/types.ts 的 IsoImage 与 domain/provisioningStrategies.ts 的分组规则。

const ICONS = {
  chevron: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>',
  check: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.4 6.4 4.8 8.8 9.6 3.6"/></svg>',
  search: '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="6.2" cy="6.2" r="3.9"/><path d="M9.2 9.2 12 12"/></svg>',
  refresh: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M11.6 6.1a4.7 4.7 0 1 0-.5 2.9"/><path d="M11.8 2.4v3.8H8"/></svg>',
  disc: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.5"/></svg>',
  close: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
};

const GROUP_ORDER = ["共享 ISO 库", "本地 ISO 库", "本机 DVD", "工具盘"];

const ISO_IMAGES = [
  { id: "isox-centos7-dvd", name: "CentOS-7-x86_64-DVD-1511.iso", source: "共享 ISO 库", repository: "ISO-SR-NFS", size: "4.26 GiB", family: "centos" },
  { id: "isox-centos8-dvd", name: "CentOS-8.5.2111-x86_64-dvd1.iso", source: "共享 ISO 库", repository: "ISO-SR-NFS", size: "8.03 GiB", family: "centos" },
  { id: "isox-rocky9", name: "Rocky-9.3-x86_64-dvd.iso", source: "共享 ISO 库", repository: "ISO-SR-NFS", size: "6.14 GiB", family: "centos" },
  { id: "isox-ubuntu-desktop", name: "ubuntu-22.04.3-desktop-amd64.iso", source: "共享 ISO 库", repository: "ISO-SR-NFS", size: "4.71 GiB", family: "ubuntu" },
  { id: "isox-ubuntu-server", name: "ubuntu-22.04.3-live-server-amd64.iso", source: "本地 ISO 库", repository: "Local-SR-01", size: "1.86 GiB", family: "ubuntu" },
  { id: "isox-win2012", name: "windows_server_2012_r2_x64_dvd_2707961.iso", source: "本地 ISO 库", repository: "Local-SR-01", size: "5.02 GiB", family: "windows" },
  { id: "isox-win2008", name: "windows_server_2008_r2_x64_dvd.iso", source: "本地 ISO 库", repository: "Local-SR-01", size: "3.09 GiB", family: "windows" },
  { id: "isox-kylin", name: "Kylin-Server-10-SP3-x86_64.iso", source: "共享 ISO 库", repository: "ISO-SR-NFS", size: "4.42 GiB", family: "kylin" },
  { id: "isox-dvd", name: "CentOS-7-x86_64-DVD-1511.iso", source: "本机 DVD", repository: "物理光驱 · hl-xx", size: "4.26 GiB", family: "dvd" },
  { id: "isox-dvd-live", name: "ubuntu-20.04-desktop-amd64.iso", source: "本机 DVD", repository: "物理光驱 · hl-yy", size: "2.41 GiB", family: "dvd" },
  { id: "isox-tools", name: "xs-tools.iso", source: "工具盘", repository: "XenTools", size: "18.4 MiB", family: "tools" },
];

const FAMILY_BADGE = {
  centos: "CE",
  ubuntu: "UB",
  windows: "WIN",
  kylin: "KY",
  dvd: "DVD",
  tools: "TL",
};

const state = {
  scenario: "data",
  selectedId: "isox-centos7-dvd",
  openVariant: "",
  query: "",
  activeIndex: -1,
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function imagesForScenario() {
  if (state.scenario === "empty") return [];
  return ISO_IMAGES;
}

function visibleImages() {
  const images = imagesForScenario();
  const query = state.query.trim().toLowerCase();
  if (!query) return images;
  return images.filter((image) => `${image.name} ${image.source} ${image.repository}`.toLowerCase().includes(query));
}

function groupImages(images) {
  const groups = new Map();
  for (const image of images) {
    const options = groups.get(image.source) ?? [];
    options.push(image);
    groups.set(image.source, options);
  }
  return GROUP_ORDER.filter((label) => groups.has(label)).map((label) => ({ label, options: groups.get(label) }));
}

function selectedImage() {
  return ISO_IMAGES.find((image) => image.id === state.selectedId) ?? null;
}

function highlight(text, query) {
  const safe = escapeHtml(text);
  const needle = query.trim();
  if (!needle) return safe;
  return safe.replace(new RegExp(`(${escapeRegExp(escapeHtml(needle))})`, "gi"), '<mark class="isox-mark">$1</mark>');
}

function triggerMarkup(variant) {
  const image = selectedImage();
  const meta = variant === "a" ? (image ? image.size : "") : "";
  return `
    <button type="button" class="isox-trigger" aria-haspopup="listbox">
      <span class="isox-trigger-icon">${ICONS.disc}</span>
      <span class="isox-trigger-text${image ? "" : " is-placeholder"}">${image ? escapeHtml(image.name) : "选择 ISO"}</span>
      ${meta ? `<span class="isox-trigger-meta">${escapeHtml(meta)}</span>` : ""}
      <span class="isox-trigger-arrow">${ICONS.chevron}</span>
    </button>`;
}

function panelMarkup(variant) {
  const query = state.query;
  const scenario = state.scenario;

  let body = "";
  let footer = "";

  if (scenario === "loading") {
    body = `<div class="isox-skeleton" role="status" aria-label="正在读取镜像资源"><i></i><i></i><i></i></div>`;
    footer = `<span>正在读取宿主机镜像</span><b>--</b>`;
  } else if (scenario === "empty") {
    body = `
      <div class="isox-empty">
        <strong>当前平台未读到 ISO</strong>
        <span>ISO 库可能尚未挂载到宿主机，挂载后点击刷新重新读取。</span>
        <button type="button" data-action="refresh">重新读取</button>
      </div>`;
    footer = `<span>来源：共享 ISO 库 / 本地 ISO 库</span><b>0 个</b>`;
  } else {
    const images = visibleImages();
    const groups = groupImages(images);
    if (!groups.length) {
      body = `
        <div class="isox-empty">
          <strong>没有匹配「${escapeHtml(query)}」的镜像</strong>
          <span>试试文件名关键字，例如 centos、ubuntu、server。</span>
          <button type="button" data-action="clear">清空搜索</button>
        </div>`;
    } else {
      let index = 0;
      body = groups
        .map((group) => {
          const options = group.options
            .map((image) => {
              const optionIndex = index;
              index += 1;
              return optionMarkup(variant, image, optionIndex);
            })
            .join("");
          return `<div class="isox-group" role="presentation"><span class="isox-group-label">${escapeHtml(group.label)}</span><span class="isox-group-count">${group.options.length}</span></div>${options}`;
        })
        .join("");
    }
    footer = `<span>共 <b>${imagesForScenario().length}</b> 个系统 ISO · 含本机 DVD 与工具盘</span><b>${images.length} 条匹配</b>`;
  }

  return `
    <div class="isox-panel" role="dialog" aria-label="选择系统镜像">
      <div class="isox-panel-tools">
        <label class="isox-search">
          <span class="isox-search-icon" aria-hidden="true">${ICONS.search}</span>
          <input type="text" data-iso-search placeholder="搜索 ISO 名称、存储库" value="${escapeHtml(query)}" autocomplete="off">
        </label>
        <button type="button" class="isox-tool-button" data-action="refresh" aria-label="刷新系统镜像" title="重新读取宿主机镜像"
          ${scenario === "loading" ? "disabled data-spinning" : ""}>${ICONS.refresh}</button>
      </div>
      <div class="isox-panel-head" aria-hidden="true"><span>镜像</span><span>来源</span><span>大小</span><span></span></div>
      <div class="isox-panel-list" role="listbox">${body}</div>
      <div class="isox-panel-foot">${footer}</div>
    </div>`;
}

function optionMarkup(variant, image, index) {
  const selected = image.id === state.selectedId;
  const active = index === state.activeIndex;
  const classes = ["isox-option", selected ? "is-selected" : "", active ? "is-active" : ""].filter(Boolean).join(" ");
  const title = `<span class="isox-option-title"><strong title="${escapeHtml(image.name)}">${highlight(image.name, state.query)}</strong></span>`;
  const check = `<span class="isox-option-check">${ICONS.check}</span>`;
  const common = `class="${classes}" type="button" role="option" data-id="${image.id}" data-index="${index}" aria-selected="${selected}"`;

  if (variant === "b") {
    return `
      <button ${common}>
        <span class="isox-badge" data-family="${image.family}">${FAMILY_BADGE[image.family] ?? "ISO"}</span>
        <span class="isox-option-body">
          ${title}
          <span class="isox-option-sub"><span class="isox-dot aria-hidden"${image.source === "共享 ISO 库" ? " shared" : image.source === "本机 DVD" ? " dvd" : ""}"></span> ${escapeHtml(image.repository)} · ${escapeHtml(image.size)}</span>
        </span>
        <span class="isox-option-side">${check}</span>
      </button>`;
  }

  if (variant === "c") {
    return `
      <button ${common}>
        ${title}
        <span class="isox-source"><span class="isox-dot aria-hidden"${image.source === "共享 ISO 库" ? " shared" : image.source === "本机 DVD" ? " dvd" : ""}"></span>${escapeHtml(image.source)}</span>
        <span class="isox-option-size">${escapeHtml(image.size)}</span>
        ${check}
      </button>`;
  }

  return `
    <button ${common}>
      ${title}
      <span class="isox-option-sub">${escapeHtml(image.source)} · ${escapeHtml(image.repository)}</span>
      <span class="isox-option-side"><span>${escapeHtml(image.size)}</span>${check}</span>
    </button>`;
}

function renderSelect(root) {
  if (!root) return;
  const variant = root.dataset.variant;
  const open = state.openVariant === variant;
  root.classList.toggle("is-open", open);
  root.innerHTML = triggerMarkup(variant) + (open ? panelMarkup(variant) : "");
  if (open) {
    const search = root.querySelector("[data-iso-search]");
    if (search) {
      search.focus({ preventScroll: true });
      const end = search.value.length;
      search.setSelectionRange(end, end);
    }
    const active = root.querySelector(".isox-option.is-active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }
}

function renderAll() {
  document.querySelectorAll("[data-iso-select]").forEach(renderSelect);
}

function openSelect(variant) {
  state.openVariant = variant;
  state.activeIndex = -1;
  renderAll();
}

function closeSelect() {
  state.openVariant = "";
  state.activeIndex = -1;
  state.query = "";
  renderAll();
}

function flatOptions() {
  return Array.from(document.querySelectorAll(`[data-iso-select][data-variant="${state.openVariant}"] .isox-option`));
}

function moveActive(step) {
  const options = flatOptions();
  if (!options.length) return;
  state.activeIndex = step > 0 ? (state.activeIndex + 1) % options.length : (state.activeIndex - 1 + options.length) % options.length;
  renderAll();
}

function choose(id) {
  state.selectedId = id;
  closeSelect();
}

document.addEventListener("click", (event) => {
  const select = event.target.closest("[data-iso-select]");
  if (!select) {
    if (state.openVariant) closeSelect();
    return;
  }
  const variant = select.dataset.variant;

  const trigger = event.target.closest(".isox-trigger");
  if (trigger) {
    if (state.openVariant === variant) closeSelect();
    else openSelect(variant);
    return;
  }

  const action = event.target.closest("[data-action]");
  if (action) {
    event.preventDefault();
    if (action.dataset.action === "refresh") {
      state.scenario = "loading";
      setScenarioButtons();
      renderAll();
      window.setTimeout(() => {
        state.scenario = "data";
        setScenarioButtons();
        renderAll();
      }, 900);
    }
    if (action.dataset.action === "clear") {
      state.query = "";
      state.activeIndex = -1;
      renderAll();
    }
    return;
  }

  const option = event.target.closest(".isox-option");
  if (option) {
    choose(option.dataset.id);
  }
});

document.addEventListener("input", (event) => {
  if (!event.target.matches("[data-iso-search]")) return;
  state.query = event.target.value;
  state.activeIndex = -1;
  renderAll();
});

document.addEventListener("keydown", (event) => {
  if (!state.openVariant) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeSelect();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveActive(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveActive(-1);
    return;
  }
  if (event.key === "Enter") {
    const options = flatOptions();
    const target = options[state.activeIndex] ?? options[0];
    if (target) {
      event.preventDefault();
      choose(target.dataset.id);
    }
  }
});

function setScenarioButtons() {
  document.querySelectorAll('[data-iso-scenario="data"] button').forEach((button) => {
    button.classList.toggle("active", button.dataset.value === state.scenario);
  });
}

document.querySelectorAll('[data-iso-scenario="data"]').forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    state.scenario = button.dataset.value;
    state.query = "";
    state.activeIndex = -1;
    setScenarioButtons();
    renderAll();
  });
});

document.querySelectorAll('[data-iso-scenario="theme"]').forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    document.documentElement.dataset.theme = button.dataset.value;
  });
});

setScenarioButtons();
renderAll();
