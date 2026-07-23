import { h } from "vue";
import { ElMessageBox } from "element-plus";

export interface VrcConfirmActionOptions {
  heading: string;
  tone: string;
  summary?: string;
  detail?: string;
  confirmButtonText: string;
  cancelButtonText?: string;
  customClass?: string;
}

/**
 * Opens the shared destructive-action confirmation surface.
 *
 * All callers provide the affected object, action and impact explicitly so
 * destructive workflows retain the same visual and behavioral contract.
 */
export function confirmVrcAction(options: VrcConfirmActionOptions) {
  return ElMessageBox.confirm(renderVrcConfirmAction(options), "", {
    confirmButtonText: options.confirmButtonText,
    cancelButtonText: options.cancelButtonText ?? "取消",
    customClass: normalizeVrcConfirmClass(options.customClass),
    distinguishCancelAndClose: true,
    closeOnClickModal: false,
    showClose: false,
  });
}

function normalizeVrcConfirmClass(customClass?: string) {
  const classes = (customClass ?? "").split(/\s+/).filter(Boolean);
  if (!classes.includes("vrc-confirm-message-box")) {
    classes.unshift("vrc-confirm-message-box");
  }
  return classes.join(" ");
}

function renderVrcConfirmAction(options: VrcConfirmActionOptions) {
  return h("section", { class: "vrc-confirm-card" }, [
    h("div", { class: "vrc-confirm-head" }, [h("strong", options.heading), h("span", options.tone)]),
    options.summary ? h("p", { class: "vrc-confirm-summary" }, options.summary) : null,
    options.detail ? h("p", { class: "vrc-confirm-detail" }, options.detail) : null,
  ]);
}
