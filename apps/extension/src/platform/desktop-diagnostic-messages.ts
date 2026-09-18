import type { ExtensionRuntime } from "./api.js";
import { isTrustedOwnExtensionAppSender } from "./trusted-app-sender.js";
import type { DesktopAlertDiagnosticResult } from "../notifications/desktop.js";

export const DESKTOP_DIAGNOSTIC_PROTOCOL =
  "inventory-signal.desktop-diagnostic.v1";
const APP_PATH = "app.html";

type ResultKind = DesktopAlertDiagnosticResult["kind"];
const RESULT_KINDS: readonly ResultKind[] = [
  "scheduled",
  "permission-denied",
  "unsupported",
  "cooldown",
  "in-flight",
  "unavailable",
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function knownKind(value: unknown): value is ResultKind {
  return (
    typeof value === "string" && RESULT_KINDS.includes(value as ResultKind)
  );
}

export interface DesktopDiagnosticController {
  sendUserInitiatedTest(): Promise<DesktopAlertDiagnosticResult>;
}

export function installDesktopDiagnosticMessageHandler(
  runtime: ExtensionRuntime,
  controller: DesktopDiagnosticController,
): void {
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!record(message) || message.protocol !== DESKTOP_DIAGNOSTIC_PROTOCOL)
      return;
    if (!isTrustedOwnExtensionAppSender(sender, runtime, APP_PATH)) {
      sendResponse({
        protocol: DESKTOP_DIAGNOSTIC_PROTOCOL,
        type: "RESULT",
        ok: false,
        error: "unauthorized",
      });
      return;
    }
    if (!exact(message, ["protocol", "type"]) || message.type !== "SEND_TEST") {
      sendResponse({
        protocol: DESKTOP_DIAGNOSTIC_PROTOCOL,
        type: "RESULT",
        ok: false,
        error: "invalid_request",
      });
      return;
    }
    void Promise.resolve()
      .then(() => controller.sendUserInitiatedTest())
      .then(
        (result) =>
          sendResponse(
            knownKind(result.kind)
              ? {
                  protocol: DESKTOP_DIAGNOSTIC_PROTOCOL,
                  type: "RESULT",
                  ok: true,
                  result: result.kind,
                }
              : {
                  protocol: DESKTOP_DIAGNOSTIC_PROTOCOL,
                  type: "RESULT",
                  ok: false,
                  error: "unavailable",
                },
          ),
        () =>
          sendResponse({
            protocol: DESKTOP_DIAGNOSTIC_PROTOCOL,
            type: "RESULT",
            ok: false,
            error: "unavailable",
          }),
      );
    return true;
  });
}

export function parseDesktopDiagnosticResponse(value: unknown): ResultKind {
  if (
    !record(value) ||
    value.protocol !== DESKTOP_DIAGNOSTIC_PROTOCOL ||
    value.type !== "RESULT"
  ) {
    return "unavailable";
  }
  if (
    value.ok === true &&
    exact(value, ["protocol", "type", "ok", "result"]) &&
    typeof value.result === "string" &&
    RESULT_KINDS.includes(value.result as ResultKind)
  )
    return value.result as ResultKind;
  return "unavailable";
}
