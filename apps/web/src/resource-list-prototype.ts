import "element-plus/dist/index.css";
import "./styles.css";

import ElementPlus from "element-plus";
import { createApp } from "vue";
import ResourceListPrototype from "./prototypes/ResourceListPrototype.vue";

document.documentElement.dataset.theme = "graphite-sage";

createApp(ResourceListPrototype).use(ElementPlus).mount("#app");
