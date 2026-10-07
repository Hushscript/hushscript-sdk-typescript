/** Where a body departs from its shape: the path to the field and what was expected there. */
export interface Problem {
  path: (string | number)[];
  expected: string;
}

/** Checks one value; null when it fits. Unknown keys are allowed, so a newer API still passes. */
export type Shape = (value: unknown) => Problem | null;

/** The oldest and newest instants a `Date` can hold, in unix seconds. */
const MAX_UNIX_SECONDS = 8_640_000_000_000;

function problem(expected: string): Problem {
  return { path: [], expected };
}

export function describeProblem({ path, expected }: Problem): string {
  const where = path.reduce<string>(
    (out, part) =>
      typeof part === "number" ? `${out}[${String(part)}]` : out === "" ? part : `${out}.${part}`,
    "",
  );
  return where === "" ? `expected ${expected}` : `${where}: expected ${expected}`;
}

export const str: Shape = (value) => (typeof value === "string" ? null : problem("a string"));
export const num: Shape = (value) =>
  typeof value === "number" && Number.isFinite(value) ? null : problem("a number");
/** A count or a 1-based number: a whole number above zero. */
export const positiveInt: Shape = (value) =>
  Number.isSafeInteger(value) && (value as number) > 0 ? null : problem("a positive whole number");
export const bool: Shape = (value) => (typeof value === "boolean" ? null : problem("a boolean"));
export const anything: Shape = () => null;

/** Unix seconds that make a valid `Date`. */
export const timestamp: Shape = (value) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_UNIX_SECONDS
    ? null
    : problem("a unix timestamp in seconds");

export const url: Shape = (value) =>
  typeof value === "string" && URL.canParse(value) ? null : problem("a URL");

export function nullable(shape: Shape): Shape {
  return (value) => (value === null ? null : shape(value));
}

/** A key that may be absent. */
export function optional(shape: Shape): Shape {
  return (value) => (value === undefined ? null : shape(value));
}

export function arrayOf(shape: Shape): Shape {
  return (value) => {
    if (!Array.isArray(value)) return problem("an array");
    for (let index = 0; index < value.length; index += 1) {
      const found = shape(value[index]);
      if (found !== null) return { path: [index, ...found.path], expected: found.expected };
    }
    return null;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with arbitrary keys whose values all fit `shape`. */
export function recordOf(shape: Shape): Shape {
  return (value) => {
    if (!isRecord(value)) return problem("an object");
    for (const [key, item] of Object.entries(value)) {
      const found = shape(item);
      if (found !== null) return { path: [key, ...found.path], expected: found.expected };
    }
    return null;
  };
}

/**
 * An object that has each listed key with a fitting value. `T` is the schema type the shape stands
 * for: it makes the compiler reject a key the schema does not have.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T only checks the listed keys against the schema
export function objectOf<T>(fields: { [K in keyof T]?: Shape }): Shape {
  const entries = Object.entries(fields) as [string, Shape][];
  return (value) => {
    if (!isRecord(value)) return problem("an object");
    for (const [key, shape] of entries) {
      const found = shape(Object.hasOwn(value, key) ? value[key] : undefined);
      if (found !== null) return { path: [key, ...found.path], expected: found.expected };
    }
    return null;
  };
}
