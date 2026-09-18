/**
 * Versioned snapshot persistence for the local monitor.
 *
 * Browser adapters provide the small key/value bridge. This module never
 * accepts raw postal input, credentials, upstream bodies, or provider error
 * text, and it validates every snapshot before it crosses the persistence
 * boundary.
 */
import {
  createEmptySnapshot,
  LEGACY_MIN_LOCAL_POLL_INTERVAL_SEC,
  LOCAL_MONITOR_STORAGE_KEY,
  MIN_LOCAL_POLL_INTERVAL_SEC,
  parseLocalMonitorSnapshot,
  type LocalMonitorSnapshot,
  type LocalStoragePort,
} from "../../../../packages/core/src/local-monitor-contracts.js";

export interface LocalSnapshotKeyValuePort {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
}

export type SnapshotLoadResult =
  | { kind: "missing"; snapshot: LocalMonitorSnapshot }
  | { kind: "loaded"; snapshot: LocalMonitorSnapshot }
  | { kind: "migrated"; snapshot: LocalMonitorSnapshot }
  | { kind: "recovered_corrupt"; snapshot: LocalMonitorSnapshot };

/**
 * Raises only finite whole-second intervals that were valid under the v1
 * policy. The caller still strict-validates the entire resulting snapshot, so
 * a malformed watch or unrelated state cannot be silently repaired into a
 * trusted snapshot.
 */
function migrateLegacyPollIntervals(input: unknown): unknown | null {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !Array.isArray((input as { watches?: unknown }).watches)
  ) {
    return null;
  }

  const hasLegacyInterval = (input as { watches: unknown[] }).watches.some(
    (watch) => {
      if (typeof watch !== "object" || watch === null || Array.isArray(watch))
        return false;
      const interval = (watch as { pollIntervalSec?: unknown }).pollIntervalSec;
      return (
        typeof interval === "number" &&
        Number.isFinite(interval) &&
        Number.isInteger(interval) &&
        interval >= LEGACY_MIN_LOCAL_POLL_INTERVAL_SEC &&
        interval < MIN_LOCAL_POLL_INTERVAL_SEC
      );
    },
  );
  if (!hasLegacyInterval) return null;

  try {
    const migrated = structuredClone(input) as { watches: unknown[] };
    for (const watch of migrated.watches) {
      if (typeof watch !== "object" || watch === null || Array.isArray(watch))
        continue;
      const interval = (watch as { pollIntervalSec?: unknown }).pollIntervalSec;
      if (
        typeof interval === "number" &&
        Number.isFinite(interval) &&
        Number.isInteger(interval) &&
        interval >= LEGACY_MIN_LOCAL_POLL_INTERVAL_SEC &&
        interval < MIN_LOCAL_POLL_INTERVAL_SEC
      ) {
        (watch as { pollIntervalSec: number }).pollIntervalSec =
          MIN_LOCAL_POLL_INTERVAL_SEC;
      }
    }
    return migrated;
  } catch {
    return null;
  }
}

/**
 * Safe, deliberately small export for local backup/debug UI. Pending delivery
 * payloads are excluded because they are transient delivery work, not user
 * configuration/history. The remaining contract has no secrets or raw
 * location input by construction.
 */
export interface LocalMonitorSafeExport {
  version: LocalMonitorSnapshot["version"];
  watches: LocalMonitorSnapshot["watches"];
  items: LocalMonitorSnapshot["items"];
  delivery: LocalMonitorSnapshot["delivery"];
  history: LocalMonitorSnapshot["history"];
}

export function createSafeMonitorExport(
  snapshot: LocalMonitorSnapshot,
): LocalMonitorSafeExport {
  return {
    version: snapshot.version,
    watches: structuredClone(snapshot.watches),
    items: structuredClone(snapshot.items),
    delivery: structuredClone(snapshot.delivery),
    history: structuredClone(snapshot.history),
  };
}

/**
 * Contract-validating storage facade. An unknown or malformed persisted value
 * is treated as a corrupt local cache and recovers to an empty snapshot. It is
 * intentionally not overwritten during `load`: callers may surface recovery
 * state first, and a later successful mutation performs the explicit reset.
 */
export class ValidatedLocalMonitorStorage implements LocalStoragePort {
  public constructor(private readonly keyValue: LocalSnapshotKeyValuePort) {}

  public async loadWithRecovery(): Promise<SnapshotLoadResult> {
    const persisted = await this.keyValue.get(LOCAL_MONITOR_STORAGE_KEY);
    if (persisted === null) {
      return { kind: "missing", snapshot: createEmptySnapshot() };
    }
    const parsed = parseLocalMonitorSnapshot(persisted);
    if (parsed.success) return { kind: "loaded", snapshot: parsed.data };

    const migrated = migrateLegacyPollIntervals(persisted);
    if (migrated !== null) {
      const reparsed = parseLocalMonitorSnapshot(migrated);
      if (reparsed.success) {
        // This is a policy migration of known-good v1 state, not corrupt-cache
        // recovery: preserve items, history, delivery state, and any future
        // valid fields while making the stricter interval durable.
        await this.keyValue.set(LOCAL_MONITOR_STORAGE_KEY, reparsed.data);
        return { kind: "migrated", snapshot: reparsed.data };
      }
    }
    return { kind: "recovered_corrupt", snapshot: createEmptySnapshot() };
  }

  public async load(): Promise<LocalMonitorSnapshot | null> {
    const result = await this.loadWithRecovery();
    return result.kind === "missing" ? null : result.snapshot;
  }

  public async save(snapshot: LocalMonitorSnapshot): Promise<void> {
    const parsed = parseLocalMonitorSnapshot(snapshot);
    if (!parsed.success) {
      throw new Error("Refusing to persist an invalid local-monitor snapshot");
    }
    await this.keyValue.set(LOCAL_MONITOR_STORAGE_KEY, parsed.data);
  }

  public async reset(): Promise<void> {
    await this.save(createEmptySnapshot());
  }
}
