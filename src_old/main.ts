import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";
import router from "./router";
import { registerSW } from "virtual:pwa-register";

createApp(App).use(router).mount("#app");

// Auto-update when user opens the app (no “refresh” prompt)
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    updateSW(true); // fetch + activate new SW
    // reload soon so new assets take effect
    // setTimeout(() => window.location.reload(), 250);
  }
});


