export const targets = ["chrome"];
export function validateManifest(target, manifest) {
  const fail = () => {
    throw new Error(
      "Chrome manifest differs from the approved least-permission package",
    );
  };
  if (target !== "chrome" || !manifest || manifest.manifest_version !== 3)
    fail();
  const expectedKeys = [
    "manifest_version",
    "name",
    "version",
    "description",
    "permissions",
    "host_permissions",
    "optional_host_permissions",
    "background",
    "action",
    "icons",
  ];
  if (Object.keys(manifest).sort().join() !== expectedKeys.sort().join())
    fail();
  if (
    manifest.name !== "Inventory Signal" ||
    manifest.version !== "0.1.0" ||
    typeof manifest.description !== "string" ||
    manifest.description.length > 132
  )
    fail();
  if (
    JSON.stringify(manifest.permissions) !==
    JSON.stringify(["alarms", "notifications", "storage"])
  )
    fail();
  if (
    JSON.stringify(manifest.host_permissions) !==
    JSON.stringify(["https://www.apple.com/*"])
  )
    fail();
  if (
    JSON.stringify(manifest.optional_host_permissions) !==
    JSON.stringify(["https://api.telegram.org/*"])
  )
    fail();
  if (
    JSON.stringify(manifest.background) !==
    JSON.stringify({ service_worker: "background.js", type: "module" })
  )
    fail();
  if (
    JSON.stringify(manifest.action) !==
    JSON.stringify({
      default_title: "Inventory Signal",
      default_popup: "popup.html",
      default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" },
    })
  )
    fail();
  if (
    JSON.stringify(manifest.icons) !==
    JSON.stringify({
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    })
  )
    fail();
}
