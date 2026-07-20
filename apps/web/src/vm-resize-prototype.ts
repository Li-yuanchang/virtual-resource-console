import "element-plus/dist/index.css";
import "./styles.css";

import ElementPlus from "element-plus";
import { createApp } from "vue";
import VmResizeGuestPrototype from "./prototypes/VmResizeGuestPrototype.vue";

document.documentElement.dataset.theme = "graphite-sage";

createApp(VmResizeGuestPrototype).use(ElementPlus).mount("#app");
