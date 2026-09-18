/**
 * The small cross-browser surface used by extension code.  It intentionally
 * omits fetch, cookies, scripting and arbitrary tab inspection APIs.
 */
export interface ExtensionMessageSender {
  id?: string;
  url?: string;
  origin?: string;
  /** Present for a message from a tab frame; the extension app must be top-level. */
  frameId?: number;
  tab?: { id?: number; url?: string };
}

export interface ExtensionRuntime {
  onInstalled?: {
    addListener(listener: (details: { reason: string }) => void): void;
  };
  id?: string;
  lastError?: { message?: string };
  getURL(path: string): string;
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: ExtensionMessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean | void,
    ): void;
  };
  sendMessage(
    message: unknown,
    callback?: (response: unknown) => void,
  ): unknown;
  /** Safari routes this fixed-target message only to its containing app. */
  sendNativeMessage?(
    application: string,
    message: unknown,
    callback?: (response: unknown) => void,
  ): unknown;
  /** Safari-only app-to-extension port; never used by Chrome or Firefox. */
  connectNative?(application: string): ExtensionNativePort;
}

export interface ExtensionNativePort {
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  readonly onDisconnect?: {
    addListener(listener: () => void): void;
  };
  disconnect?(): void;
}

export interface ExtensionStorageArea {
  setAccessLevel?(
    details: { accessLevel: "TRUSTED_CONTEXTS" },
    callback?: () => void,
  ): unknown;
  get(
    keys: string | string[],
    callback?: (items: Record<string, unknown>) => void,
  ): unknown;
  set(items: Record<string, unknown>, callback?: () => void): unknown;
  remove(keys: string | string[], callback?: () => void): unknown;
}

export interface ExtensionAlarms {
  create(
    name: string,
    details: { delayInMinutes?: number; periodInMinutes?: number },
  ): void;
  clear(name: string, callback?: (wasCleared: boolean) => void): unknown;
  onAlarm: {
    addListener(listener: (alarm: { name: string }) => void): void;
  };
}

export interface ExtensionNotifications {
  getPermissionLevel?(
    callback?: (level: "granted" | "denied") => void,
  ): unknown;
  create(
    id: string,
    options: {
      type: "basic";
      iconUrl: string;
      title: string;
      message: string;
    },
    callback?: () => void,
  ): unknown;
  onClicked?: {
    addListener(listener: (notificationId: string) => void): void;
  };
}

/** MV3 toolbar action. It is optional because the Safari native bridge owns
 * its own badge surface until that bridge has been qualified. */
export interface ExtensionAction {
  setBadgeText(details: { text: string }, callback?: () => void): unknown;
}

export interface ExtensionPermissions {
  getAll?(
    callback?: (details: {
      origins?: string[];
      data_collection?: string[];
    }) => void,
  ): unknown;
  request(
    details: { origins?: string[]; data_collection?: string[] },
    callback?: (granted: boolean) => void,
  ): unknown;
  onRemoved?: {
    addListener(
      listener: (details: {
        origins?: string[];
        data_collection?: string[];
      }) => void,
    ): void;
  };
}

export interface ExtensionTabs {
  create(properties: { url: string }, callback?: () => void): unknown;
}

export interface ExtensionApi {
  runtime: ExtensionRuntime;
  storage: { local: ExtensionStorageArea };
  alarms?: ExtensionAlarms;
  notifications?: ExtensionNotifications;
  action?: ExtensionAction;
  permissions?: ExtensionPermissions;
  tabs: ExtensionTabs;
}

export function getExtensionApi(): ExtensionApi {
  const candidate =
    (
      globalThis as typeof globalThis & {
        browser?: unknown;
        chrome?: unknown;
      }
    ).browser ??
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome;

  if (!candidate || typeof candidate !== "object") {
    throw new Error("Extension APIs are unavailable in this context");
  }
  return candidate as ExtensionApi;
}
