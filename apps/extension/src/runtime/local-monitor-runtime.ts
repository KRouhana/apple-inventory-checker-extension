/**
 * Explicit assembly for the local monitor background. Browser entrypoints own
 * this composition; engine/core/UI remain independently testable contracts.
 */
import {
  LocalMonitorEngine,
  type PickupParseDiagnostic,
} from "../monitor/local-monitor-engine.js";
import type { LocalWatch } from "../../../../packages/core/src/local-monitor-contracts.js";
import { createLocalAppleHandoffEventFactory } from "../handoff/local-apple-handoff.js";
import { createPersonalTelegramController } from "../notifications/telegram.js";
import { createSafariNativeDesktopAlertPort } from "../notifications/safari-native.js";
import {
  createExtensionPlatform,
  type ExtensionPlatform,
} from "../platform/adapters.js";
import type { ExtensionApi } from "../platform/api.js";
import { installLocalMonitorMessageHandler } from "../platform/monitor-messages.js";
import { installPopupMonitorSummaryMessageHandler } from "../platform/popup-summary-messages.js";
import { installDesktopDiagnosticMessageHandler } from "../platform/desktop-diagnostic-messages.js";
import { installPersonalTelegramMessageHandler } from "../platform/telegram-messages.js";
import {
  createEncryptedTelegramStorage,
  restrictLocalStorage,
} from "../storage/telegram-secrets.js";
import { createIndexedDbTelegramKeyStore } from "../storage/telegram-key-store.js";
import { ValidatedLocalMonitorStorage } from "../storage/local-monitor-storage.js";
import {
  createDesktopAlertService,
  createRuntimeDeliveryDispatcher,
  openCurrentAvailableAtApple,
  resolveCurrentAvailabilityEvent,
} from "./delivery.js";
import {
  createApplePickupFetchPort,
  type PickupDiagnostic,
} from "./apple-pickup-fetch.js";
import {
  createBundledRuntimeCatalog,
  type LocalRuntimeCatalog,
} from "./catalog.js";
import { createAppleStoreLookupProvider } from "./apple-store-lookup.js";
import { BrowserMonitorScheduler } from "./scheduler.js";
import { createTelegramFetchPort } from "./telegram-fetch.js";
import type { ExtensionTarget } from "../platform/adapters.js";

export interface LocalMonitorRuntime {
  readonly engine: LocalMonitorEngine;
  readonly catalog: LocalRuntimeCatalog;
  readonly platform: ExtensionPlatform;
  /** Resolves after bundled-catalog and desktop-ledger bootstrap. */
  readonly ready: Promise<void>;
}

/**
 * A browser worker may evaluate an entrypoint more than once through test
 * harnesses or overlapping wake plumbing. One API/target pair owns exactly
 * one engine, listener set, and bootstrap promise for that worker lifetime.
 */
const installedRuntimes = new WeakMap<
  ExtensionApi,
  Map<ExtensionTarget, LocalMonitorRuntime>
>();

const POPUP_SUMMARY_READINESS_TIMEOUT_MS = 2_000;

/** Chrome may use its browser-managed Apple session; other targets stay omit. */
export function applePickupCredentialsForTarget(
  target: ExtensionTarget,
): "omit" | "include" {
  return target === "chrome" ? "include" : "omit";
}

async function awaitPopupSummaryReadiness(
  initialization: Promise<void> | null,
): Promise<void> {
  if (initialization === null) {
    throw new Error("Local monitor runtime is not initialized");
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      initialization,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Local monitor summary readiness timed out")),
          POPUP_SUMMARY_READINESS_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Build and install exactly one local runtime. There is no server registration
 * or cloud transport in this path. A missing bundled catalog leaves monitor
 * commands reachable but stock checks explicitly unknown/unsupported.
 */
export function installLocalMonitorRuntime(options: {
  api: ExtensionApi;
  target: ExtensionTarget;
  /** Test/approved future composition seam; never a user-controlled catalog. */
  catalog?: LocalRuntimeCatalog;
}): LocalMonitorRuntime {
  const existing = installedRuntimes.get(options.api)?.get(options.target);
  if (existing) return existing;
  const platform = createExtensionPlatform(options.api, options.target);
  const applePickupCredentials = applePickupCredentialsForTarget(
    options.target,
  );
  let bundledCatalog: LocalRuntimeCatalog | null = null;
  const catalog =
    options.catalog ??
    (options.target === "chrome"
      ? () => {
          const storeLookup = createAppleStoreLookupProvider({
            fetch: createApplePickupFetchPort({
              credentials: applePickupCredentials,
            }),
            getCatalog: () => bundledCatalog?.getCatalog() ?? null,
          });
          bundledCatalog = createBundledRuntimeCatalog(
            platform,
            options.api.runtime.getURL.bind(options.api.runtime),
            storeLookup,
          );
          return bundledCatalog;
        }
      : () =>
          createBundledRuntimeCatalog(
            platform,
            options.api.runtime.getURL.bind(options.api.runtime),
          ))();

  const storage = new ValidatedLocalMonitorStorage({
    get: (key) => platform.storage.read(key),
    set: (key, value) => platform.storage.write(key, value),
  });
  const scheduler = new BrowserMonitorScheduler(
    platform.alarms,
    options.target,
  );
  let engine: LocalMonitorEngine | null = null;
  let initialization: Promise<void> | null = null;
  const engineSnapshot = {
    getSnapshot: async () => {
      await initialization;
      if (!engine) throw new Error("Local monitor runtime is not initialized");
      return engine.getSnapshot();
    },
  };
  const desktop = createDesktopAlertService({
    api: options.api,
    platform,
    engine: engineSnapshot,
    catalog,
    native:
      options.target === "safari"
        ? createSafariNativeDesktopAlertPort(options.api)
        : undefined,
  });
  const telegramStorage = createEncryptedTelegramStorage({
    storage: platform.storage,
    keys: createIndexedDbTelegramKeyStore(),
    ready: restrictLocalStorage(options.api),
  });
  const personalTelegram = createPersonalTelegramController({
    storage: telegramStorage,
    fetchPort: createTelegramFetchPort(),
    // This must not request optional permission: only a visible UI gesture is
    // allowed to do that. Existing local configuration can be retried safely.
    isSupported: () => platform.capabilities.optionalTelegramHostPermission,
    // A saved pairing is not proof that optional permission remains granted.
    // The controller performs this check immediately before each provider call.
    checkPermission: () => platform.permissions.hasTelegramPermission(),
  });
  // The app protocol and disconnect share this queue. A disconnect cannot be
  // overwritten by a stale page-supplied full watch revision, and a write
  // that starts after disconnect is fail-closed unless setup is connected.
  let telegramWatchMutationTail: Promise<void> = Promise.resolve();
  const serializeTelegramWatchMutation = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const scheduled = telegramWatchMutationTail.then(operation);
    telegramWatchMutationTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };
  const gateTelegramChannel = async (
    watch: LocalWatch,
  ): Promise<LocalWatch> => {
    let connected = false;
    try {
      connected = (await personalTelegram.status()).kind === "connected";
    } catch {
      // Storage trouble cannot authorize a channel write.
    }
    return connected
      ? watch
      : {
          ...watch,
          deliveryChannels: {
            ...watch.deliveryChannels,
            personalTelegram: false,
          },
        };
  };
  const revokeTelegramPermission = async (): Promise<void> => {
    // Advancing the controller generation aborts best-effort in-flight work.
    // It cannot recall a provider message already accepted before revocation.
    await personalTelegram.disconnect().catch(() => undefined);
    await initialization;
    await serializeTelegramWatchMutation(() =>
      engine!.disablePersonalTelegramForAllWatches(),
    ).catch(() => undefined);
  };
  const handoffEvents = createLocalAppleHandoffEventFactory({
    getCatalog: () => catalog.getCatalog(),
  });
  const dispatcher = createRuntimeDeliveryDispatcher({
    desktop,
    personalTelegram,
    resolveCurrentEvent: (event) =>
      resolveCurrentAvailabilityEvent({
        engine: engineSnapshot,
        catalog,
        eventFactory: handoffEvents,
        event,
      }),
  });
  // This is intentionally worker-lifetime only: it is neither persisted nor
  // used by availability, retries, watches, or delivery decisions.
  let latestPickupDiagnostic: PickupDiagnostic | null = null;
  let latestPickupParseDiagnostic: PickupParseDiagnostic | null = null;
  engine = new LocalMonitorEngine({
    clock: { now: () => Date.now() },
    storage,
    scheduler,
    fetch: createApplePickupFetchPort({
      credentials: applePickupCredentials,
      onDiagnostic: (diagnostic) => {
        latestPickupDiagnostic = diagnostic;
      },
    }),
    onPickupParseDiagnostic: (diagnostic) => {
      latestPickupParseDiagnostic = diagnostic;
    },
    catalog,
    eventFactory: handoffEvents,
    deliveryDispatcher: dispatcher,
  });
  scheduler.installWakeListener(() => {
    void initialization?.then(() => engine?.wake());
  });
  if (options.target === "safari") desktop.installNativeClickHandler();
  else desktop.installClickHandler();

  // The checkout bridge is intentionally separate from the extension-owned
  // monitor protocol. Its listener ignores foreign protocols before sender
  // checks, so it cannot race the monitor response.
  installLocalMonitorMessageHandler(options.api.runtime, {
    // All incoming monitor commands wait for the same bounded initialization
    // sequence. Listeners themselves were registered synchronously above, so
    // an MV3/event-page cold wake cannot lose an alarm, click, or app request.
    engine: {
      start: async () => {
        await initialization;
        return engine!.start();
      },
      wake: async () => {
        await initialization;
        return engine!.wake();
      },
      checkNow: async (watchIds) => {
        await initialization;
        return engine!.checkNow(watchIds);
      },
      getSnapshot: async () => {
        await initialization;
        return engine!.getSnapshot();
      },
      addWatch: async (watch) => {
        await initialization;
        return serializeTelegramWatchMutation(async () =>
          engine!.addWatch(await gateTelegramChannel(watch)),
        );
      },
      replaceWatch: async (watch) => {
        await initialization;
        return serializeTelegramWatchMutation(async () =>
          engine!.replaceWatch(await gateTelegramChannel(watch)),
        );
      },
      setWatchEnabled: async (id, enabled) => {
        await initialization;
        return serializeTelegramWatchMutation(() =>
          engine!.setWatchEnabled(id, enabled),
        );
      },
      deleteWatch: async (id) => {
        await initialization;
        return serializeTelegramWatchMutation(() => engine!.deleteWatch(id));
      },
      reset: async () => {
        await initialization;
        return engine!.reset();
      },
    },
    getCatalog: async () => {
      await initialization;
      return catalog.getCatalog();
    },
    getPickupDiagnostic: () => latestPickupDiagnostic,
    getPickupParseDiagnostic: () => latestPickupParseDiagnostic,
    lookupStores: async (input) => {
      await initialization;
      return catalog.lookupStores(input);
    },
    capabilities: async () => {
      await initialization;
      return {
        monitor: true,
        catalog: catalog.getCatalog() !== null,
        storeLookup: catalog.storeLookupAvailable(),
        personalTelegram: platform.capabilities.optionalTelegramHostPermission,
        hostedRelay: false,
        ...(catalog.getCatalog() === null
          ? { reason: "A validated bundled catalog is unavailable." }
          : !catalog.storeLookupAvailable()
            ? {
                reason:
                  "Nearby-store lookup is unavailable until public Apple store anchors are qualified.",
              }
            : {}),
      };
    },
    openAvailableAtApple: async (input) =>
      openCurrentAvailableAtApple({
        engine: engineSnapshot,
        catalog,
        eventFactory: handoffEvents,
        platform,
        input,
      }),
  });
  // This popup-only protocol exposes watch display and validated Apple handoff. It
  // is registered before asynchronous bootstrap so a cold popup wake cannot
  // miss the request, but fails unavailable after a short readiness window.
  installPopupMonitorSummaryMessageHandler(options.api.runtime, {
    getSnapshot: async () => {
      await awaitPopupSummaryReadiness(initialization);
      if (!engine) throw new Error("Local monitor runtime is not initialized");
      return engine.getSnapshot();
    },
    getCatalog: async () => {
      await awaitPopupSummaryReadiness(initialization);
      return catalog.getCatalog();
    },
    checkNow: async (watchIds) => {
      await awaitPopupSummaryReadiness(initialization);
      if (!engine) throw new Error("Local monitor runtime is not initialized");
      return engine.checkNow(watchIds);
    },
    openAvailableAtApple: async (input) =>
      openCurrentAvailableAtApple({
        engine: engineSnapshot,
        catalog,
        eventFactory: handoffEvents,
        platform,
        input,
      }),
  });
  installDesktopDiagnosticMessageHandler(options.api.runtime, desktop);
  installPersonalTelegramMessageHandler(options.api.runtime, {
    // This is the same epoch/CAS controller used by the delivery dispatcher.
    // A second instance could let a stale queued delivery outlive disconnect.
    controller: personalTelegram,
    supported: () => platform.capabilities.optionalTelegramHostPermission,
    disableTelegramWatches: async () => {
      await initialization;
      await serializeTelegramWatchMutation(() =>
        engine!.disablePersonalTelegramForAllWatches(),
      );
    },
  });
  platform.permissions.onTelegramPermissionRemoved(() => {
    void revokeTelegramPermission();
  });

  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const runtime = { engine, catalog, platform, ready };
  // Register before starting catalog work so even a synchronous test/future
  // fetch hook cannot recursively create another listener/engine set.
  const byTarget = installedRuntimes.get(options.api) ?? new Map();
  byTarget.set(options.target, runtime);
  installedRuntimes.set(options.api, byTarget);

  // This promise is deliberately created only after every cold-wake listener
  // exists. It does not await the first engine cycle: a startup delivery may
  // need DesktopAlertService's validator, which itself reads the engine after
  // catalog/bootstrap readiness. Awaiting that cycle here would self-deadlock.
  initialization = (async () => {
    await catalog.loadBundled();
    await desktop.start().catch(() => undefined);
  })().then(
    () => undefined,
    () => undefined,
  );
  // Startup reconciliation is deliberately detached from readiness. Engine
  // single-flight semantics handle an alarm or app command that arrives first.
  void initialization.then(resolveReady, resolveReady);
  void initialization.then(() => engine!.start());
  return runtime;
}
