import { describe, expect, it, vi } from "vitest";

import type { LocalAvailabilityEvent } from "../../../packages/core/src/local-monitor-contracts";
import {
  createPersonalTelegramController,
  formatPersonalTelegramAvailability,
  PERSONAL_TELEGRAM_STORAGE_KEY,
  PersonalTelegramError,
  type TelegramClock,
  type TelegramFetchPort,
  type TelegramResponse,
} from "../src/notifications/telegram";

const token = ["123456789", "abcdefghijklmnopqrstuvwx"].join(":");
const rotatedToken = ["987654321", "zyxwvutsrqponmlkjihgfedc"].join(":");
const nonce = "ab".repeat(32);
const event: LocalAvailabilityEvent = {
  watchId: "watch_1",
  market: "ca",
  sku: "MG464LL/A",
  title: 'iPhone <a href="https://evil.example/">Test</a> & Plus',
  storeNumber: "R123",
  storeName: "<b>Apple & Test</b>",
  observedAt: "2026-09-09T12:00:00.000Z",
  purchaseUrl: "https://www.apple.com/ca/shop/buy-iphone/iphone-17-pro",
};

function response(
  body: unknown,
  options: Partial<
    Pick<
      TelegramResponse,
      "httpStatus" | "redirected" | "retryAfterSeconds" | "url"
    >
  > = {},
): TelegramResponse {
  return {
    httpStatus: 200,
    redirected: false,
    url: "https://api.telegram.org/example",
    json: async () => body,
    ...options,
  };
}

function harness(
  options: {
    responses?: Array<TelegramResponse | Error>;
    savedValues?: Map<string, unknown>;
    supported?: boolean;
    storageFailure?: boolean;
    timeoutTimerAt?: number;
    fetchOverride?: (
      url: string,
      init: Parameters<TelegramFetchPort["fetch"]>[1],
      callCount: number,
    ) => Promise<TelegramResponse> | TelegramResponse | undefined;
    checkPermission?: () => Promise<boolean>;
  } = {},
) {
  const values = options.savedValues ?? new Map<string, unknown>();
  const calls: Array<{
    url: string;
    init: Parameters<TelegramFetchPort["fetch"]>[1];
  }> = [];
  const responses = [...(options.responses ?? [])];
  let now = Date.parse("2026-09-09T12:00:00.000Z");
  let timerCalls = 0;
  const clock: TelegramClock = {
    nowMs: () => now,
    setTimeout: vi.fn((callback) => {
      timerCalls += 1;
      if (timerCalls === options.timeoutTimerAt) queueMicrotask(callback);
      return timerCalls;
    }),
    clearTimeout: vi.fn(),
    sleep: vi.fn(async () => undefined),
  };
  const fetchPort: TelegramFetchPort = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const overridden = options.fetchOverride?.(url, init, calls.length);
      if (overridden !== undefined) return overridden;
      const next = responses.shift() ?? response({ ok: true, result: true });
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const controller = createPersonalTelegramController({
    storage: {
      read: async (key) => values.get(key) ?? null,
      write: async (key, value) => {
        if (options.storageFailure)
          throw new Error("storage contains " + token);
        values.set(key, value);
      },
      remove: async (key) => {
        if (options.storageFailure)
          throw new Error("storage contains " + token);
        values.delete(key);
      },
    },
    fetchPort,
    clock,
    random: { bytes: () => Uint8Array.from({ length: 32 }, () => 0xab) },
    isSupported: () => options.supported ?? true,
    checkPermission: options.checkPermission,
  });
  return {
    controller,
    values,
    calls,
    clock,
    advance: (milliseconds: number) => (now += milliseconds),
  };
}

function connectedResponses(): TelegramResponse[] {
  return [
    response({ ok: true, result: { is_bot: true, username: "MyPersonalBot" } }),
    response({ ok: true, result: { url: "" } }),
  ];
}

describe("personal Telegram adapter", () => {
  it.each([
    {
      responses: [
        response({ ok: false, error_code: 401 }, { httpStatus: 401 }),
      ],
      code: "token_rejected",
    },
    {
      responses: [
        response({ ok: false, error_code: 500 }, { httpStatus: 500 }),
      ],
      code: "bot_validation_failed",
    },
    {
      responses: [
        connectedResponses()[0]!,
        response({ ok: false, error_code: 500 }, { httpStatus: 500 }),
      ],
      code: "webhook_check_failed",
    },
    {
      responses: [connectedResponses()[0]!, response({ ok: true, result: {} })],
      code: "webhook_check_failed",
    },
    {
      responses: [
        connectedResponses()[0]!,
        response({ ok: false, error_code: 401 }, { httpStatus: 401 }),
      ],
      code: "token_rejected",
    },
  ])(
    "identifies the setup failure as $code without retaining a failed connection",
    async ({ responses, code }) => {
      const h = harness({ responses });
      await expect(h.controller.startPairing(token)).rejects.toMatchObject({
        code,
      });
      await expect(h.controller.status()).resolves.toEqual({
        kind: "disconnected",
      });
      expect(h.values.size).toBe(0);
    },
  );

  it("keeps the paired bot after a background restart and beyond the setup link lifetime", async () => {
    const first = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `/start ${nonce}`,
                chat: { id: 12345, type: "private" },
              },
            },
          ],
        }),
      ],
    });
    await first.controller.startPairing(token);
    await first.controller.confirmPairing();
    const restarted = harness({
      savedValues: first.values,
      responses: [response({ ok: true, result: { message_id: 1 } })],
    });
    restarted.advance(30 * 24 * 60 * 60 * 1000);
    await expect(restarted.controller.status()).resolves.toEqual({
      kind: "connected",
      botUsername: "MyPersonalBot",
    });
    expect(restarted.calls).toHaveLength(0);
    await restarted.controller.sendTest();
    expect(restarted.calls).toHaveLength(1);
    expect(restarted.calls[0]!.url.endsWith("/sendMessage")).toBe(true);
  });

  it("fails closed before every provider request when permission is denied", async () => {
    const h = harness({ checkPermission: async () => false });
    await expect(h.controller.startPairing(token)).rejects.toMatchObject({
      code: "permission_required",
    });
    expect(h.calls).toEqual([]);
  });

  it("does not fetch after revocation races a stale permission grant", async () => {
    let resolvePermission!: (granted: boolean) => void;
    const h = harness({
      checkPermission: () =>
        new Promise<boolean>((resolve) => {
          resolvePermission = resolve;
        }),
    });
    const pairing = h.controller.startPairing(token);
    await Promise.resolve();
    await h.controller.disconnect();
    resolvePermission(true);
    await expect(pairing).rejects.toMatchObject({ code: "cancelled" });
    expect(h.calls).toEqual([]);
  });

  it("bounds an unresponsive permission check without starting a provider request", async () => {
    const h = harness({
      checkPermission: () => new Promise<boolean>(() => undefined),
      timeoutTimerAt: 1,
    });
    await expect(h.controller.startPairing(token)).rejects.toMatchObject({
      code: "delivery_failed",
    });
    expect(h.calls).toEqual([]);
  });

  it("aborts generation-bound requests on disconnect or setup rotation", async () => {
    let firstSignal: AbortSignal | undefined;
    const h = harness({
      fetchOverride: (_url, init) => {
        firstSignal = init.signal;
        return new Promise<TelegramResponse>(() => undefined);
      },
    });
    const first = h.controller.startPairing(token);
    await Promise.resolve();
    await expect(h.controller.disconnect()).resolves.toBeUndefined();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    expect(firstSignal?.aborted).toBe(true);

    const next = h.controller.startPairing(token);
    await Promise.resolve();
    await expect(
      h.controller.startPairing("not-a-token"),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    await expect(next).rejects.toMatchObject({ code: "cancelled" });
  });

  it("pairs only one exact private-chat nonce and sends hostile event text as literal plain text", async () => {
    const h = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: -99, type: "group" },
              },
            },
            {
              message: {
                text: `/start ${nonce}`,
                chat: { id: 12345, type: "private" },
              },
            },
          ],
        }),
        response({ ok: true, result: { message_id: 1 } }),
        response({ ok: true, result: { message_id: 2 } }),
      ],
    });
    const pairing = await h.controller.startPairing(token);
    expect(pairing).toEqual({
      kind: "pairing",
      pairingCommand: `INVENTORY SIGNAL ${nonce}`,
      expiresAt: "2026-09-09T12:10:00.000Z",
      pairingUrl: `https://t.me/MyPersonalBot?start=${nonce}`,
    });
    await expect(h.controller.confirmPairing()).resolves.toEqual({
      kind: "connected",
      botUsername: "MyPersonalBot",
    });
    await expect(h.controller.confirmPairing()).rejects.toMatchObject({
      code: "pairing_pending",
    });
    await h.controller.sendStoredAvailable(event);
    expect(h.calls.at(-1)).toMatchObject({
      init: { method: "POST", redirect: "error" },
    });
    const sent = JSON.parse(h.calls.at(-1)!.init.body!);
    expect(sent).toEqual({
      chat_id: "12345",
      text: formatPersonalTelegramAvailability(event),
      link_preview_options: { is_disabled: true },
    });
    expect(sent).not.toHaveProperty("parse_mode");
    expect(sent).not.toHaveProperty("disable_web_page_preview");
    expect(sent.text).toContain(
      'iPhone <a href="https://evil.example/">Test</a> & Plus',
    );
    expect(sent.text).toContain("<b>Apple & Test</b> (store R123)");
    expect(sent.text).toContain(
      "https://www.apple.com/ca/shop/buy-iphone/iphone-17-pro",
    );
    await h.controller.sendTest();
    const testSent = JSON.parse(h.calls.at(-1)!.init.body!);
    expect(testSent).toEqual({
      chat_id: "12345",
      text: "Inventory Signal test\nPersonal Telegram alerts are connected.",
      link_preview_options: { is_disabled: true },
    });
    expect(testSent.text).not.toMatch(/<[A-Za-z/]/);
    expect(h.calls.every(({ url }) => url.includes(token))).toBe(true);
  });

  it("blocks bots with webhooks and never asks the API to delete one", async () => {
    const h = harness({
      responses: [
        response({ ok: true, result: { is_bot: true } }),
        response({
          ok: true,
          result: { url: "https://owner.example/telegram" },
        }),
      ],
    });
    await expect(h.controller.startPairing(token)).rejects.toMatchObject({
      code: "webhook_conflict",
    });
    expect(h.calls).toHaveLength(2);
    expect(h.calls.some(({ url }) => url.includes("deleteWebhook"))).toBe(
      false,
    );
    await expect(h.controller.status()).resolves.toEqual({
      kind: "disconnected",
    });
  });

  it("keeps the legacy pairing command when Telegram does not provide a usable bot username", async () => {
    const h = harness({
      responses: [
        response({ ok: true, result: { is_bot: true } }),
        response({ ok: true, result: { url: "" } }),
      ],
    });

    await expect(h.controller.startPairing(token)).resolves.toEqual({
      kind: "pairing",
      pairingCommand: `INVENTORY SIGNAL ${nonce}`,
      expiresAt: "2026-09-09T12:10:00.000Z",
    });
  });

  it("rejects wrong, group-only, malformed, replayed, expired, and ambiguous pairing updates", async () => {
    const h = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}x`,
                chat: { id: 1, type: "private" },
              },
            },
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: 9_007_199_254_740_992, type: "private" },
              },
            },
            { malformed: true },
          ],
        }),
      ],
    });
    await h.controller.startPairing(token);
    await expect(h.controller.confirmPairing()).rejects.toMatchObject({
      code: "pairing_pending",
    });

    const groups = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: 1, type: "group" },
              },
            },
          ],
        }),
      ],
    });
    await groups.controller.startPairing(token);
    await expect(groups.controller.confirmPairing()).rejects.toMatchObject({
      code: "pairing_pending",
    });

    const ambiguous = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: 1, type: "private" },
              },
            },
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: 2, type: "private" },
              },
            },
          ],
        }),
      ],
    });
    await ambiguous.controller.startPairing(token);
    await expect(ambiguous.controller.confirmPairing()).rejects.toMatchObject({
      code: "pairing_ambiguous",
    });

    const expired = harness({ responses: connectedResponses() });
    await expired.controller.startPairing(token);
    expired.advance(10 * 60 * 1_000);
    await expect(expired.controller.confirmPairing()).rejects.toMatchObject({
      code: "pairing_expired",
    });
    await expect(expired.controller.confirmPairing()).rejects.toMatchObject({
      code: "pairing_pending",
    });
  });

  it("retries only bounded transient failures, maps timeout/provider errors safely, and never follows redirects", async () => {
    const h = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: 12345, type: "private" },
              },
            },
          ],
        }),
        response({
          ok: false,
          error_code: 429,
          parameters: { retry_after: 15 },
        }),
      ],
    });
    await h.controller.startPairing(token);
    await h.controller.confirmPairing();
    await expect(h.controller.sendStoredAvailable(event)).resolves.toEqual({
      kind: "retry_not_before",
      retryNotBefore: "2026-09-09T12:00:15.000Z",
    });
    expect(h.clock.sleep).not.toHaveBeenCalled();

    const deferredAt31Seconds = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: 12345, type: "private" },
              },
            },
          ],
        }),
        response(
          {
            ok: false,
            error_code: 429,
          },
          { httpStatus: 429, retryAfterSeconds: "31" },
        ),
      ],
    });
    await deferredAt31Seconds.controller.startPairing(token);
    await deferredAt31Seconds.controller.confirmPairing();
    await expect(
      deferredAt31Seconds.controller.sendStoredAvailable(event),
    ).resolves.toEqual({
      kind: "retry_not_before",
      retryNotBefore: "2026-09-09T12:00:31.000Z",
    });
    expect(deferredAt31Seconds.clock.sleep).not.toHaveBeenCalled();

    const expiredDeferral = harness({
      responses: [
        response(
          {
            ok: false,
            error_code: 429,
            parameters: { retry_after: 601 },
          },
          { httpStatus: 429, retryAfterSeconds: "601" },
        ),
      ],
    });
    await expect(
      expiredDeferral.controller.sendAvailable(
        { botToken: token, chatId: "12345" },
        event,
      ),
    ).resolves.toEqual({ kind: "terminal" });
    expect(expiredDeferral.clock.sleep).not.toHaveBeenCalled();

    const malformedDeferral = harness({
      responses: [
        response({
          ok: false,
          error_code: 429,
          parameters: { retry_after: "not-a-delay" },
        }),
      ],
    });
    await expect(
      malformedDeferral.controller.sendAvailable(
        { botToken: token, chatId: "12345" },
        event,
      ),
    ).resolves.toEqual({ kind: "terminal" });

    const serverFailure = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: 12345, type: "private" },
              },
            },
          ],
        }),
        response({ ok: false, error_code: 500 }, { httpStatus: 500 }),
        response({ ok: false, error_code: 500 }),
      ],
    });
    await serverFailure.controller.startPairing(token);
    await serverFailure.controller.confirmPairing();
    await expect(serverFailure.controller.sendTest()).rejects.toMatchObject({
      code: "delivery_failed",
    });
    expect(serverFailure.clock.sleep).toHaveBeenCalledTimes(1);
    expect(serverFailure.clock.sleep).toHaveBeenCalledWith(250);

    const falsePositive = harness({
      responses: [
        response({ ok: true, result: { message_id: 1 } }, { httpStatus: 500 }),
      ],
    });
    await expect(
      falsePositive.controller.sendAvailable(
        { botToken: token, chatId: "12345" },
        event,
      ),
    ).rejects.toMatchObject({ code: "delivery_failed" });

    const timeout = harness({
      timeoutTimerAt: 4,
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: 12345, type: "private" },
              },
            },
          ],
        }),
      ],
      fetchOverride: (_url, init, callCount) => {
        if (callCount !== 4) return undefined;
        expect(init.signal.aborted).toBe(false);
        return new Promise<TelegramResponse>(() => undefined);
      },
    });
    await timeout.controller.startPairing(token);
    await timeout.controller.confirmPairing();
    await expect(timeout.controller.sendTest()).rejects.toMatchObject({
      code: "delivery_failed",
    });
    expect(timeout.calls).toHaveLength(4);

    let startedFetch: (() => void) | undefined;
    const callerAbort = new AbortController();
    const callerCancelled = harness({
      fetchOverride: (_url, init, callCount) => {
        if (callCount !== 1) return undefined;
        startedFetch = () => undefined;
        expect(init.signal.aborted).toBe(false);
        return new Promise<TelegramResponse>(() => undefined);
      },
    });
    const cancelledDelivery = callerCancelled.controller.sendAvailable(
      { botToken: token, chatId: "12345" },
      event,
      { signal: callerAbort.signal },
    );
    await vi.waitFor(() => expect(startedFetch).toBeTypeOf("function"));
    callerAbort.abort();
    await expect(cancelledDelivery).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(callerCancelled.calls).toHaveLength(1);
    expect(callerCancelled.calls[0].init.signal.aborted).toBe(true);

    const redirect = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: 12345, type: "private" },
              },
            },
          ],
        }),
        response(
          { ok: true, result: true },
          { redirected: true, url: "https://evil.example/" },
        ),
      ],
    });
    await redirect.controller.startPairing(token);
    await redirect.controller.confirmPairing();
    await expect(redirect.controller.sendTest()).rejects.toMatchObject({
      code: "delivery_failed",
    });
  });

  it("keeps an existing destination during rotation and invalidates in-flight work on disconnect", async () => {
    const h = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: 12345, type: "private" },
              },
            },
          ],
        }),
      ],
    });
    await h.controller.startPairing(token);
    await h.controller.confirmPairing();
    // Rotate after a live connection: failure to pair must not erase active credentials.
    await expect(h.controller.startPairing(rotatedToken)).rejects.toMatchObject(
      {
        code: "bot_validation_failed",
      },
    );
    await expect(h.controller.status()).resolves.toMatchObject({
      kind: "connected",
    });

    let releaseFirstSetup: ((value: TelegramResponse) => void) | undefined;
    const racingRotation = harness({
      responses: [
        response({ ok: true, result: { is_bot: true, username: "NewBot" } }),
        response({ ok: true, result: { url: "" } }),
      ],
      fetchOverride: (url) => {
        if (!url.includes(`/bot${token}/getMe`)) return undefined;
        return new Promise<TelegramResponse>((resolve) => {
          releaseFirstSetup = resolve;
        });
      },
    });
    const staleSetup = racingRotation.controller.startPairing(token);
    await vi.waitFor(() => expect(releaseFirstSetup).toBeTypeOf("function"));
    await racingRotation.controller.startPairing(rotatedToken);
    releaseFirstSetup?.(
      response({ ok: true, result: { is_bot: true, username: "OldBot" } }),
    );
    await expect(staleSetup).rejects.toMatchObject({ code: "cancelled" });
    await expect(racingRotation.controller.status()).resolves.toMatchObject({
      kind: "pairing",
    });
    const storedRace = racingRotation.values.get(
      PERSONAL_TELEGRAM_STORAGE_KEY,
    ) as { pending?: { botToken?: string } };
    expect(storedRace.pending?.botToken).toBe(rotatedToken);

    let releaseOldConfirmation: ((value: TelegramResponse) => void) | undefined;
    const confirmationRotation = harness({
      responses: [
        ...connectedResponses(),
        response({ ok: true, result: { is_bot: true, username: "NewBot" } }),
        response({ ok: true, result: { url: "" } }),
      ],
      fetchOverride: (url) => {
        if (!url.includes(`/bot${token}/getUpdates`)) return undefined;
        return new Promise<TelegramResponse>((resolve) => {
          releaseOldConfirmation = resolve;
        });
      },
    });
    await confirmationRotation.controller.startPairing(token);
    const oldConfirmation = confirmationRotation.controller.confirmPairing();
    await vi.waitFor(() =>
      expect(releaseOldConfirmation).toBeTypeOf("function"),
    );
    await confirmationRotation.controller.startPairing(rotatedToken);
    releaseOldConfirmation?.(
      response({
        ok: true,
        result: [
          {
            message: {
              text: `INVENTORY SIGNAL ${nonce}`,
              chat: { id: 12345, type: "private" },
            },
          },
        ],
      }),
    );
    await expect(oldConfirmation).rejects.toMatchObject({ code: "cancelled" });
    const storedConfirmation = confirmationRotation.values.get(
      PERSONAL_TELEGRAM_STORAGE_KEY,
    ) as { pending?: { botToken?: string } };
    expect(storedConfirmation.pending?.botToken).toBe(rotatedToken);

    let releaseFetch: (() => void) | undefined;
    let holdSend = false;
    const inflight = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            {
              message: {
                text: `INVENTORY SIGNAL ${nonce}`,
                chat: { id: 12345, type: "private" },
              },
            },
          ],
        }),
      ],
      fetchOverride: (_url, _init, callCount) => {
        if (!holdSend || callCount < 4) return undefined;
        return new Promise<TelegramResponse>((resolve) => {
          releaseFetch = () => resolve(response({ ok: true, result: true }));
        });
      },
    });
    await inflight.controller.startPairing(token);
    await inflight.controller.confirmPairing();
    holdSend = true;
    const delivery = inflight.controller.sendStoredAvailable(event);
    await vi.waitFor(() => expect(releaseFetch).toBeTypeOf("function"));
    expect(releaseFetch).toBeTypeOf("function");
    await inflight.controller.disconnect();
    releaseFetch?.();
    await expect(delivery).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      inflight.controller.sendStoredAvailable(event),
    ).rejects.toMatchObject({
      code: "not_connected",
    });
  });

  it("fails closed for unsupported targets, bad events, and storage errors without surfacing tokens", async () => {
    const unsupported = harness({ supported: false });
    await expect(
      unsupported.controller.startPairing(token),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(() =>
      formatPersonalTelegramAvailability({
        ...event,
        purchaseUrl: "https://evil.example/",
      }),
    ).toThrow(PersonalTelegramError);
    expect(() =>
      formatPersonalTelegramAvailability({
        ...event,
        purchaseUrl:
          "https://www.apple.com:444/ca/shop/buy-iphone/iphone-17-pro",
      }),
    ).toThrow(PersonalTelegramError);
    const storage = harness({
      storageFailure: true,
      responses: connectedResponses(),
    });
    await expect(storage.controller.startPairing(token)).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    try {
      await storage.controller.startPairing(token);
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
    const malformed = harness({ responses: [response({ ok: true })] });
    await expect(
      malformed.controller.startPairing(token),
    ).rejects.toMatchObject({ code: "delivery_failed" });
    storage.values.set(PERSONAL_TELEGRAM_STORAGE_KEY, {
      version: 1,
      active: { botToken: token, chatId: "-9" },
    });
    await expect(storage.controller.status()).resolves.toEqual({
      kind: "disconnected",
    });
    storage.values.set(PERSONAL_TELEGRAM_STORAGE_KEY, {
      version: 1,
      active: { botToken: token, chatId: "9007199254740992" },
    });
    await expect(storage.controller.status()).resolves.toEqual({
      kind: "disconnected",
    });
  });
});

describe("simple token setup", () => {
  const privateUpdates = (ids: number[]) =>
    response({
      ok: true,
      result: ids.map((id) => ({
        message: { text: "hello", chat: { id, type: "private" } },
      })),
    });
  const sent = () => response({ ok: true, result: { message_id: 1 } });

  it("saves without pairing or expiry, discovers one private chat on test, and survives restart", async () => {
    const h = harness({
      responses: [
        ...connectedResponses(),
        privateUpdates([12345, 12345]),
        sent(),
      ],
    });
    expect(await h.controller.saveToken!(token)).toEqual({
      kind: "token_saved",
      botUsername: "MyPersonalBot",
    });
    expect(h.calls).toHaveLength(2);
    expect(
      JSON.stringify(h.values.get(PERSONAL_TELEGRAM_STORAGE_KEY)),
    ).not.toMatch(/nonce|expiresAt/);
    h.advance(365 * 24 * 60 * 60 * 1000);
    await h.controller.sendTest();
    expect(JSON.parse(h.calls[3]!.init.body!).chat_id).toBe("12345");
    expect(
      await harness({ savedValues: h.values }).controller.status(),
    ).toEqual({ kind: "connected", botUsername: "MyPersonalBot" });
    expect(JSON.stringify(await h.controller.status())).not.toContain(token);
  });

  it.each([
    [[], "chat_not_found"],
    [[12345, 67890], "chat_ambiguous"],
  ] as const)(
    "does not send or enable alerts for missing or ambiguous chats %j",
    async (ids, code) => {
      const h = harness({
        responses: [...connectedResponses(), privateUpdates([...ids])],
      });
      await h.controller.saveToken!(token);
      await expect(h.controller.sendTest()).rejects.toMatchObject({ code });
      expect(h.calls).toHaveLength(3);
      expect((await h.controller.status()).kind).toBe("token_saved");
      await expect(
        h.controller.sendStoredAvailable(event),
      ).rejects.toMatchObject({ code: "not_connected" });
    },
  );

  it("ignores group chats and malformed IDs", async () => {
    const h = harness({
      responses: [
        ...connectedResponses(),
        response({
          ok: true,
          result: [
            { message: { chat: { type: "group", id: -12345 } } },
            { message: { chat: { type: "private", id: "oops" } } },
          ],
        }),
      ],
    });
    await h.controller.saveToken!(token);
    await expect(h.controller.sendTest()).rejects.toMatchObject({
      code: "chat_not_found",
    });
    expect(h.calls).toHaveLength(3);
  });

  it("reuses the saved chat for the same token without update discovery", async () => {
    const values = new Map<string, unknown>([
      [
        PERSONAL_TELEGRAM_STORAGE_KEY,
        {
          version: 1,
          active: { botToken: token, chatId: "12345" },
          botUsername: "MyPersonalBot",
        },
      ],
    ]);
    const h = harness({
      savedValues: values,
      responses: [...connectedResponses(), sent()],
    });
    expect((await h.controller.saveToken!(token)).kind).toBe("connected");
    await h.controller.sendTest();
    expect(h.calls.some((call) => call.url.includes("getUpdates"))).toBe(false);
  });

  it("keeps setup saved when Telegram rejects the test", async () => {
    const h = harness({
      responses: [
        ...connectedResponses(),
        privateUpdates([12345]),
        response({ ok: false, error_code: 403 }, { httpStatus: 403 }),
      ],
    });
    await h.controller.saveToken!(token);
    await expect(h.controller.sendTest()).rejects.toMatchObject({
      code: "delivery_failed",
    });
    expect((await h.controller.status()).kind).toBe("token_saved");
  });

  it("converts unfinished legacy pairing through a test even after its old expiry", async () => {
    const values = new Map<string, unknown>([
      [
        PERSONAL_TELEGRAM_STORAGE_KEY,
        {
          version: 1,
          pending: {
            botToken: token,
            nonce,
            expiresAtMs: 1,
            botUsername: "MyPersonalBot",
          },
        },
      ],
    ]);
    const h = harness({
      savedValues: values,
      responses: [privateUpdates([12345]), sent()],
    });
    await h.controller.sendTest();
    expect((await h.controller.status()).kind).toBe("connected");
  });
});

describe("simple setup cancellation", () => {
  it("does not reconnect or send when disconnected during chat discovery", async () => {
    let finish!: (value: TelegramResponse) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = harness({
      responses: connectedResponses(),
      fetchOverride: (url) => {
        if (url.includes("getUpdates")) {
          started();
          return new Promise<TelegramResponse>((resolve) => {
            finish = resolve;
          });
        }
      },
    });
    await h.controller.saveToken!(token);
    const test = h.controller.sendTest();
    const rejected = expect(test).rejects.toMatchObject({ code: "cancelled" });
    await startedPromise;
    await h.controller.disconnect();
    finish(
      response({
        ok: true,
        result: [
          { message: { text: "hello", chat: { type: "private", id: 12345 } } },
        ],
      }),
    );
    await rejected;
    expect(h.values.size).toBe(0);
    expect(h.calls.some((call) => call.url.includes("sendMessage"))).toBe(
      false,
    );
  });
});
