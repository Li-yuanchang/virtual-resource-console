import "element-plus/dist/index.css";
import "./styles.css";

import ElementPlus from "element-plus";
import { createApp } from "vue";
import VmSchedulePrototype from "./prototypes/VmSchedulePrototype.vue";

document.documentElement.dataset.theme = "mist-teal";

createApp(VmSchedulePrototype).use(ElementPlus).mount("#app");
