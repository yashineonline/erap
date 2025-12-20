import { createRouter, createWebHashHistory } from "vue-router";
// import LibraryView from "./views/LibraryView.vue";
import ReaderView from "./views/ReaderView.vue";
import Home from "./views/Home.vue";

export default createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", component: Home },
    // { path: "/", component: LibraryView },
    { path: "/read/:id", component: ReaderView, props: true },
   
  ],
});
