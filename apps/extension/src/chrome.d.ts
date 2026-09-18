interface ChromeMessageSender {
  tab?: { id?: number };
}

interface ChromeRuntime {
  lastError?: { message?: string };
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: ChromeMessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean | void,
    ): void;
  };
  sendMessage(message: unknown, callback?: (response: unknown) => void): void;
}

interface ChromeStorageArea {
  get(
    keys: string | string[],
    callback: (items: Record<string, unknown>) => void,
  ): void;
  set(items: Record<string, unknown>, callback?: () => void): void;
  remove(keys: string | string[], callback?: () => void): void;
}

interface ChromeTabs {
  create(properties: { url: string }, callback?: () => void): void;
}

declare const chrome: {
  runtime: ChromeRuntime;
  storage: { local: ChromeStorageArea };
  tabs: ChromeTabs;
};
