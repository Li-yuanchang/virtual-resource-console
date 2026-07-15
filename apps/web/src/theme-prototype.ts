import "element-plus/dist/index.css";
import "./styles.css";

import ElementPlus from "element-plus";
import { createApp } from "vue";
import ThemeAppearancePrototype from "./prototypes/ThemeAppearancePrototype.vue";

document.documentElement.dataset.theme = "graphite-sage";

createApp(ThemeAppearancePrototype).use(ElementPlus).mount("#app");
