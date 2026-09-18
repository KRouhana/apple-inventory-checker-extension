import { describe, expect, it, vi } from "vitest";

import type {
  ExtensionMessageSender,
  ExtensionRuntime,
} from "../src/platform/api.js";
import {
  DESKTOP_DIAGNOSTIC_PROTOCOL,
  installDesktopDiagnosticMessageHandler,
} from "../src/platform/desktop-diagnostic-messages.js";

function harness() {
  let listener:
    | ((
        message: unknown,
        sender: ExtensionMessageSender,
        reply: (value: unknown) => void,
      ) => boolean | void)
    | undefined;
  const runtime: ExtensionRuntime = {
    id: "test-extension",
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    onMessage: {
      addListener: (value) => {
        listener = value;
      },
    },
    sendMessage: () => undefined,
  };
  const controller = {
    sendUserInitiatedTest: vi.fn(async () => ({ kind: "scheduled" as const })),
  };
  installDesktopDiagnosticMessageHandler(runtime, controller);
  const send = (message: unknown, sender: ExtensionMessageSender) =>
    new Promise<unknown>((resolve) => {
      listener?.(message, sender, resolve);
    });
  const app: ExtensionMessageSender = {
    id: "test-extension",
    url: "chrome-extension://test-extension/app.html",
    frameId: 0,
    tab: { id: 1, url: "chrome-extension://test-extension/app.html" },
  };
  return { controller, send, app };
}

describe("desktop diagnostic app protocol", () => {
  it("accepts only the exact app-only fixed command", async () => {
    const test = harness();
    await expect(
      test.send(
        { protocol: DESKTOP_DIAGNOSTIC_PROTOCOL, type: "SEND_TEST" },
        test.app,
      ),
    ).resolves.toMatchObject({ ok: true, result: "scheduled" });
    await expect(
      test.send(
        {
          protocol: DESKTOP_DIAGNOSTIC_PROTOCOL,
          type: "SEND_TEST",
          title: "poison",
        },
        test.app,
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid_request" });
    await expect(
      test.send(
        { protocol: DESKTOP_DIAGNOSTIC_PROTOCOL, type: "SEND_TEST" },
        { id: "test-extension", url: "https://www.apple.com/" },
      ),
    ).resolves.toMatchObject({ ok: false, error: "unauthorized" });
    expect(test.controller.sendUserInitiatedTest).toHaveBeenCalledTimes(1);
  });
});
