import { createUnavailableMonitorController } from "./ui/controller.js";
import { mountLocalMonitorUi } from "./ui/view.js";
import { getExtensionApi } from "./platform/api.js";
import { createExtensionPlatform } from "./platform/adapters.js";
import { BUILD_TARGET } from "./platform/build-target.js";
import { createRuntimeMonitorController } from "./ui/runtime-controller.js";
import { createRuntimePersonalTelegramController } from "./ui/telegram-runtime-controller.js";
import { createRuntimeDesktopDiagnosticController } from "./ui/desktop-diagnostic-runtime-controller.js";

const root = document.querySelector<HTMLElement>("[data-monitor-root]");
if (!root) throw new Error("Inventory Signal app root is missing");
const mountRoot = root;

async function mount(): Promise<void> {
  try {
    const api = getExtensionApi();
    const controller = await createRuntimeMonitorController(api.runtime);
    const platform = createExtensionPlatform(api, BUILD_TARGET);
    mountLocalMonitorUi(
      mountRoot,
      {
        ...controller,
        personalTelegram: createRuntimePersonalTelegramController(api.runtime),
        desktopDiagnostic: createRuntimeDesktopDiagnosticController(
          api.runtime,
        ),
      },
      {
        // This callback is invoked synchronously from the visible setup click.
        requestTelegramHostPermission: () =>
          platform.permissions.requestTelegramHostPermission(),
      },
    );
  } catch {
    // The extension page never falls back to direct browser storage, a local
    // loopback service, or Apple requests. An unavailable worker stays visible.
    mountLocalMonitorUi(
      mountRoot,
      createUnavailableMonitorController(
        "The local monitor background is not connected to this page yet.",
      ),
    );
  }
}

void mount();
