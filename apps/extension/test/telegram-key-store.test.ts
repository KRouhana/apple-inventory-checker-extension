import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { createIndexedDbTelegramKeyStore } from "../src/storage/telegram-key-store.js";
import { createEncryptedTelegramStorage } from "../src/storage/telegram-secrets.js";
import { PERSONAL_TELEGRAM_STORAGE_KEY } from "../src/notifications/telegram.js";

const crypto = webcrypto as unknown as Crypto;
const generate = () =>
  crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);

describe("IndexedDB Telegram key persistence", () => {
  it("persists a non-extractable key across store connections and deletes it", async () => {
    const factory = new IDBFactory();
    const first = createIndexedDbTelegramKeyStore(factory);
    expect(await first.read()).toBeNull();
    const key = await first.create(await generate());
    const next = createIndexedDbTelegramKeyStore(factory);
    const restored = await next.read();
    expect(restored?.extractable).toBe(false);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode("synthetic"),
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      restored!,
      encrypted,
    );
    expect(new TextDecoder().decode(plain)).toBe("synthetic");
    await expect(crypto.subtle.exportKey("raw", restored!)).rejects.toThrow();
    await next.remove();
    expect(await first.read()).toBeNull();
  });
  it("rejects a malformed existing database schema without hanging", async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("inventory-signal-telegram-keys", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
    const store = createIndexedDbTelegramKeyStore(factory);
    await expect(store.read()).rejects.toThrow(
      "Secret key storage unavailable",
    );
    await expect(store.create(await generate())).rejects.toThrow(
      "Secret key storage unavailable",
    );
    await expect(store.remove()).rejects.toThrow(
      "Secret key storage unavailable",
    );
  });
  it("keeps one winning key when two contexts create concurrently", async () => {
    const factory = new IDBFactory();
    const first = createIndexedDbTelegramKeyStore(factory);
    const second = createIndexedDbTelegramKeyStore(factory);
    const candidates = await Promise.all([generate(), generate()]);
    const [a, b] = await Promise.all([
      first.create(candidates[0]),
      second.create(candidates[1]),
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      a,
      new Uint8Array([1, 2, 3]),
    );
    expect([
      ...new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv }, b, encrypted),
      ),
    ]).toEqual([1, 2, 3]);
  });
  it("decrypts credentials after both adapter and IndexedDB connection restart", async () => {
    const factory = new IDBFactory();
    const values = new Map<string, unknown>();
    const storage = {
      read: async (key: string) => structuredClone(values.get(key) ?? null),
      write: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
      remove: async (key: string) => {
        values.delete(key);
      },
    };
    const open = () =>
      createEncryptedTelegramStorage({
        storage,
        keys: createIndexedDbTelegramKeyStore(factory),
        ready: Promise.resolve(true),
        crypto,
      });
    const synthetic = {
      version: 1,
      pending: { botToken: "synthetic-token", nonce: "synthetic-nonce" },
    };
    await open().write(PERSONAL_TELEGRAM_STORAGE_KEY, synthetic);
    await expect(open().read(PERSONAL_TELEGRAM_STORAGE_KEY)).resolves.toEqual(
      synthetic,
    );
    await open().remove(PERSONAL_TELEGRAM_STORAGE_KEY);
    await expect(
      open().read(PERSONAL_TELEGRAM_STORAGE_KEY),
    ).resolves.toBeNull();
    expect(await createIndexedDbTelegramKeyStore(factory).read()).toBeNull();
  });
});
