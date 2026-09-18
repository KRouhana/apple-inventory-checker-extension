import { describe, expect, it, vi } from "vitest";
import type { ExtensionApi } from "../src/platform/api.js";
import { installFirstRunSetup } from "../src/ui/first-run.js";
describe("first installation", () => {
  it("opens settings only for a new install, not reloads or upgrades", () => {
    let installed!: (details: { reason: string }) => void;
    const create = vi.fn();
    const api = {
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        onInstalled: {
          addListener: (listener: typeof installed) => {
            installed = listener;
          },
        },
      },
      tabs: { create },
    } as unknown as ExtensionApi;
    installFirstRunSetup(api);
    installed({ reason: "update" });
    installed({ reason: "chrome_update" });
    expect(create).not.toHaveBeenCalled();
    installed({ reason: "install" });
    expect(create).toHaveBeenCalledExactlyOnceWith({
      url: "chrome-extension://test/app.html",
    });
  });
});
