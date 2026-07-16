import "element-plus/dist/index.css";
import "./styles.css";

import ElementPlus from "element-plus";
import { createApp } from "vue";
import App from "./App.vue";

const savedTheme = localStorage.getItem("vrc.theme") || "graphite-sage";
document.documentElement.dataset.theme = ["graphite-sage", "basalt-copper", "mist-teal"].includes(savedTheme) ? savedTheme : "graphite-sage";
delete document.documentElement.dataset.appReady;

createApp(App).use(ElementPlus).mount("#app");
