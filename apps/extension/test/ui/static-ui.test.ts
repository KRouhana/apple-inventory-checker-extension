import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("packaged local UI shell", () => {
  it("has keyboard labels and no localhost or remote UI dependency", async () => {
    const [html, view, popup, app] = await Promise.all([
      readFile(resolve(root, "static/app.html"), "utf8"),
      readFile(resolve(root, "src/ui/view.ts"), "utf8"),
      readFile(resolve(root, "src/popup.ts"), "utf8"),
      readFile(resolve(root, "src/app.ts"), "utf8"),
    ]);
    expect(html).toContain("data-monitor-root");
    expect(view).toContain('aria-label="Region"');
    expect(view).toContain('aria-live="polite"');
    const viewOrigins = view.match(/https?:\/\/[^"`\s]+/gi) ?? [];
    expect(viewOrigins).toEqual([
      "https://t.me",
      "https://krouhana.github.io/apple-inventory-checker-extension/privacy.html",
    ]);
    expect(view).not.toMatch(/localhost/i);
    expect(popup).not.toContain("inventorySignal.localMonitor.v1");
    expect(popup).toContain("initializePopupMonitor");
    expect(app).toContain("createRuntimeMonitorController");
    expect(app).toContain("createRuntimePersonalTelegramController");
    expect(app).not.toMatch(/fetch\(|storage\.local|localhost/i);
    expect(view).toContain('type="password"');
    expect(view).toContain("requestTelegramHostPermission");
    expect(view).toContain("token never enters UiState");
    expect(view).toContain("telegramConnected");
    expect(view).toContain('data-action="desktop-test"');
    expect(view).toContain("does not report stock");
  });
});
