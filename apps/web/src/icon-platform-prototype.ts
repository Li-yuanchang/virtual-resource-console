import "element-plus/dist/index.css";
import "./styles.css";

import ElementPlus from "element-plus";
import { createApp } from "vue";
import IconPlatformPrototype from "./prototypes/IconPlatformPrototype.vue";

document.documentElement.dataset.theme = "graphite-sage";

createApp(IconPlatformPrototype).use(ElementPlus).mount("#app");
