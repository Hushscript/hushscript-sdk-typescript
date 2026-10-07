// Module hooks for the examples runner: the examples import the package by its name, as a user's
// code does, and this points that name at the source tree so no build is needed.
const SOURCE = new URL("../src/index.ts", import.meta.url).href;

/**
 * @param {string} specifier
 * @param {unknown} context
 * @param {(specifier: string, context: unknown) => Promise<unknown>} next
 */
export function resolve(specifier, context, next) {
  if (specifier === "@hushscript/sdk") {
    return Promise.resolve({ url: SOURCE, shortCircuit: true });
  }
  return next(specifier, context);
}
