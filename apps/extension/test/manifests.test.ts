import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../scripts/manifest-policy.mjs";
const manifest = JSON.parse(
  readFileSync(
    new URL("../static/manifests/chrome.json", import.meta.url),
    "utf8",
  ),
);
describe("Chrome manifest", () => {
  it("permits only the local monitor and optional Telegram without page injection", () => {
    expect(() => validateManifest("chrome", manifest)).not.toThrow();
    expect(manifest.content_scripts).toBeUndefined();
  });
  it.each(["cookies", "tabs", "scripting", "webRequest"])(
    "rejects added %s access",
    (permission) => {
      expect(() =>
        validateManifest("chrome", {
          ...manifest,
          permissions: [...manifest.permissions, permission],
        }),
      ).toThrow();
    },
  );
  it("rejects extra hosts and localhost content scripts", () => {
    expect(() =>
      validateManifest("chrome", {
        ...manifest,
        host_permissions: ["<all_urls>"],
      }),
    ).toThrow();
    expect(() =>
      validateManifest("chrome", { ...manifest, content_scripts: [] }),
    ).toThrow();
  });
});
