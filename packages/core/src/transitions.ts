import type { AvailabilityStatus } from "./availability.js";

export const DEFAULT_ALERT_COOLDOWN_MS = 30 * 60 * 1_000;

export type AvailabilityTransitionReason =
  | "initial_available"
  | "became_available"
  | "remained_available"
  | "recovered_available_without_new_stock"
  | "not_available"
  | "cooldown_active";

export type KnownAvailabilityStatus = Exclude<AvailabilityStatus, "unknown">;

export interface AvailabilityTransitionInput {
  previousStatus: AvailabilityStatus | null;
  /**
   * Last non-unknown status before this observation. Callers must preserve it
   * across unknown polls so an outage cannot create a duplicate or hide stock.
   */
  lastKnownStatus: KnownAvailabilityStatus | null;
  currentStatus: AvailabilityStatus;
  now: Date | number;
  lastAlertedAt?: Date | number | null;
  cooldownMs?: number;
}

export interface AvailabilityTransitionDecision {
  shouldAlert: boolean;
  reason: AvailabilityTransitionReason;
  transitioned: boolean;
}

function timestamp(value: Date | number): number {
  const result = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(result)) {
    throw new Error("Transition timestamps must be finite");
  }
  return result;
}

export function evaluateAvailabilityTransition(
  input: AvailabilityTransitionInput,
): AvailabilityTransitionDecision {
  const now = timestamp(input.now);
  const cooldownMs = input.cooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new Error("cooldownMs must be a non-negative finite number");
  }

  const transitioned = input.previousStatus !== input.currentStatus;
  if (input.currentStatus !== "available") {
    return { shouldAlert: false, reason: "not_available", transitioned };
  }
  const availabilityBaseline =
    input.previousStatus === "unknown"
      ? input.lastKnownStatus
      : input.previousStatus;
  if (availabilityBaseline === "available") {
    if (input.previousStatus === "unknown") {
      return {
        shouldAlert: false,
        reason: "recovered_available_without_new_stock",
        transitioned: true,
      };
    }
    return {
      shouldAlert: false,
      reason: "remained_available",
      transitioned: false,
    };
  }

  const lastAlertedAt = input.lastAlertedAt;
  if (lastAlertedAt !== undefined && lastAlertedAt !== null) {
    const elapsed = now - timestamp(lastAlertedAt);
    if (elapsed < cooldownMs) {
      return {
        shouldAlert: false,
        reason: "cooldown_active",
        transitioned: true,
      };
    }
  }

  return {
    shouldAlert: true,
    reason:
      availabilityBaseline === null ? "initial_available" : "became_available",
    transitioned: true,
  };
}
