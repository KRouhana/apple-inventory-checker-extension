import type {
  TelegramFetchPort,
  TelegramResponse,
} from "../notifications/telegram.js";

const TELEGRAM_ORIGIN = "https://api.telegram.org";
const BOT_PATH =
  /^\/bot\d{5,20}:[A-Za-z0-9_-]{20,256}\/(getMe|getWebhookInfo|getUpdates|sendMessage)$/;

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value || !/^\d{1,6}$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function allowedTelegramUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === TELEGRAM_ORIGIN &&
      url.hostname === "api.telegram.org" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.hash === "" &&
      BOT_PATH.test(url.pathname) &&
      (url.search === "" || url.search === "?timeout=0&limit=100")
    );
  } catch {
    return false;
  }
}

/** Cookie-free, exact-origin adapter; it intentionally never logs URLs. */
export function createTelegramFetchPort(): TelegramFetchPort {
  return {
    async fetch(url, init): Promise<TelegramResponse> {
      if (!allowedTelegramUrl(url)) throw new Error("Telegram URL denied");
      const response = await globalThis.fetch(url, {
        method: init.method,
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body === undefined ? {} : { body: init.body }),
        credentials: "omit",
        cache: "no-store",
        redirect: init.redirect,
        referrerPolicy: "no-referrer",
        signal: init.signal,
      });
      return {
        httpStatus: response.status,
        redirected: response.redirected,
        url: response.url,
        ...(retryAfterSeconds(response.headers.get("retry-after")) === undefined
          ? {}
          : {
              retryAfterSeconds: retryAfterSeconds(
                response.headers.get("retry-after"),
              ),
            }),
        json: () => response.json(),
      };
    },
  };
}
