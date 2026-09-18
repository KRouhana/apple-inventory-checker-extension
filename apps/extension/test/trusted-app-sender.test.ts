import { describe, expect, it } from "vitest";
import type {
  ExtensionMessageSender,
  ExtensionRuntime,
} from "../src/platform/api.js";
import { isTrustedOwnExtensionAppSender } from "../src/platform/trusted-app-sender.js";

const appUrl = "chrome-extension://test-extension/app.html";
const runtime: ExtensionRuntime = {
  id: "test-extension",
  getURL: (path) => `chrome-extension://test-extension/${path}`,
  onMessage: { addListener: () => undefined },
  sendMessage: () => undefined,
};

const appSender: ExtensionMessageSender = {
  id: "test-extension",
  url: appUrl,
};

describe("trusted extension app senders", () => {
  it("accepts the exact top-level app page with and without tab metadata", () => {
    expect(isTrustedOwnExtensionAppSender(appSender, runtime, "app.html")).toBe(
      true,
    );
    expect(
      isTrustedOwnExtensionAppSender(
        {
          ...appSender,
          origin: "chrome-extension://test-extension",
          frameId: 0,
          tab: { id: 17, url: appUrl },
        },
        runtime,
        "app.html",
      ),
    ).toBe(true);
  });

  it("rejects content scripts, other extension surfaces, and non-top-level app frames", () => {
    const rejected: ExtensionMessageSender[] = [
      {
        id: "test-extension",
        url: "https://www.apple.com/ca/shop/buy-iphone",
        origin: "https://www.apple.com",
        frameId: 0,
        tab: { id: 17, url: "https://www.apple.com/ca/shop/buy-iphone" },
      },
      {
        id: "test-extension",
        url: "http://localhost:3000",
        origin: "http://localhost:3000",
        frameId: 0,
        tab: { id: 17, url: "http://localhost:3000" },
      },
      { ...appSender, url: "chrome-extension://test-extension/popup.html" },
      { ...appSender, url: "chrome-extension://test-extension/options.html" },
      { ...appSender, url: `${appUrl}?unexpected=1` },
      { ...appSender, url: `${appUrl}#unexpected` },
      { ...appSender, url: "chrome-extension://test-extension:443/app.html" },
      {
        ...appSender,
        url: "chrome-extension://user:pass@test-extension/app.html",
      },
      { ...appSender, origin: "https://example.invalid" },
      { ...appSender, frameId: 1 },
      { ...appSender, tab: { id: -1, url: appUrl } },
      { ...appSender, tab: { id: 17, url: "https://www.apple.com/" } },
      { ...appSender, id: "other-extension" },
    ];

    for (const sender of rejected) {
      expect(isTrustedOwnExtensionAppSender(sender, runtime, "app.html")).toBe(
        false,
      );
    }
  });

  it("rejects a runtime app URL with query, fragment, credentials, or port", () => {
    for (const malformed of [
      "chrome-extension://test-extension/app.html?unexpected=1",
      "chrome-extension://test-extension/app.html#unexpected",
      "chrome-extension://user:pass@test-extension/app.html",
      "chrome-extension://test-extension:443/app.html",
    ]) {
      const malformedRuntime = { ...runtime, getURL: () => malformed };
      expect(
        isTrustedOwnExtensionAppSender(appSender, malformedRuntime, "app.html"),
      ).toBe(false);
    }
  });
});
