/**
 * Loader hook that swaps `node:path` for the POSIX-rule shim.
 * @module test/simulate-posix/hooks
 */
const SHIM_URL = new URL('./path.mjs', import.meta.url).href;

/**
 * Redirect `node:path` to the shim and leave every other specifier alone.
 * @param {string} specifier - requested module.
 * @param {object} context - resolution context.
 * @param {(specifier: string, context: object) => Promise<object>} nextResolve - default resolution.
 * @returns {Promise<object>} the resolved module.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:path') return { url: SHIM_URL, shortCircuit: true, format: 'module' };
  return nextResolve(specifier, context);
}
