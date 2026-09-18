import type { ExtensionRuntime } from "./api";

type Callback<T> = (value: T) => void;

export async function callExtensionApi<T>(
  runtime: ExtensionRuntime,
  invoke: (callback: Callback<T>, usePromiseApi: boolean) => unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      const message = runtime.lastError?.message;
      if (message) reject(new Error(message));
      else resolve(value);
    };

    try {
      const usePromiseApi =
        typeof (globalThis as { browser?: unknown }).browser !== "undefined";
      const result = invoke(finish, usePromiseApi);
      if (result && typeof (result as PromiseLike<T>).then === "function") {
        void (result as PromiseLike<T>).then(finish, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

export async function callExtensionVoid(
  runtime: ExtensionRuntime,
  invoke: (callback: () => void, usePromiseApi: boolean) => unknown,
): Promise<void> {
  await callExtensionApi<void>(runtime, (callback, usePromiseApi) =>
    invoke(() => callback(), usePromiseApi),
  );
}
