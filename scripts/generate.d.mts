// Types for the tests that import the generator; the script itself is checked by tsconfig.scripts.json.
export function asRecord(value: unknown, what: string): Record<string, unknown>;
export function emitCatalog(spec: unknown): string;
export function emitScopes(spec: unknown): string;
export function emitHints(hints: unknown): string;
export function generate(source?: string): Promise<void>;
