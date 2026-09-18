/** Local application encryption, not an OS-backed credential vault. */
export interface TelegramKeyStore {
  read(): Promise<CryptoKey | null>;
  /** Atomically keep the existing key if another opener already created it. */
  create(key: CryptoKey): Promise<CryptoKey>;
  remove(): Promise<void>;
}

export function createIndexedDbTelegramKeyStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): TelegramKeyStore {
  const database = "inventory-signal-telegram-keys";
  const store = "keys";
  const keyId = "aes-gcm-v1";
  function transact<T>(
    mode: IDBTransactionMode,
    action: (table: IDBObjectStore, result: (value: T) => void) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!factory) {
        reject(new Error("Secret key storage unavailable"));
        return;
      }
      let failed = false;
      const fail = () => {
        failed = true;
        reject(new Error("Secret key storage unavailable"));
      };
      let opening: IDBOpenDBRequest;
      try {
        opening = factory.open(database, 1);
      } catch {
        fail();
        return;
      }
      opening.onupgradeneeded = () => {
        if (failed) {
          opening.transaction?.abort();
          return;
        }
        try {
          opening.result.createObjectStore(store);
        } catch {
          opening.transaction?.abort();
          fail();
        }
      };
      opening.onerror = opening.onblocked = fail;
      opening.onsuccess = () => {
        const db = opening.result;
        if (failed) {
          db.close();
          return;
        }
        db.onversionchange = () => db.close();
        let value: T;
        let tx: IDBTransaction;
        try {
          tx = db.transaction(store, mode);
        } catch {
          db.close();
          fail();
          return;
        }
        tx.oncomplete = () => {
          db.close();
          resolve(value);
        };
        tx.onabort = tx.onerror = () => {
          db.close();
          fail();
        };
        try {
          action(tx.objectStore(store), (result) => {
            value = result;
          });
        } catch {
          tx.abort();
        }
      };
    });
  }
  return {
    read: () =>
      transact<CryptoKey | null>("readonly", (table, result) => {
        const request = table.get(keyId);
        request.onsuccess = () =>
          result((request.result as CryptoKey | undefined) ?? null);
      }),
    create: (key) =>
      transact<CryptoKey>("readwrite", (table, result) => {
        const request = table.get(keyId);
        request.onsuccess = () => {
          if (request.result !== undefined) result(request.result as CryptoKey);
          else {
            table.add(key, keyId);
            result(key);
          }
        };
      }),
    remove: () =>
      transact<void>("readwrite", (table, result) => {
        table.delete(keyId);
        result(undefined);
      }),
  };
}
