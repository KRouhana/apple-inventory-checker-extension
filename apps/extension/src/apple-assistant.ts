import {
  CHECKOUT_STORAGE_KEY,
  isMandateForCurrentApplePage,
  parseCheckoutMandate,
} from "./protocol";
import { getExtensionApi } from "./platform/api";
import { createExtensionPlatform } from "./platform/adapters";
import { BUILD_TARGET } from "./platform/build-target";

const api = getExtensionApi();
const platform = createExtensionPlatform(api, BUILD_TARGET);

function removePanel(): void {
  document.getElementById("inventory-signal-assistant")?.remove();
}

void platform.storage.read<unknown>(CHECKOUT_STORAGE_KEY).then((stored) => {
  const mandate = parseCheckoutMandate(stored);
  if (!mandate) {
    void platform.storage.remove(CHECKOUT_STORAGE_KEY);
    return;
  }
  if (!isMandateForCurrentApplePage(mandate, window.location.href)) return;

  removePanel();
  const panel = document.createElement("aside");
  panel.id = "inventory-signal-assistant";
  panel.setAttribute("aria-label", "Inventory Signal checkout assistant");

  const heading = document.createElement("strong");
  heading.textContent = "Inventory Signal checkout assistant";
  const title = document.createElement("span");
  title.textContent = mandate.variantTitle;
  const store = document.createElement("span");
  store.textContent = `${mandate.store.name} · Store ${mandate.store.appleStoreNumber}`;
  const warning = document.createElement("small");
  warning.textContent =
    "This is a store reference, not a reservation. Match this exact SKU and pickup store; you remain responsible for every option, sign-in, payment, and order submission.";

  const actions = document.createElement("div");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = `Copy SKU ${mandate.sku}`;
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(mandate.sku).then(() => {
      copy.textContent = "SKU copied";
    });
  });
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Dismiss";
  close.addEventListener("click", removePanel);
  actions.append(copy, close);
  panel.append(heading, title, store, warning, actions);
  document.documentElement.append(panel);
});
