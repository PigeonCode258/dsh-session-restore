/**
 * `node:path` with POSIX rules for {@link file://./isAbsolute}, while every
 * path *builder* keeps the host's own behaviour.
 *
 * That split is what lets a Windows machine run the suite the way a Linux
 * machine does: platform branches must see POSIX semantics (a `D:\…` fixture
 * is not absolute there), yet real temporary files still need to be addressed
 * with the separators this filesystem accepts.
 *
 * Loaded only by `test/simulate-posix/run.mjs` through a loader hook; the
 * package itself never sees this file.
 * @module test/simulate-posix/path
 */
import { createRequire } from 'node:module';

// `require` reaches the CommonJS builtin directly, so this shim does not
// resolve `node:path` through the hook that installed it.
const real = createRequire(import.meta.url)('node:path');

/** POSIX absolute-path rule, standing in for the host platform's own. */
export const isAbsolute = real.posix.isAbsolute;

export const join = real.join;
export const resolve = real.resolve;
export const dirname = real.dirname;
export const basename = real.basename;
export const extname = real.extname;
export const relative = real.relative;
export const normalize = real.normalize;
export const parse = real.parse;
export const format = real.format;
export const toNamespacedPath = real.toNamespacedPath;
export const sep = real.sep;
export const delimiter = real.delimiter;
export const posix = real.posix;
export const win32 = real.win32;

export default {
  isAbsolute,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  normalize,
  parse,
  format,
  toNamespacedPath,
  sep,
  delimiter,
  posix,
  win32,
};
