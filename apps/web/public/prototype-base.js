document.querySelectorAll("[data-segmented]").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    group.querySelectorAll("button[data-value]").forEach((item) => item.classList.toggle("active", item === button));
    const targetName = group.dataset.target;
    if (!targetName) return;
    document.querySelectorAll(`[data-panel-group="${targetName}"]`).forEach((panel) => {
      panel.hidden = panel.dataset.panel !== button.dataset.value;
    });
  });
});

document.querySelectorAll("[data-toggle-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.querySelector(button.dataset.toggleTarget);
    if (target) target.hidden = !target.hidden;
  });
});
