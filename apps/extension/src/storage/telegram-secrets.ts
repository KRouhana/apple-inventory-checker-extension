import type { ExtensionApi } from "../platform/api.js";
import { callExtensionVoid } from "../platform/async.js";
import {
  PERSONAL_TELEGRAM_STORAGE_KEY,
  type TelegramStoragePort,
} from "../notifications/telegram.js";
import type { TelegramKeyStore } from "./telegram-key-store.js";

export const TELEGRAM_ENCRYPTED_STORAGE_KEY = `${PERSONAL_TELEGRAM_STORAGE_KEY}.encrypted`;
const aad = new TextEncoder().encode(TELEGRAM_ENCRYPTED_STORAGE_KEY);
const MAX_CIPHERTEXT_BYTES = 16_384;
interface Envelope {
  version: 1;
  iv: number[];
  ciphertext: number[];
}

/** Start immediately; errors are retained without an unhandled rejection. */
export function restrictLocalStorage(api: ExtensionApi): Promise<boolean> {
  return callExtensionVoid(api.runtime, (callback, promiseApi) => {
    if (!api.storage.local.setAccessLevel)
      throw new Error("Storage restriction unavailable");
    const details = { accessLevel: "TRUSTED_CONTEXTS" as const };
    return promiseApi
      ? api.storage.local.setAccessLevel(details)
      : api.storage.local.setAccessLevel(details, callback);
  }).then(
    () => true,
    () => false,
  );
}

function bytes(value: unknown, max: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= max &&
    value.every(
      (entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255,
    )
  );
}
function envelope(value: unknown): Envelope {
  if (!value || typeof value !== "object")
    throw new Error("Secret storage unavailable");
  const data = value as Partial<Envelope>;
  if (
    data.version !== 1 ||
    !bytes(data.iv, 12) ||
    data.iv.length !== 12 ||
    !bytes(data.ciphertext, MAX_CIPHERTEXT_BYTES) ||
    data.ciphertext.length < 16
  )
    throw new Error("Secret storage unavailable");
  return data as Envelope;
}
function validKey(key: CryptoKey): CryptoKey {
  if (
    !key ||
    key.type !== "secret" ||
    key.extractable ||
    key.algorithm.name !== "AES-GCM" ||
    (key.algorithm as AesKeyAlgorithm).length !== 256 ||
    !key.usages.includes("encrypt") ||
    !key.usages.includes("decrypt")
  )
    throw new Error("Secret key unavailable");
  return key;
}

/**
 * One background-owned adapter serializes encrypted reads, writes and removal.
 * Only ciphertext is saved in chrome.storage.local; the non-extractable key is
 * persisted separately in extension IndexedDB. This does not protect against
 * malicious extension code or a compromised local browser profile.
 */
export function createEncryptedTelegramStorage(options: {
  storage: TelegramStoragePort;
  keys: TelegramKeyStore;
  ready: Promise<boolean>;
  crypto?: Crypto;
}): TelegramStoragePort {
  const cryptography = options.crypto ?? globalThis.crypto;
  let tail: Promise<unknown> = Promise.resolve();
  function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      if (key !== PERSONAL_TELEGRAM_STORAGE_KEY || !(await options.ready))
        throw new Error("Secret storage unavailable");
      try {
        return await action();
      } catch {
        throw new Error("Secret storage unavailable");
      }
    });
    tail = result.catch(() => undefined);
    return result;
  }
  async function decrypt(stored: unknown): Promise<unknown> {
    const data = envelope(stored);
    const key = await options.keys.read();
    if (!key) throw new Error("Secret key unavailable");
    const plaintext = await cryptography.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(data.iv), additionalData: aad },
      validKey(key),
      new Uint8Array(data.ciphertext),
    );
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
  }
  async function persist(value: unknown): Promise<void> {
    let key = await options.keys.read();
    if (!key)
      key = await options.keys.create(
        await cryptography.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    const plaintext = JSON.stringify(value);
    if (plaintext === undefined) throw new Error("Invalid secret state");
    const encoded = new TextEncoder().encode(plaintext);
    if (encoded.length > MAX_CIPHERTEXT_BYTES - 16)
      throw new Error("Invalid secret state");
    const iv = cryptography.getRandomValues(new Uint8Array(12));
    const encrypted = await cryptography.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      validKey(key),
      encoded,
    );
    const next: Envelope = {
      version: 1,
      iv: [...iv],
      ciphertext: [...new Uint8Array(encrypted)],
    };
    await options.storage.write(TELEGRAM_ENCRYPTED_STORAGE_KEY, next);
    const verified = await decrypt(
      await options.storage.read(TELEGRAM_ENCRYPTED_STORAGE_KEY),
    );
    if (JSON.stringify(verified) !== plaintext)
      throw new Error("Secret verification failed");
  }
  async function readState(): Promise<unknown | null> {
    const stored = await options.storage.read(TELEGRAM_ENCRYPTED_STORAGE_KEY);
    if (stored !== null && stored !== undefined) {
      const state = await decrypt(stored);
      // A prior worker may have stopped after verification but before cleanup.
      await options.storage.remove(PERSONAL_TELEGRAM_STORAGE_KEY);
      return state;
    }
    const legacy = await options.storage.read(PERSONAL_TELEGRAM_STORAGE_KEY);
    if (legacy === null || legacy === undefined) return null;
    await persist(legacy);
    await options.storage.remove(PERSONAL_TELEGRAM_STORAGE_KEY);
    return legacy;
  }
  return {
    read: (key) => serialized(key, readState),
    write: (key, value) =>
      serialized(key, async () => {
        // Never overwrite undecipherable existing credentials or silently rekey.
        const existing = await options.storage.read(
          TELEGRAM_ENCRYPTED_STORAGE_KEY,
        );
        if (existing !== null && existing !== undefined)
          await decrypt(existing);
        await persist(value);
        await options.storage.remove(PERSONAL_TELEGRAM_STORAGE_KEY);
      }),
    remove: (key) =>
      serialized(key, async () => {
        // Explicit disconnect is the only destructive path; reads never reset.
        await options.storage.remove(TELEGRAM_ENCRYPTED_STORAGE_KEY);
        await options.storage.remove(PERSONAL_TELEGRAM_STORAGE_KEY);
        await options.keys.remove();
      }),
  };
}
