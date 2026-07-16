import "element-plus/dist/index.css";
import "./styles.css";

import ElementPlus from "element-plus";
import { createApp } from "vue";
import VmRenamePrototype from "./prototypes/VmRenamePrototype.vue";

document.documentElement.dataset.theme = "graphite-sage";

createApp(VmRenamePrototype).use(ElementPlus).mount("#app");
