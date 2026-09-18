import type { ExtensionRuntime, ExtensionTabs } from "../platform/api.js";

type ExtensionTabOpener = {
  runtime: Pick<ExtensionRuntime, "getURL">;
  tabs: Pick<ExtensionTabs, "create">;
};

/**
 * Keep the popup's monitor entry bounded to an extension-owned page. A
 * sender-validated background summary can be added later without granting the
 * popup raw monitor-storage access.
 */
export function openLocalMonitorTab(api: ExtensionTabOpener): void {
  api.tabs.create({ url: api.runtime.getURL("app.html") });
}
