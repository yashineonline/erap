import { createRouter, createWebHashHistory } from "vue-router";
const Home = () => import("./views/Home.vue");
const ReaderView = () => import("./views/ReaderView.vue");



export default createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", component: Home },
    // { path: "/", component: LibraryView },
    { path: "/read/:id", component: ReaderView, props: true },
  ],
});
