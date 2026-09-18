import { callExtensionApi } from "../platform/async.js";
import type { ExtensionRuntime } from "../platform/api.js";
import {
  DESKTOP_DIAGNOSTIC_PROTOCOL,
  parseDesktopDiagnosticResponse,
} from "../platform/desktop-diagnostic-messages.js";
import type { DesktopDiagnosticUiController } from "./controller.js";

export function createRuntimeDesktopDiagnosticController(
  runtime: ExtensionRuntime,
): DesktopDiagnosticUiController {
  return {
    async sendTest() {
      try {
        const response = await callExtensionApi<unknown>(
          runtime,
          (callback, promise) =>
            promise
              ? runtime.sendMessage({
                  protocol: DESKTOP_DIAGNOSTIC_PROTOCOL,
                  type: "SEND_TEST",
                })
              : runtime.sendMessage(
                  { protocol: DESKTOP_DIAGNOSTIC_PROTOCOL, type: "SEND_TEST" },
                  callback,
                ),
        );
        return parseDesktopDiagnosticResponse(response);
      } catch {
        return "unavailable";
      }
    },
  };
}
