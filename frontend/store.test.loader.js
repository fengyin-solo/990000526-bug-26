/**
 * Redirects imports of '../api/index.js' (used by the board store) to the
 * in-memory mock for tests.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('api/index.js')) {
    return { url: new URL('./mock-api.js', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
