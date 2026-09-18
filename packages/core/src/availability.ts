/** A failure to understand Apple must never be represented as unavailable. */
export type AvailabilityStatus =
  | "available"
  | "unavailable"
  | "ineligible"
  | "unknown";

export const AVAILABILITY_STATUSES = [
  "available",
  "unavailable",
  "ineligible",
  "unknown",
] as const satisfies readonly AvailabilityStatus[];

export function isAvailabilityStatus(
  value: unknown,
): value is AvailabilityStatus {
  return (
    typeof value === "string" &&
    (AVAILABILITY_STATUSES as readonly string[]).includes(value)
  );
}
