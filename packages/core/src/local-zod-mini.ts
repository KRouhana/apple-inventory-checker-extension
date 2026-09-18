/**
 * Small, explicit compatibility surface for the local-monitor schemas.
 *
 * Zod Mini exposes composable checks rather than Zod Classic's fluent methods.
 * The local-monitor contract is intentionally authored with the established
 * fluent syntax, so this adapter translates only the finite set of operations
 * used by that contract. It does not relax or replace any schema rule: every
 * operation below maps to its Zod Mini equivalent.
 *
 * The exported surface is deliberately typed as this finite adapter, not as
 * Zod Classic. Calling an unsupported Classic-only method is therefore a
 * compile-time error instead of a type/runtime mismatch. At runtime every
 * supported operation is backed entirely by Zod Mini.
 */
import {
  _default as miniDefault,
  array as miniArray,
  boolean as miniBoolean,
  discriminatedUnion as miniDiscriminatedUnion,
  enum as miniEnum,
  gte as miniGte,
  int as miniInt,
  iso as miniIso,
  literal as miniLiteral,
  lte as miniLte,
  maxLength as miniMaxLength,
  minLength as miniMinLength,
  nullable as miniNullable,
  number as miniNumber,
  optional as miniOptional,
  refine as miniRefine,
  regex as miniRegex,
  strictObject as miniStrictObject,
  string as miniString,
  superRefine as miniSuperRefine,
  trim as miniTrim,
  unknown as miniUnknown,
  url as miniUrl,
  type ZodMiniType,
} from "zod/mini";

type SchemaKind = "array" | "number" | "string" | "other";
type AnyMiniSchema = ZodMiniType<unknown, unknown>;

export interface RefinementCtx {
  addIssue(issue: {
    code: string;
    path?: readonly (string | number)[];
    message: string;
  }): void;
}

interface ParseIssue {
  path: readonly (string | number)[];
  message: string;
}

export interface Schema<T> {
  /** Phantom output marker for `z.infer`; never read at runtime. */
  readonly __output?: T;
  safeParse(
    input: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly ParseIssue[] } };
  refine(predicate: (value: T) => unknown, message?: string): Schema<T>;
  superRefine(predicate: (value: T, context: RefinementCtx) => void): Schema<T>;
  default(value: Exclude<T, undefined>): Schema<Exclude<T, undefined>>;
  nullable(): Schema<T | null>;
  optional(): Schema<T | undefined>;
}

export interface StringSchema<T extends string = string> extends Schema<T> {
  regex(pattern: RegExp, message?: string): StringSchema<T>;
  trim(): StringSchema<T>;
  datetime(options?: { offset?: boolean }): StringSchema<T>;
  min(value: number, message?: string): StringSchema<T>;
  max(value: number, message?: string): StringSchema<T>;
}

export interface NumberSchema<T extends number = number> extends Schema<T> {
  int(): NumberSchema<T>;
  min(value: number, message?: string): NumberSchema<T>;
  max(value: number, message?: string): NumberSchema<T>;
}

export interface ArraySchema<T> extends Schema<T[]> {
  min(value: number, message?: string): ArraySchema<T>;
  max(value: number, message?: string): ArraySchema<T>;
}

type InferSchema<T> = T extends Schema<infer Output> ? Output : never;
type RequiredShapeKeys<T extends Record<string, Schema<unknown>>> = {
  [Key in keyof T]-?: undefined extends InferSchema<T[Key]> ? never : Key;
}[keyof T];
type OptionalShapeKeys<T extends Record<string, Schema<unknown>>> = Exclude<
  keyof T,
  RequiredShapeKeys<T>
>;
type InferShape<T extends Record<string, Schema<unknown>>> = {
  [Key in RequiredShapeKeys<T>]: InferSchema<T[Key]>;
} & {
  [Key in OptionalShapeKeys<T>]?: Exclude<InferSchema<T[Key]>, undefined>;
};

/**
 * Adds only the fluent operations used by local-monitor-contracts. Each
 * operation returns a newly decorated Mini schema; Mini itself keeps parsing
 * and issue production authoritative.
 */
function decorate<T extends AnyMiniSchema>(schema: T, kind: SchemaKind): T {
  // Zod Mini's public type correctly prevents attaching Classic methods. The
  // adapter deliberately adds this finite compatibility layer at runtime;
  // consumers receive the finite adapter types declared above.
  const fluent = schema as any;
  const checked = (check: unknown) =>
    decorate((schema as any).check(check) as T, kind);
  fluent.regex = (pattern: RegExp, message?: string) =>
    decorate((schema as any).check(miniRegex(pattern, message)) as T, "string");
  fluent.trim = () =>
    decorate((schema as any).check(miniTrim()) as T, "string");
  fluent.datetime = (options?: { offset?: boolean }) =>
    decorate((schema as any).check(miniIso.datetime(options)) as T, "string");
  fluent.int = () => decorate((schema as any).check(miniInt()) as T, "number");
  fluent.min = (value: number, message?: string) => {
    const check =
      kind === "number"
        ? miniGte(value, message)
        : miniMinLength(value, message);
    return checked(check);
  };
  fluent.max = (value: number, message?: string) => {
    const check =
      kind === "number"
        ? miniLte(value, message)
        : miniMaxLength(value, message);
    return checked(check);
  };
  fluent.refine = (predicate: (value: unknown) => unknown, message?: string) =>
    checked(miniRefine(predicate, message));
  fluent.superRefine = (
    predicate: (value: unknown, context: unknown) => void,
  ) => checked(miniSuperRefine(predicate));
  fluent.default = (value: unknown) =>
    decorate(miniDefault(schema as any, value as any) as unknown as T, kind);
  fluent.nullable = () => decorate(miniNullable(schema), kind);
  fluent.optional = () => decorate(miniOptional(schema), kind);
  return schema;
}

function asMini<T>(value: Schema<T>): AnyMiniSchema {
  return value as unknown as AnyMiniSchema;
}

/**
 * Do not add APIs speculatively. A new local contract operation must add its
 * exact Mini mapping and accompanying parity coverage first.
 */
export const z = {
  string: (): StringSchema =>
    decorate(miniString(), "string") as unknown as StringSchema,
  number: (): NumberSchema =>
    decorate(miniNumber(), "number") as unknown as NumberSchema,
  boolean: (): Schema<boolean> =>
    decorate(miniBoolean(), "other") as unknown as Schema<boolean>,
  unknown: (): Schema<unknown> =>
    decorate(miniUnknown(), "other") as unknown as Schema<unknown>,
  url: (): StringSchema =>
    decorate(miniUrl(), "string") as unknown as StringSchema,
  literal: <const T>(value: T): Schema<T> =>
    decorate(miniLiteral(value as any), "other") as unknown as Schema<T>,
  enum: <const T extends readonly [string, ...string[]]>(
    values: T,
  ): Schema<T[number]> =>
    decorate(miniEnum(values), "other") as unknown as Schema<T[number]>,
  array: <T>(value: Schema<T>): ArraySchema<T> =>
    decorate(miniArray(asMini(value)), "array") as unknown as ArraySchema<T>,
  strictObject: <T extends Record<string, Schema<unknown>>>(
    shape: T,
  ): Schema<InferShape<T>> =>
    decorate(
      miniStrictObject(
        Object.fromEntries(
          Object.entries(shape).map(([key, value]) => [key, asMini(value)]),
        ),
      ),
      "other",
    ) as unknown as Schema<InferShape<T>>,
  discriminatedUnion: <
    T extends readonly [Schema<unknown>, ...Schema<unknown>[]],
  >(
    discriminator: string,
    options: T,
  ): Schema<InferSchema<T[number]>> =>
    decorate(
      miniDiscriminatedUnion(discriminator, options.map(asMini) as any) as any,
      "other",
    ) as unknown as Schema<InferSchema<T[number]>>,
};

/** Preserve the established `z.infer<typeof Schema>` public type syntax. */
export namespace z {
  export type infer<T extends Schema<unknown>> = InferSchema<T>;
  export type RefinementCtx = import("./local-zod-mini.js").RefinementCtx;
}
