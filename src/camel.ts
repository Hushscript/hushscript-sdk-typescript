function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_whole, char: string) => char.toUpperCase());
}

/** Copies `value` with every object key camelCased, at any depth; strings and numbers are untouched. */
export function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [camelKey(key), camelize(item)]),
    );
  }
  return value;
}

/**
 * The fields of `raw` whose names are not in `known` (snake_case), camelized. A result mapper spreads
 * them first and its own fields after, so a field the API adds later stays on the result at run
 * time and a known field always wins.
 */
export function unknownFields(raw: object, known: ReadonlySet<string>): Record<string, unknown> {
  const extra = Object.entries(raw).filter(([key]) => !known.has(key));
  return camelize(Object.fromEntries(extra)) as Record<string, unknown>;
}

/**
 * `raw` camelized where every key maps to the field of the same name: the fields outside `known`
 * first, the known ones after, so a stray key that camelizes to a known name cannot replace it.
 */
export function camelizeKnown(raw: object, known: ReadonlySet<string>): Record<string, unknown> {
  const own = Object.entries(raw).filter(([key]) => known.has(key));
  return { ...unknownFields(raw, known), ...(camelize(Object.fromEntries(own)) as object) };
}
