import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_COOLDOWN_MS,
  evaluateAvailabilityTransition,
} from "../src/index.js";

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

describe("evaluateAvailabilityTransition", () => {
  it("alerts when the initial observation is available", () => {
    expect(
      evaluateAvailabilityTransition({
        previousStatus: null,
        lastKnownStatus: null,
        currentStatus: "available",
        now: NOW,
      }),
    ).toEqual({
      shouldAlert: true,
      reason: "initial_available",
      transitioned: true,
    });
  });

  it("alerts for a known unavailable -> available transition", () => {
    expect(
      evaluateAvailabilityTransition({
        previousStatus: "unavailable",
        lastKnownStatus: "unavailable",
        currentStatus: "available",
        now: NOW,
      }),
    ).toEqual({
      shouldAlert: true,
      reason: "became_available",
      transitioned: true,
    });
  });

  it("treats ineligible as known nonavailable", () => {
    expect(
      evaluateAvailabilityTransition({
        previousStatus: "ineligible",
        lastKnownStatus: "ineligible",
        currentStatus: "available",
        now: NOW,
      }).shouldAlert,
    ).toBe(true);
  });

  it("never repeats while availability remains available", () => {
    expect(
      evaluateAvailabilityTransition({
        previousStatus: "available",
        lastKnownStatus: "available",
        currentStatus: "available",
        now: NOW + DEFAULT_ALERT_COOLDOWN_MS * 10,
        lastAlertedAt: NOW,
      }),
    ).toEqual({
      shouldAlert: false,
      reason: "remained_available",
      transitioned: false,
    });
  });

  it("alerts for unavailable -> unknown -> available by preserving the last definite state", () => {
    expect(
      evaluateAvailabilityTransition({
        previousStatus: "unknown",
        lastKnownStatus: "unavailable",
        currentStatus: "available",
        now: NOW,
      }),
    ).toEqual({
      shouldAlert: true,
      reason: "became_available",
      transitioned: true,
    });
  });

  it("does not repeat for available -> unknown -> available", () => {
    expect(
      evaluateAvailabilityTransition({
        previousStatus: "unknown",
        lastKnownStatus: "available",
        currentStatus: "available",
        now: NOW,
      }),
    ).toEqual({
      shouldAlert: false,
      reason: "recovered_available_without_new_stock",
      transitioned: true,
    });
  });

  it("applies a 30-minute cooldown to a genuine reappearance", () => {
    expect(
      evaluateAvailabilityTransition({
        previousStatus: "unavailable",
        lastKnownStatus: "unavailable",
        currentStatus: "available",
        now: NOW,
        lastAlertedAt: NOW - DEFAULT_ALERT_COOLDOWN_MS + 1,
      }).reason,
    ).toBe("cooldown_active");

    expect(
      evaluateAvailabilityTransition({
        previousStatus: "unavailable",
        lastKnownStatus: "unavailable",
        currentStatus: "available",
        now: NOW,
        lastAlertedAt: NOW - DEFAULT_ALERT_COOLDOWN_MS,
      }).shouldAlert,
    ).toBe(true);
  });

  it.each(["unavailable", "ineligible", "unknown"] as const)(
    "does not alert when current status is %s",
    (currentStatus) => {
      expect(
        evaluateAvailabilityTransition({
          previousStatus: "available",
          lastKnownStatus: "available",
          currentStatus,
          now: NOW,
        }).shouldAlert,
      ).toBe(false);
    },
  );
});
