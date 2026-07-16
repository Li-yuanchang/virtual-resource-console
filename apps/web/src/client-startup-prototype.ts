import "element-plus/dist/index.css";
import "./styles.css";

import ElementPlus from "element-plus";
import { createApp } from "vue";
import ClientStartupPrototype from "./prototypes/ClientStartupPrototype.vue";

document.documentElement.dataset.theme = "graphite-sage";

createApp(ClientStartupPrototype).use(ElementPlus).mount("#app");
