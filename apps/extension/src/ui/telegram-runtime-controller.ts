import { callExtensionApi } from "../platform/async.js";
import type { ExtensionRuntime } from "../platform/api.js";
import {
  PERSONAL_TELEGRAM_PROTOCOL,
  type PersonalTelegramRuntimeCommand,
  type PersonalTelegramRuntimeResponse,
  type PublicTelegramError,
  type PublicTelegramStatus,
} from "../platform/telegram-messages.js";
import type { PersonalTelegramUiController } from "./controller.js";

const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,256}$/;
const STATUS_TIMEOUT_MS = 2_000;
const PAIRING_COMMAND_PATTERN = /^INVENTORY SIGNAL ([a-f0-9]{64})$/;
const PAIRING_URL_PATTERN =
  /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=([a-f0-9]{64})$/;

function publicErrorMessage(code: PublicTelegramError): string {
  switch (code) {
    case "unsupported":
      return "Personal Telegram setup is not available in this browser.";
    case "permission_required":
      return "Telegram permission is required before setup can continue.";
    case "webhook_conflict":
      return "This bot is already connected to a webhook service. Use a dedicated personal bot.";
    case "pairing_pending":
      return "Paste your bot token and select Pair.";
    case "pairing_expired":
      return "Paste your bot token again and select Pair.";
    case "pairing_ambiguous":
      return "Multiple private chats were found. Use a dedicated personal bot.";
    case "delivery_failed":
      return "The Telegram request failed. Check your connection and bot access, then try again.";
    case "operation_failed":
      return "The Personal Telegram request failed in the extension. Reload the extension and try again.";
    case "cancelled":
      return "The Personal Telegram request was canceled. Try again.";
    case "storage_unavailable":
      return "Personal Telegram settings could not be saved in this browser. Try again.";
    case "invalid_token_format":
      return "Paste the complete bot token into the Bot token field, then select Pair. The field is cleared after each attempt.";
    case "token_rejected":
      return "Telegram rejected this bot token. Check that you pasted the current token for your bot, then try again.";
    case "bot_validation_failed":
      return "Telegram did not confirm the bot identity. Setup stopped; this does not establish that the token is invalid. Try again later.";
    case "webhook_check_failed":
      return "The bot identity was verified, but Telegram did not return a valid webhook configuration. Setup stopped. Try again later.";
    case "invalid_configuration":
      return "The bot configuration was not accepted. Paste a valid bot token and select Pair.";
    case "chat_not_found":
      return "No private chat was found. Open your bot, send it any message once, then click Pair again.";
    case "chat_ambiguous":
      return "This bot has messages from more than one private chat. Use a dedicated personal bot so alerts cannot go to the wrong person.";
    case "not_connected":
      return "Connect Personal Telegram before sending a test alert.";
    case "invalid_event":
      return "The Personal Telegram alert could not be sent. Try again.";
    case "unauthorized":
      return "This Personal Telegram request was not authorized.";
    case "invalid_request":
      return "The Personal Telegram request was invalid. Try again.";
  }
}

export class PersonalTelegramRuntimeError extends Error {
  constructor(public readonly code: PublicTelegramError) {
    super(publicErrorMessage(code));
    this.name = "PersonalTelegramRuntimeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isPublicError(value: unknown): value is PublicTelegramError {
  return [
    "cancelled",
    "delivery_failed",
    "invalid_configuration",
    "invalid_token_format",
    "token_rejected",
    "bot_validation_failed",
    "webhook_check_failed",
    "invalid_event",
    "chat_not_found",
    "chat_ambiguous",
    "not_connected",
    "pairing_ambiguous",
    "pairing_expired",
    "pairing_pending",
    "permission_required",
    "storage_unavailable",
    "unsupported",
    "webhook_conflict",
    "unauthorized",
    "invalid_request",
    "operation_failed",
  ].includes(String(value));
}

function validIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function asStatus(value: unknown): PublicTelegramStatus {
  if (!isRecord(value) || typeof value.kind !== "string")
    throw new PersonalTelegramRuntimeError("operation_failed");
  if (value.kind === "unsupported" || value.kind === "disconnected") {
    if (hasExactKeys(value, ["kind"])) return { kind: value.kind };
  }
  if (
    value.kind === "pairing" &&
    (hasExactKeys(value, ["kind", "pairingCommand", "expiresAt"]) ||
      hasExactKeys(value, [
        "kind",
        "pairingCommand",
        "expiresAt",
        "pairingUrl",
      ])) &&
    typeof value.pairingCommand === "string" &&
    PAIRING_COMMAND_PATTERN.test(value.pairingCommand) &&
    validIso(value.expiresAt) &&
    (value.pairingUrl === undefined ||
      (typeof value.pairingUrl === "string" &&
        PAIRING_URL_PATTERN.exec(value.pairingUrl)?.[1] ===
          PAIRING_COMMAND_PATTERN.exec(value.pairingCommand)?.[1]))
  )
    return {
      kind: "pairing",
      pairingCommand: value.pairingCommand,
      expiresAt: value.expiresAt,
      ...(value.pairingUrl === undefined
        ? {}
        : { pairingUrl: value.pairingUrl }),
    };
  if (
    (value.kind === "connected" || value.kind === "token_saved") &&
    hasExactKeys(value, ["kind", "botUsername"]) &&
    (value.botUsername === null ||
      (typeof value.botUsername === "string" &&
        /^[A-Za-z0-9_]{1,32}$/.test(value.botUsername)))
  )
    return { kind: value.kind, botUsername: value.botUsername };
  throw new PersonalTelegramRuntimeError("operation_failed");
}

function parseResponse(
  input: unknown,
  request: PersonalTelegramRuntimeCommand["type"],
): PublicTelegramStatus {
  if (
    !isRecord(input) ||
    input.protocol !== PERSONAL_TELEGRAM_PROTOCOL ||
    input.type !== "RESULT" ||
    input.request !== request ||
    typeof input.ok !== "boolean"
  )
    throw new PersonalTelegramRuntimeError("operation_failed");
  if (!input.ok) {
    if (
      !hasExactKeys(input, ["protocol", "type", "request", "ok", "error"]) ||
      !isPublicError(input.error)
    )
      throw new PersonalTelegramRuntimeError("operation_failed");
    throw new PersonalTelegramRuntimeError(input.error);
  }
  if (!hasExactKeys(input, ["protocol", "type", "request", "ok", "status"]))
    throw new PersonalTelegramRuntimeError("operation_failed");
  return asStatus(input.status);
}

async function request(
  runtime: ExtensionRuntime,
  command: PersonalTelegramRuntimeCommand,
): Promise<PublicTelegramStatus> {
  try {
    const raw = await callExtensionApi<unknown>(
      runtime,
      (callback, usePromiseApi) =>
        usePromiseApi
          ? runtime.sendMessage(command)
          : runtime.sendMessage(command, callback),
    );
    return parseResponse(raw, command.type);
  } catch (error) {
    if (error instanceof PersonalTelegramRuntimeError) throw error;
    throw new PersonalTelegramRuntimeError("operation_failed");
  }
}

async function boundedStatus(
  runtime: ExtensionRuntime,
): Promise<PublicTelegramStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(runtime, {
        protocol: PERSONAL_TELEGRAM_PROTOCOL,
        type: "STATUS",
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PersonalTelegramRuntimeError("operation_failed")),
          STATUS_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createRuntimePersonalTelegramController(
  runtime: ExtensionRuntime,
): PersonalTelegramUiController {
  return {
    status: () => boundedStatus(runtime),
    startPairing: (botToken) => {
      if (typeof botToken === "string") botToken = botToken.trim();
      if (
        typeof botToken !== "string" ||
        !TOKEN_PATTERN.test(botToken) ||
        botToken.length > 277
      )
        return Promise.reject(
          new PersonalTelegramRuntimeError("invalid_token_format"),
        );
      return request(runtime, {
        protocol: PERSONAL_TELEGRAM_PROTOCOL,
        type: "PAIR_TOKEN",
        botToken,
      });
    },
    confirmPairing: () =>
      request(runtime, {
        protocol: PERSONAL_TELEGRAM_PROTOCOL,
        type: "PAIR_SAVED_TOKEN",
      }),
    sendTest: () =>
      request(runtime, {
        protocol: PERSONAL_TELEGRAM_PROTOCOL,
        type: "SEND_TEST",
      }),
    disconnect: () =>
      request(runtime, {
        protocol: PERSONAL_TELEGRAM_PROTOCOL,
        type: "DISCONNECT",
      }),
  };
}
