import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionMessageSender,
  ExtensionRuntime,
} from "../src/platform/api.js";
import {
  installPersonalTelegramMessageHandler,
  parsePersonalTelegramRuntimeCommand,
  PERSONAL_TELEGRAM_PROTOCOL,
  type PersonalTelegramRuntimeDependencies,
  type PublicTelegramError,
} from "../src/platform/telegram-messages.js";
import {
  createRuntimePersonalTelegramController,
  PersonalTelegramRuntimeError,
} from "../src/ui/telegram-runtime-controller.js";

function createRuntime() {
  const listeners: Array<
    (
      message: unknown,
      sender: ExtensionMessageSender,
      sendResponse: (response: unknown) => void,
    ) => boolean | void
  > = [];
  const runtime: ExtensionRuntime = {
    id: "test-extension",
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    onMessage: { addListener: (listener) => listeners.push(listener) },
    sendMessage: () => undefined,
  };
  const dispatch = (message: unknown, sender: ExtensionMessageSender) =>
    new Promise<unknown>((resolve) => {
      for (const listener of listeners) {
        if (listener(message, sender, resolve)) return;
      }
      resolve(undefined);
    });
  return { runtime, dispatch };
}

function dependencies(): PersonalTelegramRuntimeDependencies & {
  readonly calls: { start: string[]; disconnect: number };
} {
  const calls = { start: [] as string[], disconnect: 0 };
  return {
    calls,
    supported: () => true,
    disableTelegramWatches: vi.fn(async () => undefined),
    controller: {
      status: vi.fn(async () => ({ kind: "disconnected" as const })),
      startPairing: vi.fn(async (token: string) => {
        calls.start.push(token);
        return {
          kind: "pairing" as const,
          pairingCommand: `INVENTORY SIGNAL ${"a".repeat(64)}`,
          expiresAt: "2026-09-09T12:10:00.000Z",
          pairingUrl: `https://t.me/SafeBot?start=${"a".repeat(64)}`,
        };
      }),
      confirmPairing: vi.fn(async () => ({ kind: "disconnected" as const })),
      sendTest: vi.fn(async () => undefined),
      sendStoredAvailable: vi.fn(async () => ({ kind: "sent" as const })),
      sendAvailable: vi.fn(async () => ({ kind: "sent" as const })),
      disconnect: vi.fn(async () => {
        calls.disconnect += 1;
      }),
    },
  } as never;
}

const trusted = {
  id: "test-extension",
  url: "chrome-extension://test-extension/app.html",
};

describe("Personal Telegram setup protocol", () => {
  it("normalizes pasted token whitespace and rejects empty or malformed tokens before messaging", async () => {
    const { runtime, dispatch } = createRuntime();
    const deps = dependencies();
    installPersonalTelegramMessageHandler(runtime, deps);
    runtime.sendMessage = vi.fn((message) => dispatch(message, trusted));
    const controller = createRuntimePersonalTelegramController(runtime);
    const clean = `12345:${"a".repeat(20)}`;
    await expect(
      controller.startPairing(`  ${clean}\n`),
    ).resolves.toMatchObject({ kind: "pairing" });
    expect(deps.calls.start).toEqual([clean]);
    const count = vi.mocked(runtime.sendMessage).mock.calls.length;
    for (const bad of [
      "",
      "  ",
      "@SyntheticBot",
      "12345:short",
      `12345:${"a".repeat(10)} ${"a".repeat(10)}`,
    ]) {
      await expect(controller.startPairing(bad)).rejects.toMatchObject({
        code: "invalid_token_format",
      });
    }
    expect(vi.mocked(runtime.sendMessage).mock.calls).toHaveLength(count);
  });

  it("maps every finite public error to recovery copy without provider details", () => {
    const secret = `12345:${"s".repeat(20)}`;
    const messages: Readonly<Record<PublicTelegramError, string>> = {
      cancelled: "The Personal Telegram request was canceled. Try again.",
      delivery_failed:
        "The Telegram request failed. Check your connection and bot access, then try again.",
      invalid_token_format:
        "Paste the complete bot token into the Bot token field, then select Connect Telegram. The field is cleared after each attempt.",
      token_rejected:
        "Telegram rejected this bot token. Check that you pasted the current token for your bot, then try again.",
      bot_validation_failed:
        "Telegram did not confirm the bot identity. Setup stopped before pairing; this does not establish that the token is invalid. Try again later.",
      webhook_check_failed:
        "The bot identity was verified, but Telegram did not return a valid webhook configuration. Setup stopped before pairing. Try again later.",
      invalid_configuration:
        "The bot configuration was not accepted. Start private pairing again with a valid bot token.",
      invalid_event:
        "The Personal Telegram alert could not be sent. Try again.",
      not_connected: "Connect Personal Telegram before sending a test alert.",
      pairing_ambiguous:
        "Multiple matching private chats were found. Use your own private chat and start pairing again.",
      pairing_expired:
        "This pairing request expired. Start private pairing again.",
      pairing_pending:
        "Pairing is not finished. Open Telegram and tap Start using the setup link (or send the displayed pairing command), then select Check connection.",
      permission_required:
        "Telegram permission is required before setup can continue.",
      storage_unavailable:
        "Personal Telegram settings could not be saved in this browser. Try again.",
      unsupported: "Personal Telegram setup is not available in this browser.",
      webhook_conflict:
        "This bot is already connected to a webhook service. Use a dedicated bot for local pairing.",
      unauthorized: "This Personal Telegram request was not authorized.",
      invalid_request: "The Personal Telegram request was invalid. Try again.",
      operation_failed:
        "The Personal Telegram request failed in the extension. Reload the extension and try again.",
    };
    for (const [code, message] of Object.entries(messages) as [
      PublicTelegramError,
      string,
    ][]) {
      const error = new PersonalTelegramRuntimeError(code);
      expect(error.message).toBe(message);
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain("https://");
    }
  });

  it("does not surface malformed provider-shaped runtime responses", async () => {
    const secret = `12345:${"s".repeat(20)}`;
    const runtime: ExtensionRuntime = {
      id: "test-extension",
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: () => undefined },
      sendMessage: () =>
        Promise.resolve({
          protocol: PERSONAL_TELEGRAM_PROTOCOL,
          type: "RESULT",
          request: "CONFIRM_PAIRING",
          ok: false,
          error: `${secret} provider body`,
        }),
    };
    const error = await createRuntimePersonalTelegramController(runtime)
      .confirmPairing()
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "operation_failed" });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
  });

  it("accepts only the finite exact command shapes", () => {
    expect(
      parsePersonalTelegramRuntimeCommand({
        protocol: PERSONAL_TELEGRAM_PROTOCOL,
        type: "STATUS",
      }),
    ).toEqual({ protocol: PERSONAL_TELEGRAM_PROTOCOL, type: "STATUS" });
    expect(
      parsePersonalTelegramRuntimeCommand({
        protocol: PERSONAL_TELEGRAM_PROTOCOL,
        type: "START_PAIRING",
        botToken: `12345:${"a".repeat(20)}`,
        storage: "forbidden",
      }),
    ).toBeNull();
    expect(
      parsePersonalTelegramRuntimeCommand({
        protocol: PERSONAL_TELEGRAM_PROTOCOL,
        type: "SEND_TEST",
        url: "https://example.invalid",
      }),
    ).toBeNull();
  });

  it("accepts the exact app tab but rejects content scripts, foreign pages, and malformed commands", async () => {
    const { runtime, dispatch } = createRuntime();
    installPersonalTelegramMessageHandler(runtime, dependencies());
    const command = { protocol: PERSONAL_TELEGRAM_PROTOCOL, type: "STATUS" };
    await expect(
      dispatch(command, {
        ...trusted,
        origin: "chrome-extension://test-extension",
        frameId: 0,
        tab: { id: 1, url: trusted.url },
      }),
    ).resolves.toMatchObject({ ok: true, status: { kind: "disconnected" } });
    await expect(
      dispatch(command, {
        id: "test-extension",
        url: "https://www.apple.com/ca/shop/buy-iphone",
        origin: "https://www.apple.com",
        frameId: 0,
        tab: { id: 1, url: "https://www.apple.com/ca/shop/buy-iphone" },
      }),
    ).resolves.toMatchObject({ error: "unauthorized" });
    await expect(
      dispatch(command, { id: "other", url: trusted.url }),
    ).resolves.toMatchObject({ error: "unauthorized" });
    await expect(
      dispatch({ ...command, fetch: "forbidden" }, trusted),
    ).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("returns a validated redacted pairing status and never echoes the submitted token", async () => {
    const { runtime, dispatch } = createRuntime();
    const deps = dependencies();
    installPersonalTelegramMessageHandler(runtime, deps);
    const token = `12345:${"a".repeat(20)}`;
    const response = await dispatch(
      {
        protocol: PERSONAL_TELEGRAM_PROTOCOL,
        type: "START_PAIRING",
        botToken: token,
      },
      trusted,
    );
    expect(deps.calls.start).toEqual([token]);
    expect(response).toEqual({
      protocol: PERSONAL_TELEGRAM_PROTOCOL,
      type: "RESULT",
      request: "START_PAIRING",
      ok: true,
      status: {
        kind: "pairing",
        pairingCommand: `INVENTORY SIGNAL ${"a".repeat(64)}`,
        expiresAt: "2026-09-09T12:10:00.000Z",
        pairingUrl: `https://t.me/SafeBot?start=${"a".repeat(64)}`,
      },
    });
    expect(JSON.stringify(response)).not.toContain(token);
  });

  it("rejects arbitrary or nonce-mismatched pairing URLs at both protocol boundaries", async () => {
    const command = `INVENTORY SIGNAL ${"a".repeat(64)}`;
    const { runtime, dispatch } = createRuntime();
    const deps = dependencies();
    deps.controller.status = vi.fn(async () => ({
      kind: "pairing" as const,
      pairingCommand: command,
      expiresAt: "2026-09-09T12:10:00.000Z",
      pairingUrl: `https://t.me/SafeBot?start=${"b".repeat(64)}`,
    }));
    installPersonalTelegramMessageHandler(runtime, deps);
    await expect(
      dispatch(
        { protocol: PERSONAL_TELEGRAM_PROTOCOL, type: "STATUS" },
        trusted,
      ),
    ).resolves.toMatchObject({ ok: false, error: "operation_failed" });

    const unsafeRuntime: ExtensionRuntime = {
      id: "test-extension",
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: () => undefined },
      sendMessage: () =>
        Promise.resolve({
          protocol: PERSONAL_TELEGRAM_PROTOCOL,
          type: "RESULT",
          request: "STATUS",
          ok: true,
          status: {
            kind: "pairing",
            pairingCommand: command,
            expiresAt: "2026-09-09T12:10:00.000Z",
            pairingUrl: `https://example.invalid/?start=${"a".repeat(64)}`,
          },
        }),
    };
    await expect(
      createRuntimePersonalTelegramController(unsafeRuntime).status(),
    ).rejects.toMatchObject({ code: "operation_failed" });
  });

  it("disconnects the delivery controller before clearing Telegram watch opt-in", async () => {
    const { runtime, dispatch } = createRuntime();
    const deps = dependencies();
    const sequence: string[] = [];
    deps.controller.disconnect = vi.fn(async () => {
      sequence.push("disconnect");
    });
    deps.disableTelegramWatches = vi.fn(async () => {
      sequence.push("disable");
    });
    installPersonalTelegramMessageHandler(runtime, deps);
    await dispatch(
      { protocol: PERSONAL_TELEGRAM_PROTOCOL, type: "DISCONNECT" },
      trusted,
    );
    expect(sequence).toEqual(["disconnect", "disable"]);
  });

  it("rejects malformed or secret-bearing results before they reach the UI", async () => {
    const sent: unknown[] = [];
    const runtime: ExtensionRuntime = {
      id: "test-extension",
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: () => undefined },
      sendMessage: (message) => {
        sent.push(message);
        return Promise.resolve({
          protocol: PERSONAL_TELEGRAM_PROTOCOL,
          type: "RESULT",
          request: "STATUS",
          ok: true,
          status: {
            kind: "connected",
            botUsername: "safe_bot",
            botToken: `12345:${"a".repeat(20)}`,
          },
        });
      },
    };
    const client = createRuntimePersonalTelegramController(runtime);
    await expect(client.status()).rejects.toBeInstanceOf(
      PersonalTelegramRuntimeError,
    );
    expect(sent).toEqual([
      { protocol: PERSONAL_TELEGRAM_PROTOCOL, type: "STATUS" },
    ]);
  });

  it("bounds an unresponsive status request so initial UI refresh cannot hang", async () => {
    vi.useFakeTimers();
    try {
      const runtime: ExtensionRuntime = {
        id: "test-extension",
        getURL: (path) => `chrome-extension://test-extension/${path}`,
        onMessage: { addListener: () => undefined },
        sendMessage: () => new Promise(() => undefined),
      };
      const pending = createRuntimePersonalTelegramController(runtime).status();
      const rejected = expect(pending).rejects.toMatchObject({
        code: "operation_failed",
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
