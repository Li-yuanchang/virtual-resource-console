import "element-plus/dist/index.css";
import "./styles.css";

import ElementPlus from "element-plus";
import { createApp } from "vue";
import ClientUpdatePrototype from "./prototypes/ClientUpdatePrototype.vue";

document.documentElement.dataset.theme = "graphite-sage";

createApp(ClientUpdatePrototype).use(ElementPlus).mount("#app");
