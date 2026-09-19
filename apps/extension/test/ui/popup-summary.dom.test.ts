// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionRuntime } from "../../src/platform/api.js";
import {
  POPUP_MONITOR_SUMMARY_PROTOCOL,
  type PopupMonitorSummary,
  type PopupWatchItem,
} from "../../src/platform/popup-summary-messages.js";
import {
  mountPopupMonitorSummary,
  initializePopupMonitor,
} from "../../src/ui/popup-summary.js";
const at = "2026-09-18T12:00:00.000Z";
function data(): PopupMonitorSummary {
  return {
    watches: [
      {
        id: "watch-one",
        market: "ca",
        title: "iPhone 18 Pro Max 512GB Burgundy",
        enabled: true,
        items: [
          {
            sku: "TEST4VC/A",
            title: "iPhone 18 Pro Max 512GB Burgundy",
            storeNumber: "R123",
            storeName: "Apple Test",
            status: "available",
            lastCheckedAt: at,
          },
        ],
      },
    ],
  };
}
function runtime(summary: unknown, openResult = "opened") {
  const sendMessage = vi.fn(
    (message: unknown, callback?: (response: unknown) => void) => {
      const input = message as { type: string };
      callback?.({
        protocol: POPUP_MONITOR_SUMMARY_PROTOCOL,
        type: "RESULT",
        request: input.type,
        ok: true,
        result: input.type === "GET_SUMMARY" ? summary : openResult,
      });
    },
  );
  const api: ExtensionRuntime = {
    id: "test-extension",
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    onMessage: { addListener: () => undefined },
    sendMessage,
  };
  return { api, sendMessage };
}
async function shell() {
  document.documentElement.innerHTML = await readFile(
    resolve(import.meta.dirname, "../../static/popup.html"),
    "utf8",
  );
  return document;
}
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
describe("watch popup", () => {
  it("refreshes on click, prevents duplicate requests and replaces the displayed status", async () => {
    const doc = await shell();
    const summary = data();
    const fake = runtime(summary);
    let finish!: (response: unknown) => void;
    const initialSend = fake.api.sendMessage;
    fake.api.sendMessage = vi.fn((message, callback) => {
      if ((message as { type: string }).type === "REFRESH") {
        finish = callback!;
        return;
      }
      return initialSend(message, callback);
    });
    await initializePopupMonitor(doc, fake.api);
    expect(vi.mocked(fake.api.sendMessage)).toHaveBeenCalledTimes(1);
    const refresh = doc.querySelector<HTMLButtonElement>("[data-refresh]")!;
    expect(refresh.disabled).toBe(false);
    refresh.click();
    refresh.click();
    expect(refresh.disabled).toBe(true);
    expect(refresh.textContent).toBe("Refreshing…");
    expect(vi.mocked(fake.api.sendMessage)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fake.api.sendMessage).mock.calls[1]![0]).toEqual({
      protocol: POPUP_MONITOR_SUMMARY_PROTOCOL,
      type: "REFRESH",
    });
    summary.watches[0]!.items[0]!.status = "unavailable";
    finish({
      protocol: POPUP_MONITOR_SUMMARY_PROTOCOL,
      type: "RESULT",
      request: "REFRESH",
      ok: true,
      result: { summary, status: "completed" },
    });
    await flush();
    expect(doc.body.textContent).toContain("Out of stock");
    expect(doc.querySelector(".open-apple")).toBeNull();
    expect(refresh.disabled).toBe(false);
    expect(refresh.textContent).toBe("Refresh");
    expect(doc.querySelector("[data-watches]")!.getAttribute("aria-busy")).toBe(
      "false",
    );
  });

  it("shows retry-delay feedback and keeps existing watches after a refresh failure", async () => {
    const doc = await shell();
    const summary = data();
    const fake = runtime(summary);
    const original = fake.api.sendMessage;
    let fail = false;
    fake.api.sendMessage = (message, callback) => {
      if ((message as { type: string }).type !== "REFRESH")
        return original(message, callback);
      callback?.({
        protocol: POPUP_MONITOR_SUMMARY_PROTOCOL,
        type: "RESULT",
        request: "REFRESH",
        ok: !fail,
        ...(fail
          ? { error: "unavailable" }
          : { result: { summary, status: "host_backoff" } }),
      });
    };
    await initializePopupMonitor(doc, fake.api);
    const button = doc.querySelector<HTMLButtonElement>("[data-refresh]")!;
    button.click();
    await flush();
    expect(doc.body.textContent).toContain(
      "Checks are waiting for the next retry",
    );
    fail = true;
    button.click();
    await flush();
    expect(doc.body.textContent).toContain("Refresh could not finish");
    expect(doc.querySelectorAll(".watch-card")).toHaveLength(1);
    expect(button.disabled).toBe(false);
  });

  it("re-enables Refresh after a timeout without discarding the watch list", async () => {
    vi.useFakeTimers();
    try {
      const doc = await shell();
      const fake = runtime(data());
      const original = fake.api.sendMessage;
      fake.api.sendMessage = (message, callback) =>
        (message as { type: string }).type === "REFRESH"
          ? undefined
          : original(message, callback);
      await initializePopupMonitor(doc, fake.api, { timeoutMs: 100 });
      const button = doc.querySelector<HTMLButtonElement>("[data-refresh]")!;
      button.click();
      await vi.advanceTimersByTimeAsync(101);
      expect(button.disabled).toBe(false);
      expect(doc.querySelectorAll(".watch-card")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows watch/store stock and opens Apple only after a click", async () => {
    const doc = await shell();
    const fake = runtime(data());
    const settings = vi.fn();
    await mountPopupMonitorSummary(doc, fake.api, { openSettings: settings });
    expect(doc.body.textContent).toContain("iPhone 18 Pro Max 512GB Burgundy");
    expect(doc.body.textContent).toContain("Apple Test");
    expect(doc.body.textContent).toContain("Available");
    expect(doc.body.textContent).not.toContain("Manual Apple handoff");
    expect(doc.body.textContent).not.toContain("Clear handoff");
    expect(doc.querySelector("[data-open-settings]")?.textContent?.trim()).toBe(
      "Settings",
    );
    expect(settings).not.toHaveBeenCalled();
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
    doc.querySelector<HTMLButtonElement>(".open-apple")!.click();
    await flush();
    expect(fake.sendMessage.mock.calls[1]![0]).toEqual({
      protocol: POPUP_MONITOR_SUMMARY_PROTOCOL,
      type: "OPEN_AVAILABLE",
      watchId: "watch-one",
      sku: "TEST4VC/A",
      storeNumber: "R123",
    });
    expect(doc.querySelector(".open-apple")?.textContent).toBe(
      "Opened at Apple",
    );
  });
  it.each([
    "unavailable",
    "ineligible",
    "unknown",
    "waiting",
    "stale",
    "paused",
    "retired",
  ] as PopupWatchItem["status"][])(
    "does not offer a purchase action for %s",
    async (status) => {
      const doc = await shell();
      const summary = data();
      summary.watches[0]!.items[0]!.status = status;
      await mountPopupMonitorSummary(doc, runtime(summary).api);
      expect(doc.querySelector(".open-apple")).toBeNull();
      if (status === "unknown")
        expect(doc.body.textContent).not.toContain("Out of stock");
    },
  );
  it("routes an empty install to setup without treating errors as first installation", async () => {
    const doc = await shell();
    const settings = vi.fn();
    await mountPopupMonitorSummary(doc, runtime({ watches: [] }).api, {
      openSettings: settings,
    });
    expect(settings).not.toHaveBeenCalled();
    doc.querySelector<HTMLButtonElement>(".setup-watch")!.click();
    expect(settings).toHaveBeenCalledTimes(1);
    await mountPopupMonitorSummary(doc, runtime({ watches: "malformed" }).api, {
      openSettings: settings,
    });
    expect(settings).toHaveBeenCalledTimes(1);
    expect(doc.body.textContent).toContain("Could not load watches");
  });
  it("renders names as text and handles a stale click without opening arbitrary links", async () => {
    const doc = await shell();
    const summary = data();
    summary.watches[0]!.title = "<img src=x onerror=alert(1)>";
    const fake = runtime(summary, "unavailable");
    await mountPopupMonitorSummary(doc, fake.api);
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("h2")?.textContent).toBe(
      summary.watches[0]!.title,
    );
    doc.querySelector<HTMLButtonElement>(".open-apple")!.click();
    await flush();
    expect(doc.body.textContent).toContain("Availability changed");
    expect(doc.querySelector<HTMLButtonElement>(".open-apple")!.disabled).toBe(
      true,
    );
  });
  it("bounds an unresponsive background without opening setup", async () => {
    vi.useFakeTimers();
    try {
      const doc = await shell();
      const fake = runtime(data());
      fake.api.sendMessage = () => undefined;
      const settings = vi.fn();
      const pending = mountPopupMonitorSummary(doc, fake.api, {
        openSettings: settings,
        timeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(101);
      await pending;
      expect(doc.body.textContent).toContain("Could not load watches");
      expect(settings).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
