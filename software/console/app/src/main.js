import { initTheme } from "./theme.js";
import { mountOperator } from "./views/operator.js";
import "./store.js";

initTheme();

const app = document.getElementById("app");
let cleanup = mountOperator(app);

window.addEventListener("beforeunload", () => {
  if (cleanup) cleanup();
  cleanup = null;
});
