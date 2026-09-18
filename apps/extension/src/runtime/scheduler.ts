import {
  MIN_LOCAL_POLL_INTERVAL_SEC,
  type LocalSchedulerPort,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import type {
  ExtensionPlatform,
  ExtensionTarget,
} from "../platform/adapters.js";

const PERIODIC_ALARM = "inventory-signal.local-monitor.periodic";
const WAKE_ALARM = "inventory-signal.local-monitor.wake";

/** Bridges the engine's small scheduler contract to named browser alarms. */
export class BrowserMonitorScheduler implements LocalSchedulerPort {
  private wakeListener: (() => void) | null = null;
  private installed = false;
  private periodicIntervalSec: number | null = null;
  private oneShotDelayMs: number | null = null;
  private revision = 0;
  private reconciliation: Promise<void> = Promise.resolve();

  public constructor(
    private readonly alarms: ExtensionPlatform["alarms"],
    private readonly target: ExtensionTarget,
  ) {}

  public schedulePeriodic(intervalSec: number): void {
    this.periodicIntervalSec = intervalSec;
    this.scheduleReconciliation();
  }

  public scheduleOneShot(delayMs: number): void {
    this.oneShotDelayMs = delayMs;
    this.scheduleReconciliation();
  }

  public cancelAll(): void {
    this.periodicIntervalSec = null;
    this.oneShotDelayMs = null;
    this.scheduleReconciliation();
  }

  public installWakeListener(listener: () => void): void {
    this.wakeListener = listener;
    if (this.installed) return;
    this.installed = true;
    this.alarms.onWake((name) => {
      if (name !== PERIODIC_ALARM && name !== WAKE_ALARM) return;
      // Browser worker wakes are best-effort. Engine serialization/backoff is
      // the source of truth; no unbounded timer or catch-up loop lives here.
      void this.wakeListener?.();
    });
  }

  private minimumWakeDelayMs(): number {
    // Chrome permits a 30-second production alarm cadence. Firefox and Safari
    // have not been qualified below one minute in this release. These are
    // lower bounds only: browser/OS power policy can deliver a wake later.
    return this.target === "chrome" ? 30_000 : 60_000;
  }

  private scheduleReconciliation(): void {
    this.revision += 1;
    this.reconciliation = this.reconciliation.then(
      () => this.reconcileAlarms(),
      () => this.reconcileAlarms(),
    );
  }

  /**
   * `alarms.clear` is asynchronous in both browser API styles. Serializing a
   * full clear/recreate transaction prevents an older clear promise from
   * deleting an alarm that a newer engine refresh has already recreated.
   */
  private async reconcileAlarms(): Promise<void> {
    while (true) {
      const observedRevision = this.revision;
      await Promise.allSettled([
        this.alarms.cancel(PERIODIC_ALARM),
        this.alarms.cancel(WAKE_ALARM),
      ]);
      // A later state change arrived while clear was in flight. Never create
      // an obsolete alarm; loop and apply the newest desired state only.
      if (observedRevision !== this.revision) continue;
      if (this.periodicIntervalSec !== null) {
        this.alarms.schedulePeriodic(
          PERIODIC_ALARM,
          Math.max(
            this.periodicIntervalSec,
            MIN_LOCAL_POLL_INTERVAL_SEC,
            this.minimumWakeDelayMs() / 1_000,
          ),
        );
      }
      if (this.oneShotDelayMs !== null) {
        this.alarms.scheduleOnce(
          WAKE_ALARM,
          Math.max(this.oneShotDelayMs, this.minimumWakeDelayMs()),
        );
      }
      return;
    }
  }
}

export const LOCAL_MONITOR_ALARM_NAMES = {
  periodic: PERIODIC_ALARM,
  wake: WAKE_ALARM,
} as const;
