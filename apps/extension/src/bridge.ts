import { CHECKOUT_PROTOCOL, parseCheckoutMandate } from "./protocol";
import { getExtensionApi } from "./platform/api";
import {
  createOpenCheckoutMessage,
  TRUSTED_BRIDGE_ORIGINS,
} from "./platform/messages";

const api = getExtensionApi();

// nosemgrep: javascript.browser.security.insufficient-postmessage-origin-validation.insufficient-postmessage-origin-validation -- source and allowlisted origin are validated by the first guard.
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || !TRUSTED_BRIDGE_ORIGINS.has(event.origin))
    return;
  const mandate = parseCheckoutMandate(event.data);
  if (!mandate) return;
  // The web bridge is compatibility-only. The standalone local monitor opens
  // catalog-derived manual handoffs directly and never requires this page.
  api.runtime.sendMessage(createOpenCheckoutMessage(mandate), (response) => {
    const accepted =
      !api.runtime.lastError &&
      typeof response === "object" &&
      response !== null &&
      (response as { accepted?: unknown }).accepted === true;
    window.postMessage(
      {
        protocol: CHECKOUT_PROTOCOL,
        type: "CHECKOUT_ACK",
        id: mandate.id,
        accepted,
      },
      event.origin,
    );
  });
});
