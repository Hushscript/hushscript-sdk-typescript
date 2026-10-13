// Real API bodies are a few levels deep. A deeper one is hostile or broken, and the recursive
// walks that build a result or an error from it (camelCasing, redaction) would overflow the stack.
export const MAX_BODY_DEPTH = 64;

export function nestsDeeperThan(root: unknown, limit: number): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value, depth } = next;
    if (typeof value !== "object" || value === null) continue;
    if (depth >= limit) return true;
    for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
  return false;
}
