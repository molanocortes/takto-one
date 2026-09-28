import { initTheme } from "./theme.js";
import { mountOperator } from "./views/operator.js";
import "./store.js";
import { mountSimBanner } from "./sim_badge.js";

initTheme();
mountSimBanner();   // SIMULATED DATA whenever the in-browser mock is the source

const app = document.getElementById("app");
let cleanup = mountOperator(app);

window.addEventListener("beforeunload", () => {
  if (cleanup) cleanup();
  cleanup = null;
});
