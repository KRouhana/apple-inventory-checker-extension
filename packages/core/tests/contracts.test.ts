import { describe, expect, it } from "vitest";

import {
  AlertIdParamsSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  parseCreateAlertRequest,
  parsePublicCheckRequest,
  parseRegisterWebPushRequest,
  parseUpdateAlertRequest,
} from "../src/index.js";

const ID_1 = "00000000-0000-4000-8000-000000000001";
const ID_2 = "00000000-0000-4000-8000-000000000002";
const ID_3 = "00000000-0000-4000-8000-000000000003";

describe("public API runtime contracts", () => {
  it("validates canonical IDs and timestamps", () => {
    expect(EntityIdSchema.safeParse(ID_1).success).toBe(true);
    expect(EntityIdSchema.safeParse("not-an-id").success).toBe(false);
    expect(IsoDateTimeSchema.safeParse("2026-08-29T12:00:00Z").success).toBe(
      true,
    );
    expect(IsoDateTimeSchema.safeParse("August 29").success).toBe(false);
    expect(AlertIdParamsSchema.safeParse({ alertId: ID_1 }).success).toBe(true);
  });

  it("parses a public check and rejects empty or duplicate variant IDs", () => {
    expect(
      parsePublicCheckRequest({
        marketCode: "US",
        location: "10001",
        variantIds: [ID_1, ID_2],
      }).success,
    ).toBe(true);
    expect(
      parsePublicCheckRequest({
        marketCode: "us",
        location: "",
        variantIds: [],
      }).success,
    ).toBe(false);
    expect(
      parsePublicCheckRequest({
        marketCode: "US",
        location: "10001",
        variantIds: [ID_1, ID_1],
      }).success,
    ).toBe(false);
  });

  it("parses an alert creation request and rejects invalid IDs", () => {
    expect(
      parseCreateAlertRequest({
        marketCode: "CA",
        productFamilyId: ID_1,
        acceptedVariantIds: [ID_2],
        storeIds: [ID_3],
        notificationEndpointIds: [ID_1],
      }).success,
    ).toBe(true);
    expect(
      parseCreateAlertRequest({
        marketCode: "CA",
        productFamilyId: "family",
        acceptedVariantIds: [],
        storeIds: [],
        notificationEndpointIds: [],
      }).success,
    ).toBe(false);
  });

  it("rejects no-op and unknown alert updates", () => {
    expect(parseUpdateAlertRequest({ enabled: false }).success).toBe(true);
    expect(parseUpdateAlertRequest({}).success).toBe(false);
    expect(
      parseUpdateAlertRequest({ enabled: true, admin: true }).success,
    ).toBe(false);
  });

  it("requires an HTTPS push endpoint and nonempty browser keys", () => {
    expect(
      parseRegisterWebPushRequest({
        endpoint: "https://push.example.test/subscription/1",
        keys: { p256dh: "public-key", auth: "auth-secret" },
      }).success,
    ).toBe(true);
    expect(
      parseRegisterWebPushRequest({
        endpoint: "http://push.example.test/subscription/1",
        keys: { p256dh: "", auth: "" },
      }).success,
    ).toBe(false);
  });
});
