import { getExtensionApi } from "./platform/api";
import { openLocalMonitorTab } from "./ui/popup-monitor.js";
import { mountPopupMonitorSummary } from "./ui/popup-summary.js";
const api = getExtensionApi();
const openSettings = () => {
  openLocalMonitorTab(api);
  window.close();
};
document
  .querySelector("[data-open-settings]")
  ?.addEventListener("click", openSettings);
void mountPopupMonitorSummary(document, api.runtime, { openSettings });
