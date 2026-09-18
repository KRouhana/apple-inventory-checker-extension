import { CHECKOUT_STORAGE_KEY } from "../protocol";
import type { ExtensionApi } from "./api";
import type { ExtensionPlatform } from "./adapters";
import {
  isTrustedBridgeSender,
  parseOpenCheckoutMessage,
  PLATFORM_PROTOCOL,
} from "./messages";

export interface CheckoutMessageResponse {
  accepted: boolean;
}

/** Installs only the manual Apple checkout handoff. Polling is L08. */
export function installCheckoutMessageHandler(
  api: ExtensionApi,
  platform: Pick<ExtensionPlatform, "storage" | "tabs">,
): void {
  api.runtime.onMessage.addListener((input, sender, sendResponse) => {
    // Several independently-owned handlers share runtime.onMessage. Only this
    // protocol belongs to the optional localhost checkout bridge; replying to
    // a monitor command would race its sender-validated controller.
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      (input as Record<string, unknown>).protocol !== PLATFORM_PROTOCOL
    ) {
      return;
    }
    if (!isTrustedBridgeSender(sender, api.runtime)) {
      sendResponse({ accepted: false } satisfies CheckoutMessageResponse);
      return;
    }
    const message = parseOpenCheckoutMessage(input);
    if (!message) {
      sendResponse({ accepted: false } satisfies CheckoutMessageResponse);
      return;
    }

    void (async () => {
      try {
        await platform.storage.write(CHECKOUT_STORAGE_KEY, message.mandate);
        await platform.tabs.openApplePurchase(message.mandate.purchaseUrl);
        sendResponse({ accepted: true } satisfies CheckoutMessageResponse);
      } catch {
        sendResponse({ accepted: false } satisfies CheckoutMessageResponse);
      }
    })();
    return true;
  });
}
