import type { ExtensionMessageSender, ExtensionRuntime } from "./api.js";
import { isTrustedOwnExtensionAppSender } from "./trusted-app-sender.js";
import {
  PersonalTelegramError,
  type PersonalTelegramController,
  type PersonalTelegramStatus,
  type TelegramErrorCode,
} from "../notifications/telegram.js";

export const PERSONAL_TELEGRAM_PROTOCOL =
  "inventory-signal.personal-telegram.v1";
const APP_PATH = "app.html";
const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,256}$/;

type CommandType =
  | "STATUS"
  | "PAIR_TOKEN"
  | "PAIR_SAVED_TOKEN"
  | "SAVE_TOKEN"
  | "START_PAIRING"
  | "CONFIRM_PAIRING"
  | "SEND_TEST"
  | "DISCONNECT";

const COMMAND_TYPES: readonly CommandType[] = [
  "STATUS",
  "PAIR_TOKEN",
  "PAIR_SAVED_TOKEN",
  "SAVE_TOKEN",
  "START_PAIRING",
  "CONFIRM_PAIRING",
  "SEND_TEST",
  "DISCONNECT",
];

export type PersonalTelegramRuntimeCommand =
  | { protocol: typeof PERSONAL_TELEGRAM_PROTOCOL; type: "STATUS" }
  | {
      protocol: typeof PERSONAL_TELEGRAM_PROTOCOL;
      type: "START_PAIRING" | "SAVE_TOKEN" | "PAIR_TOKEN";
      botToken: string;
    }
  | { protocol: typeof PERSONAL_TELEGRAM_PROTOCOL; type: "CONFIRM_PAIRING" }
  | { protocol: typeof PERSONAL_TELEGRAM_PROTOCOL; type: "PAIR_SAVED_TOKEN" }
  | { protocol: typeof PERSONAL_TELEGRAM_PROTOCOL; type: "SEND_TEST" }
  | { protocol: typeof PERSONAL_TELEGRAM_PROTOCOL; type: "DISCONNECT" };

export type PublicTelegramStatus =
  | { kind: "unsupported" }
  | { kind: "disconnected" }
  | {
      kind: "pairing";
      pairingCommand: string;
      expiresAt: string;
      pairingUrl?: string;
    }
  | { kind: "token_saved"; botUsername: string | null }
  | { kind: "connected"; botUsername: string | null };

export type PublicTelegramError =
  | TelegramErrorCode
  | "unauthorized"
  | "invalid_request"
  | "operation_failed";

export type PersonalTelegramRuntimeResponse =
  | {
      protocol: typeof PERSONAL_TELEGRAM_PROTOCOL;
      type: "RESULT";
      request: CommandType;
      ok: true;
      status: PublicTelegramStatus;
    }
  | {
      protocol: typeof PERSONAL_TELEGRAM_PROTOCOL;
      type: "RESULT";
      request: CommandType | "UNKNOWN";
      ok: false;
      error: PublicTelegramError;
    };

export interface PersonalTelegramRuntimeDependencies {
  controller: PersonalTelegramController;
  supported(): boolean;
  /** Disconnect must invalidate active delivery and remove channel opt-in. */
  disableTelegramWatches(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isCommandType(value: unknown): value is CommandType {
  return COMMAND_TYPES.includes(value as CommandType);
}

function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 277 &&
    TOKEN_PATTERN.test(value)
  );
}

export function parsePersonalTelegramRuntimeCommand(
  value: unknown,
): PersonalTelegramRuntimeCommand | null {
  if (!isRecord(value) || value.protocol !== PERSONAL_TELEGRAM_PROTOCOL)
    return null;
  switch (value.type) {
    case "STATUS":
    case "PAIR_SAVED_TOKEN":
    case "CONFIRM_PAIRING":
    case "SEND_TEST":
    case "DISCONNECT":
      return exactKeys(value, ["protocol", "type"])
        ? { protocol: PERSONAL_TELEGRAM_PROTOCOL, type: value.type }
        : null;
    case "PAIR_TOKEN":
    case "SAVE_TOKEN":
    case "START_PAIRING":
      return exactKeys(value, ["protocol", "type", "botToken"]) &&
        validToken(value.botToken)
        ? {
            protocol: PERSONAL_TELEGRAM_PROTOCOL,
            type: value.type,
            botToken: value.botToken,
          }
        : null;
    default:
      return null;
  }
}

export function isTrustedTelegramAppSender(
  sender: ExtensionMessageSender,
  runtime: ExtensionRuntime,
): boolean {
  return isTrustedOwnExtensionAppSender(sender, runtime, APP_PATH);
}

const PAIRING_COMMAND_PATTERN = /^INVENTORY SIGNAL [a-f0-9]{64}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,32}$/;
const PAIRING_URL_PATTERN =
  /^https:\/\/t\.me\/([A-Za-z0-9_]{5,32})\?start=([a-f0-9]{64})$/;

function validIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validPairingUrl(value: unknown, pairingCommand: string): boolean {
  const commandNonce = pairingCommand.slice("INVENTORY SIGNAL ".length);
  const match =
    typeof value === "string" ? PAIRING_URL_PATTERN.exec(value) : null;
  return match !== null && match[2] === commandNonce;
}

function publicStatus(
  status: PersonalTelegramStatus,
  supported: boolean,
): PublicTelegramStatus | null {
  if (!supported) return { kind: "unsupported" };
  switch (status.kind) {
    case "disconnected":
      return { kind: "disconnected" };
    case "pairing":
      if (
        !PAIRING_COMMAND_PATTERN.test(status.pairingCommand) ||
        !validIso(status.expiresAt) ||
        (status.pairingUrl !== undefined &&
          !validPairingUrl(status.pairingUrl, status.pairingCommand))
      )
        return null;
      return {
        kind: "pairing",
        pairingCommand: status.pairingCommand,
        expiresAt: status.expiresAt,
        ...(status.pairingUrl === undefined
          ? {}
          : { pairingUrl: status.pairingUrl }),
      };
    case "token_saved":
    case "connected":
      if (
        status.botUsername !== null &&
        (typeof status.botUsername !== "string" ||
          !USERNAME_PATTERN.test(status.botUsername))
      )
        return null;
      return { kind: status.kind, botUsername: status.botUsername };
  }
}

function errorResponse(
  request: CommandType | "UNKNOWN",
  error: PublicTelegramError,
): PersonalTelegramRuntimeResponse {
  return {
    protocol: PERSONAL_TELEGRAM_PROTOCOL,
    type: "RESULT",
    request,
    ok: false,
    error,
  } as PersonalTelegramRuntimeResponse;
}

function safeError(error: unknown): TelegramErrorCode | "operation_failed" {
  if (!(error instanceof PersonalTelegramError)) return "operation_failed";
  return error.code;
}

async function execute(
  command: PersonalTelegramRuntimeCommand,
  dependencies: PersonalTelegramRuntimeDependencies,
): Promise<PersonalTelegramRuntimeResponse> {
  try {
    if (command.type === "STATUS") {
      const status = publicStatus(
        await dependencies.controller.status(),
        dependencies.supported(),
      );
      if (!status) return errorResponse(command.type, "operation_failed");
      return {
        protocol: PERSONAL_TELEGRAM_PROTOCOL,
        type: "RESULT",
        request: command.type,
        ok: true,
        status,
      };
    }
    if (!dependencies.supported())
      return errorResponse(command.type, "unsupported");
    let status: PersonalTelegramStatus;
    if (command.type === "PAIR_TOKEN") {
      if (!dependencies.controller.pairToken)
        return errorResponse(command.type, "unsupported");
      status = await dependencies.controller.pairToken(command.botToken);
    } else if (command.type === "PAIR_SAVED_TOKEN") {
      if (!dependencies.controller.pairSavedToken)
        return errorResponse(command.type, "unsupported");
      status = await dependencies.controller.pairSavedToken();
    } else if (command.type === "SAVE_TOKEN") {
      if (!dependencies.controller.saveToken)
        return errorResponse(command.type, "unsupported");
      status = await dependencies.controller.saveToken(command.botToken);
    } else if (command.type === "START_PAIRING")
      status = await dependencies.controller.startPairing(command.botToken);
    else if (command.type === "CONFIRM_PAIRING")
      status = await dependencies.controller.confirmPairing();
    else if (command.type === "SEND_TEST") {
      await dependencies.controller.sendTest();
      status = await dependencies.controller.status();
    } else {
      await dependencies.controller.disconnect();
      await dependencies.disableTelegramWatches();
      status = await dependencies.controller.status();
    }
    const publicResult = publicStatus(status, true);
    if (!publicResult) return errorResponse(command.type, "operation_failed");
    return {
      protocol: PERSONAL_TELEGRAM_PROTOCOL,
      type: "RESULT",
      request: command.type,
      ok: true,
      status: publicResult,
    };
  } catch (error) {
    return errorResponse(command.type, safeError(error));
  }
}

/** Installs a finite, app-page-only setup API. It exposes no storage or fetch. */
export function installPersonalTelegramMessageHandler(
  runtime: ExtensionRuntime,
  dependencies: PersonalTelegramRuntimeDependencies,
): void {
  runtime.onMessage.addListener((input, sender, sendResponse) => {
    if (!isRecord(input) || input.protocol !== PERSONAL_TELEGRAM_PROTOCOL)
      return;
    const request = isCommandType(input.type) ? input.type : "UNKNOWN";
    if (!isTrustedTelegramAppSender(sender, runtime)) {
      sendResponse(errorResponse(request, "unauthorized"));
      return;
    }
    const command = parsePersonalTelegramRuntimeCommand(input);
    if (!command) {
      sendResponse(errorResponse(request, "invalid_request"));
      return;
    }
    void execute(command, dependencies).then(sendResponse, () =>
      sendResponse(errorResponse(command.type, "operation_failed")),
    );
    return true;
  });
}
