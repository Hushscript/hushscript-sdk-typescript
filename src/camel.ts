function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_whole, char: string) => char.toUpperCase());
}

/** Copies `value` with every object key camelCased, at any depth (spec 4); strings and numbers are untouched. */
export function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [camelKey(key), camelize(item)]),
    );
  }
  return value;
}
