import type { ExtensionMessageSender, ExtensionRuntime } from "./api.js";

function canonicalExtensionAppUrl(
  runtime: ExtensionRuntime,
  appPath: string,
): { href: string; origin: string } | null {
  if (typeof runtime.id !== "string" || runtime.id === "") return null;
  try {
    const expected = runtime.getURL(appPath);
    const parsed = new URL(expected);
    const origin =
      parsed.origin === "null"
        ? `${parsed.protocol}//${parsed.host}`
        : parsed.origin;
    return parsed.href === expected &&
      parsed.pathname === `/${appPath}` &&
      parsed.host !== "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.search === "" &&
      parsed.hash === ""
      ? { href: parsed.href, origin }
      : null;
  } catch {
    return null;
  }
}

function isTopLevelOwnAppTab(
  tab: ExtensionMessageSender["tab"],
  expectedUrl: string,
): boolean {
  if (tab === undefined) return true;
  return (
    typeof tab === "object" &&
    tab !== null &&
    typeof tab.id === "number" &&
    Number.isSafeInteger(tab.id) &&
    tab.id >= 0 &&
    (tab.url === undefined || tab.url === expectedUrl)
  );
}

/**
 * Allows only the exact packaged app page, whether it is opened in a browser
 * tab or another extension surface. It grants no authority to content scripts
 * or arbitrary extension pages.
 */
export function isTrustedOwnExtensionAppSender(
  sender: ExtensionMessageSender,
  runtime: ExtensionRuntime,
  appPath: string,
): boolean {
  const expected = canonicalExtensionAppUrl(runtime, appPath);
  return (
    expected !== null &&
    sender.id === runtime.id &&
    sender.url === expected.href &&
    (sender.origin === undefined || sender.origin === expected.origin) &&
    (sender.frameId === undefined || sender.frameId === 0) &&
    isTopLevelOwnAppTab(sender.tab, expected.href)
  );
}
