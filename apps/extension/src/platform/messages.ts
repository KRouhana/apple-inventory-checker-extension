import type { ExtensionMessageSender, ExtensionRuntime } from "./api";
import type { CheckoutMandate } from "../protocol";
import { parseCheckoutMandate } from "../protocol";

export const PLATFORM_PROTOCOL = "inventory-signal.extension.v1";
export const TRUSTED_BRIDGE_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

export interface OpenCheckoutMessage {
  protocol: typeof PLATFORM_PROTOCOL;
  type: "OPEN_CHECKOUT";
  mandate: CheckoutMandate;
}

function senderOrigin(sender: ExtensionMessageSender): string | null {
  const value = sender.origin ?? sender.url ?? sender.tab?.url;
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Messages may enter from the bridge content script only.  A page that can
 * postMessage to that script remains constrained by its own exact origin,
 * while arbitrary content scripts and extension-external senders are denied.
 */
export function isTrustedBridgeSender(
  sender: ExtensionMessageSender,
  runtime: ExtensionRuntime,
): boolean {
  return (
    typeof runtime.id === "string" &&
    sender.id === runtime.id &&
    (() => {
      const origin = senderOrigin(sender);
      return origin !== null && TRUSTED_BRIDGE_ORIGINS.has(origin);
    })()
  );
}

export function parseOpenCheckoutMessage(
  input: unknown,
): OpenCheckoutMessage | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const message = input as Record<string, unknown>;
  if (
    message.protocol !== PLATFORM_PROTOCOL ||
    message.type !== "OPEN_CHECKOUT"
  ) {
    return null;
  }
  const mandate = parseCheckoutMandate(message.mandate);
  return mandate
    ? { protocol: PLATFORM_PROTOCOL, type: "OPEN_CHECKOUT", mandate }
    : null;
}

export function createOpenCheckoutMessage(
  mandate: CheckoutMandate,
): OpenCheckoutMessage {
  return { protocol: PLATFORM_PROTOCOL, type: "OPEN_CHECKOUT", mandate };
}
