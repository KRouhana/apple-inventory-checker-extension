import { callExtensionApi, callExtensionVoid } from "./async";
import type { ExtensionApi } from "./api";
import { isSafeApplePurchaseUrl } from "../protocol";

export type ExtensionTarget = "chrome" | "firefox" | "safari";

export interface ExtensionCapabilities {
  readonly background: "service-worker" | "event-page";
  readonly desktopNotifications: "browser-api" | "native-wrapper-required";
  readonly optionalTelegramHostPermission: boolean;
}

export interface ExtensionPlatform {
  readonly target: ExtensionTarget;
  readonly capabilities: ExtensionCapabilities;
  readonly storage: {
    read<T>(key: string): Promise<T | null>;
    write(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
  readonly alarms: {
    schedulePeriodic(name: string, intervalSeconds: number): void;
    scheduleOnce(name: string, delayMilliseconds: number): void;
    cancel(name: string): Promise<boolean>;
    onWake(listener: (name: string) => void): void;
  };
  readonly notifications: {
    capability(): ExtensionCapabilities["desktopNotifications"];
    permissionState(): Promise<"granted" | "denied" | "unsupported">;
    notify(id: string, title: string, message: string): Promise<void>;
  };
  readonly permissions: {
    requestTelegramHostPermission(): Promise<boolean>;
    hasTelegramPermission(): Promise<boolean>;
    onTelegramPermissionRemoved(listener: () => void): void;
  };
  readonly tabs: {
    openApplePurchase(url: string): Promise<void>;
  };
}

const TELEGRAM_ORIGIN = "https://api.telegram.org/*";
const TELEGRAM_DATA_COLLECTION = [
  "authenticationInfo",
  "personallyIdentifyingInfo",
  "personalCommunications",
];
const NOTIFICATION_ICON_PATH = "icons/inventory-signal.png";

function isApplePurchaseUrl(value: string): boolean {
  return isSafeApplePurchaseUrl(value);
}

function targetCapabilities(target: ExtensionTarget): ExtensionCapabilities {
  if (target === "firefox") {
    return {
      background: "event-page",
      desktopNotifications: "browser-api",
      optionalTelegramHostPermission: true,
    };
  }
  if (target === "safari") {
    return {
      background: "service-worker",
      desktopNotifications: "native-wrapper-required",
      // Safari's wrapper and optional-host request behavior have not yet been
      // qualified. Do not advertise a personal Telegram path until L11 proves
      // a target-specific implementation.
      optionalTelegramHostPermission: false,
    };
  }
  return {
    background: "service-worker",
    desktopNotifications: "browser-api",
    optionalTelegramHostPermission: true,
  };
}

function minimumAlarmMinutes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Alarm interval must be a positive finite number");
  }
  return Math.max(value / 60, 1 / 60);
}

export function createExtensionPlatform(
  api: ExtensionApi,
  target: ExtensionTarget,
): ExtensionPlatform {
  const capabilities = targetCapabilities(target);
  const alarms = api.alarms;

  return {
    target,
    capabilities,
    storage: {
      async read<T>(key: string) {
        const values = await callExtensionApi<Record<string, unknown>>(
          api.runtime,
          (callback, usePromiseApi) =>
            usePromiseApi
              ? api.storage.local.get(key)
              : api.storage.local.get(key, callback),
        );
        return (values[key] as T | undefined) ?? null;
      },
      write(key: string, value: unknown) {
        return callExtensionVoid(api.runtime, (callback, usePromiseApi) =>
          usePromiseApi
            ? api.storage.local.set({ [key]: value })
            : api.storage.local.set({ [key]: value }, callback),
        );
      },
      remove(key: string) {
        return callExtensionVoid(api.runtime, (callback, usePromiseApi) =>
          usePromiseApi
            ? api.storage.local.remove(key)
            : api.storage.local.remove(key, callback),
        );
      },
    },
    alarms: {
      schedulePeriodic(name: string, intervalSeconds: number) {
        if (!alarms) throw new Error("Alarms are unavailable in this browser");
        alarms.create(name, {
          delayInMinutes: minimumAlarmMinutes(intervalSeconds),
          periodInMinutes: minimumAlarmMinutes(intervalSeconds),
        });
      },
      scheduleOnce(name: string, delayMilliseconds: number) {
        if (!alarms) throw new Error("Alarms are unavailable in this browser");
        alarms.create(name, {
          delayInMinutes: minimumAlarmMinutes(delayMilliseconds / 1000),
        });
      },
      cancel(name: string) {
        if (!alarms) return Promise.resolve(false);
        return callExtensionApi<boolean>(
          api.runtime,
          (callback, usePromiseApi) =>
            usePromiseApi ? alarms.clear(name) : alarms.clear(name, callback),
        );
      },
      onWake(listener: (name: string) => void) {
        if (!alarms) throw new Error("Alarms are unavailable in this browser");
        alarms.onAlarm.addListener((alarm) => listener(alarm.name));
      },
    },
    notifications: {
      capability: () => capabilities.desktopNotifications,
      async permissionState() {
        if (capabilities.desktopNotifications !== "browser-api") {
          return "unsupported";
        }
        const notifications = api.notifications;
        if (!notifications?.getPermissionLevel) return "unsupported";
        return callExtensionApi<"granted" | "denied">(
          api.runtime,
          (callback, usePromiseApi) =>
            usePromiseApi
              ? notifications.getPermissionLevel?.()
              : notifications.getPermissionLevel?.(callback),
        );
      },
      async notify(id: string, title: string, message: string) {
        if (capabilities.desktopNotifications !== "browser-api") {
          throw new Error(
            "Desktop notifications require a qualified native wrapper",
          );
        }
        const notifications = api.notifications;
        if (!notifications) throw new Error("Notifications are unavailable");
        await callExtensionVoid(api.runtime, (callback, usePromiseApi) =>
          usePromiseApi
            ? notifications.create(id, {
                type: "basic",
                iconUrl: api.runtime.getURL(NOTIFICATION_ICON_PATH),
                title,
                message,
              })
            : notifications.create(
                id,
                {
                  type: "basic",
                  iconUrl: api.runtime.getURL(NOTIFICATION_ICON_PATH),
                  title,
                  message,
                },
                callback,
              ),
        );
      },
    },
    permissions: {
      async requestTelegramHostPermission() {
        if (!api.permissions || !capabilities.optionalTelegramHostPermission) {
          return false;
        }
        const details =
          target === "firefox"
            ? {
                origins: [TELEGRAM_ORIGIN],
                data_collection: TELEGRAM_DATA_COLLECTION,
              }
            : { origins: [TELEGRAM_ORIGIN] };
        return callExtensionApi<boolean>(
          api.runtime,
          (callback, usePromiseApi) =>
            usePromiseApi
              ? api.permissions?.request(details)
              : api.permissions?.request(details, callback),
        );
      },
      async hasTelegramPermission() {
        const permissions = api.permissions;
        const getAll = permissions?.getAll;
        if (!getAll || !capabilities.optionalTelegramHostPermission) {
          return false;
        }
        try {
          const granted = await callExtensionApi<{
            origins?: string[];
            data_collection?: string[];
          }>(api.runtime, (callback, usePromiseApi) =>
            usePromiseApi ? getAll() : getAll(callback),
          );
          if (!granted.origins?.includes(TELEGRAM_ORIGIN)) return false;
          return (
            target !== "firefox" ||
            TELEGRAM_DATA_COLLECTION.every((permission) =>
              granted.data_collection?.includes(permission),
            )
          );
        } catch {
          return false;
        }
      },
      onTelegramPermissionRemoved(listener) {
        if (
          !api.permissions?.onRemoved ||
          !capabilities.optionalTelegramHostPermission
        ) {
          return;
        }
        api.permissions.onRemoved.addListener((removed) => {
          const originRemoved = removed.origins?.includes(TELEGRAM_ORIGIN);
          const dataRemoved =
            target === "firefox" &&
            TELEGRAM_DATA_COLLECTION.some((permission) =>
              removed.data_collection?.includes(permission),
            );
          if (originRemoved || dataRemoved) listener();
        });
      },
    },
    tabs: {
      async openApplePurchase(url: string) {
        if (!isApplePurchaseUrl(url)) {
          throw new Error(
            "Only canonical HTTPS www.apple.com regional product URLs may be opened",
          );
        }
        await callExtensionVoid(api.runtime, (callback, usePromiseApi) =>
          usePromiseApi
            ? api.tabs.create({ url })
            : api.tabs.create({ url }, callback),
        );
      },
    },
  };
}

export function isAllowedApplePurchaseUrl(value: string): boolean {
  return isApplePurchaseUrl(value);
}
