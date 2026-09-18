import type { AvailabilityStatus } from "./availability.js";
import { z } from "zod";

export const EntityIdSchema = z.string().uuid();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const MarketCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}(?:-[A-Z0-9]{2,8})?$/);

export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type EntityId = z.infer<typeof EntityIdSchema>;
export type MarketCode = z.infer<typeof MarketCodeSchema>;

export interface ContractValidationIssue {
  path: string;
  message: string;
}

export type ContractParseResult<T> =
  | { success: true; data: T }
  | { success: false; issues: readonly ContractValidationIssue[] };

function parseContract<T>(
  schema: z.ZodType<T>,
  input: unknown,
): ContractParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

const NonEmptyUniqueEntityIdsSchema = z
  .array(EntityIdSchema)
  .min(1)
  .refine(unique, "IDs must not contain duplicates");

export interface ApiErrorDetail {
  code: string;
  message: string;
  field?: string;
}

export interface ApiErrorResponse {
  error: ApiErrorDetail;
  requestId: string;
}

export type MarketHealth = "healthy" | "degraded" | "paused" | "unknown";

export interface CatalogMarket {
  code: MarketCode;
  name: string;
  countryCode: string;
  currencyCode: string;
  health: MarketHealth;
  lastSuccessfulCheckAt: IsoDateTime | null;
}

export interface CatalogProductFamily {
  id: EntityId;
  name: string;
  slug: string;
}

export interface CatalogProductVariant {
  id: EntityId;
  familyId: EntityId;
  marketCode: MarketCode;
  sku: string;
  title: string;
  attributes: Readonly<Record<string, string>>;
}

export interface CatalogStore {
  id: EntityId;
  marketCode: MarketCode;
  appleStoreNumber: string;
  name: string;
  city: string | null;
  state: string | null;
  countryCode: string;
}

export const GetCatalogQuerySchema = z.strictObject({
  marketCode: MarketCodeSchema,
});
export type GetCatalogQuery = z.infer<typeof GetCatalogQuerySchema>;

export interface GetCatalogResponse {
  market: CatalogMarket;
  families: readonly CatalogProductFamily[];
  variants: readonly CatalogProductVariant[];
  stores: readonly CatalogStore[];
}

export const PublicCheckRequestSchema = z.strictObject({
  marketCode: MarketCodeSchema,
  location: z.string().trim().min(1).max(128),
  variantIds: NonEmptyUniqueEntityIdsSchema.max(12),
});
export type PublicCheckRequest = z.infer<typeof PublicCheckRequestSchema>;

export function parsePublicCheckRequest(
  input: unknown,
): ContractParseResult<PublicCheckRequest> {
  return parseContract(PublicCheckRequestSchema, input);
}

export interface PublicCheckAvailability {
  storeId: EntityId;
  variantId: EntityId;
  status: AvailabilityStatus;
  checkedAt: IsoDateTime;
  pickupQuote: string | null;
  purchaseUrl: string | null;
}

export interface PublicCheckResponse {
  requestId: string;
  marketHealth: MarketHealth;
  lastSuccessfulCheckAt: IsoDateTime | null;
  results: readonly PublicCheckAvailability[];
}

export type NotificationChannel =
  | "email"
  | "telegram"
  | "web_push"
  | "apple_messages"
  | "sms";

export type NotificationEndpointStatus =
  | "pending"
  | "verified"
  | "disabled"
  | "failed";

export interface NotificationEndpoint {
  id: EntityId;
  channel: NotificationChannel;
  status: NotificationEndpointStatus;
  label: string;
}

export const CreateAlertRequestSchema = z.strictObject({
  marketCode: MarketCodeSchema,
  productFamilyId: EntityIdSchema,
  acceptedVariantIds: NonEmptyUniqueEntityIdsSchema,
  storeIds: NonEmptyUniqueEntityIdsSchema,
  notificationEndpointIds: NonEmptyUniqueEntityIdsSchema,
});
export type CreateAlertRequest = z.infer<typeof CreateAlertRequestSchema>;

export function parseCreateAlertRequest(
  input: unknown,
): ContractParseResult<CreateAlertRequest> {
  return parseContract(CreateAlertRequestSchema, input);
}

export const UpdateAlertRequestSchema = z
  .strictObject({
    acceptedVariantIds: NonEmptyUniqueEntityIdsSchema.optional(),
    storeIds: NonEmptyUniqueEntityIdsSchema.optional(),
    notificationEndpointIds: NonEmptyUniqueEntityIdsSchema.optional(),
    enabled: z.boolean().optional(),
    /** Renewals are capped by the server's beta entitlement policy. */
    renew: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "At least one alert field must be updated",
  );
export type UpdateAlertRequest = z.infer<typeof UpdateAlertRequestSchema>;

export function parseUpdateAlertRequest(
  input: unknown,
): ContractParseResult<UpdateAlertRequest> {
  return parseContract(UpdateAlertRequestSchema, input);
}

export const AlertIdParamsSchema = z.strictObject({ alertId: EntityIdSchema });
export type AlertIdParams = z.infer<typeof AlertIdParamsSchema>;

export interface AlertResource {
  id: EntityId;
  userId: EntityId;
  marketCode: MarketCode;
  productFamilyId: EntityId;
  acceptedVariantIds: readonly EntityId[];
  storeIds: readonly EntityId[];
  notificationEndpointIds: readonly EntityId[];
  enabled: boolean;
  expiresAt: IsoDateTime;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CreateAlertResponse {
  alert: AlertResource;
}

export interface ListAlertsResponse {
  alerts: readonly AlertResource[];
}

export interface DeleteAlertResponse {
  deleted: true;
}

export interface TelegramConnectResponse {
  deepLink: string;
  expiresAt: IsoDateTime;
}

export const RegisterWebPushRequestSchema = z.strictObject({
  endpoint: z
    .string()
    .url()
    .refine(
      (value) => new URL(value).protocol === "https:",
      "Push endpoint must use HTTPS",
    ),
  keys: z.strictObject({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});
export type RegisterWebPushRequest = z.infer<
  typeof RegisterWebPushRequestSchema
>;

export function parseRegisterWebPushRequest(
  input: unknown,
): ContractParseResult<RegisterWebPushRequest> {
  return parseContract(RegisterWebPushRequestSchema, input);
}

export interface RegisterWebPushResponse {
  endpoint: NotificationEndpoint;
}
