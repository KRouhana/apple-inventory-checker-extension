import type { ExtensionApi } from "../platform/api.js";
import { openLocalMonitorTab } from "./popup-monitor.js";
/** New installs open setup; updates and browser restarts preserve the user's tabs. */
export function installFirstRunSetup(api: ExtensionApi): void {
  api.runtime.onInstalled?.addListener((details) => {
    if (details.reason === "install") openLocalMonitorTab(api);
  });
}
