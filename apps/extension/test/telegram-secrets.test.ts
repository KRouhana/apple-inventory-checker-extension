import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import {
  createEncryptedTelegramStorage,
  restrictLocalStorage,
  TELEGRAM_ENCRYPTED_STORAGE_KEY,
} from "../src/storage/telegram-secrets.js";
import { PERSONAL_TELEGRAM_STORAGE_KEY as legacyKey } from "../src/notifications/telegram.js";
import type { TelegramKeyStore } from "../src/storage/telegram-key-store.js";
import type { ExtensionApi } from "../src/platform/api.js";

const crypto = webcrypto as unknown as Crypto;
const state = {
  version: 1,
  active: { botToken: "synthetic-only-test-token", chatId: "12345" },
};
function harness() {
  const values = new Map<string, unknown>();
  let key: CryptoKey | null = null;
  const keys: TelegramKeyStore = {
    read: async () => key,
    create: async (candidate) => (key ??= candidate),
    remove: async () => {
      key = null;
    },
  };
  const raw = {
    read: async (name: string) => structuredClone(values.get(name) ?? null),
    write: async (name: string, value: unknown) => {
      values.set(name, structuredClone(value));
    },
    remove: async (name: string) => {
      values.delete(name);
    },
  };
  const create = (ready = Promise.resolve(true)) =>
    createEncryptedTelegramStorage({
      storage: raw,
      keys,
      crypto,
      ready,
    });
  return {
    values,
    keys,
    raw,
    create,
    get key() {
      return key;
    },
    loseKey() {
      key = null;
    },
  };
}

describe("persistent encrypted Telegram storage", () => {
  it("stores no plaintext and survives a new worker adapter; every write gets a fresh IV", async () => {
    const h = harness();
    const storage = h.create();
    await storage.write(legacyKey, state);
    const first = structuredClone(h.values.get(TELEGRAM_ENCRYPTED_STORAGE_KEY));
    expect(JSON.stringify([...h.values])).not.toContain(state.active.botToken);
    expect(JSON.stringify([...h.values])).not.toContain(state.active.chatId);
    expect(h.values.has(legacyKey)).toBe(false);
    expect(h.key?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", h.key!)).rejects.toThrow();
    await expect(h.create().read(legacyKey)).resolves.toEqual(state);
    await storage.write(legacyKey, state);
    expect(h.values.get(TELEGRAM_ENCRYPTED_STORAGE_KEY)).not.toEqual(first);
  });

  it("migrates raw state only after encrypted readback and cleanup survives restart", async () => {
    const h = harness();
    h.values.set(legacyKey, state);
    const originalRead = h.raw.read;
    let verified = false;
    h.raw.read = async (key) => {
      const result = await originalRead(key);
      if (key === TELEGRAM_ENCRYPTED_STORAGE_KEY && result !== null)
        verified = true;
      return result;
    };
    const originalRemove = h.raw.remove;
    h.raw.remove = async (key) => {
      if (key === legacyKey) expect(verified).toBe(true);
      await originalRemove(key);
    };
    await expect(h.create().read(legacyKey)).resolves.toEqual(state);
    expect(h.values.has(legacyKey)).toBe(false);
    await expect(h.create().read(legacyKey)).resolves.toEqual(state);
  });

  it("keeps plaintext intact when encrypted write or readback fails", async () => {
    for (const phase of ["write", "readback"]) {
      const h = harness();
      h.values.set(legacyKey, state);
      if (phase === "write")
        h.raw.write = async () => {
          throw new Error("disk full");
        };
      else {
        const original = h.raw.read;
        h.raw.read = async (key) =>
          key === TELEGRAM_ENCRYPTED_STORAGE_KEY && h.values.has(key)
            ? { version: 1, iv: [0], ciphertext: [1] }
            : original(key);
      }
      await expect(h.create().read(legacyKey)).rejects.toThrow(
        "Secret storage unavailable",
      );
      expect(h.values.get(legacyKey)).toEqual(state);
    }
  });

  it("fails closed for tampering or lost key, including writes, without deleting state", async () => {
    for (const failure of ["tamper", "key"]) {
      const h = harness();
      await h.create().write(legacyKey, state);
      if (failure === "key") h.loseKey();
      else {
        const encrypted = h.values.get(TELEGRAM_ENCRYPTED_STORAGE_KEY) as {
          ciphertext: number[];
        };
        encrypted.ciphertext[0] ^= 1;
      }
      const before = structuredClone([...h.values]);
      const restart = h.create();
      await expect(restart.read(legacyKey)).rejects.toThrow(
        "Secret storage unavailable",
      );
      await expect(restart.write(legacyKey, state)).rejects.toThrow(
        "Secret storage unavailable",
      );
      expect([...h.values]).toEqual(before);
      if (failure === "key") expect(h.key).toBeNull();
    }
  });

  it("serializes pending write then disconnect and creates a new key when reconnected", async () => {
    const h = harness();
    const storage = h.create();
    const write = storage.write(legacyKey, state);
    const read = storage.read(legacyKey);
    const disconnect = storage.remove(legacyKey);
    await write;
    const oldKey = h.key;
    await expect(read).resolves.toEqual(state);
    await disconnect;
    expect(h.values.size).toBe(0);
    expect(h.key).toBeNull();
    await expect(h.create().read(legacyKey)).resolves.toBeNull();
    await storage.write(legacyKey, state);
    expect(h.key).not.toBe(oldKey);
    await expect(h.create().read(legacyKey)).resolves.toEqual(state);
  });

  it("does no storage/key work until access is restricted and fails closed when denied", async () => {
    const h = harness();
    let release!: (allowed: boolean) => void;
    const storage = h.create(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    const attempt = storage.write(legacyKey, state);
    await Promise.resolve();
    expect(h.values.size).toBe(0);
    expect(h.key).toBeNull();
    release(false);
    await expect(attempt).rejects.toThrow("Secret storage unavailable");
    expect(h.values.size).toBe(0);
    expect(h.key).toBeNull();
  });

  it("redacts underlying storage errors even if they contain credential text", async () => {
    const h = harness();
    h.raw.read = async () => {
      throw new Error(state.active.botToken);
    };
    await expect(h.create().read(legacyKey)).rejects.toThrow(
      /^Secret storage unavailable$/,
    );
  });

  it("rejects unrelated storage keys", async () => {
    const h = harness();
    await expect(h.create().write("unrelated", state)).rejects.toThrow();
    expect(h.values.size).toBe(0);
  });
});

describe("trusted-context restriction", () => {
  it("requests only TRUSTED_CONTEXTS and supports callback completion", async () => {
    let received: unknown;
    const api = {
      runtime: {},
      storage: {
        local: {
          setAccessLevel: (details: unknown, callback: () => void) => {
            received = details;
            callback();
          },
        },
      },
    } as unknown as ExtensionApi;
    await expect(restrictLocalStorage(api)).resolves.toBe(true);
    expect(received).toEqual({ accessLevel: "TRUSTED_CONTEXTS" });
  });
  it("fails closed for unavailable or rejected restriction APIs", async () => {
    const api = {
      runtime: {},
      storage: { local: {} },
    } as unknown as ExtensionApi;
    await expect(restrictLocalStorage(api)).resolves.toBe(false);
    api.storage.local.setAccessLevel = () =>
      Promise.reject(new Error("not allowed"));
    await expect(restrictLocalStorage(api)).resolves.toBe(false);
  });
});

it("persists unfinished token setup encrypted across worker restarts", async () => {
  const h = harness();
  const setup = {
    version: 1,
    setup: {
      botToken: "synthetic-unfinished-token",
      botUsername: "SyntheticBot",
    },
  };
  await h.create().write(legacyKey, setup);
  expect(JSON.stringify([...h.values])).not.toContain(setup.setup.botToken);
  await expect(h.create().read(legacyKey)).resolves.toEqual(setup);
  await h.create().remove(legacyKey);
  await expect(h.create().read(legacyKey)).resolves.toBeNull();
});
