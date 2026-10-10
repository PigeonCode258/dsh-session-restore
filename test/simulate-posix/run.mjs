/**
 * Run the whole suite the way a POSIX host runs it, from any host.
 *
 * CI covers real Linux. This entry point exists so a Windows development
 * machine can reproduce the platform branches (`isAbsolute`, the platform
 * constant the fixtures read) before pushing, which is exactly the class of
 * bug that once turned CI red on ubuntu only.
 *
 *   node test/simulate-posix/run.mjs
 *
 * @module test/simulate-posix/run
 */
import { register } from 'node:module';
import assert from 'node:assert/strict';

// The fixtures and the platform assertions read this instead of
// `process.platform`, which is read-only.
process.env.DSH_SESSION_RESTORE_TEST_PLATFORM = 'linux';

register('./hooks.mjs', import.meta.url);

const { isAbsolute } = await import('node:path');
assert.equal(isAbsolute('D:\\dev\\project'), false, 'the POSIX shim must reject a Windows path');
assert.equal(isAbsolute('/work/demo'), true, 'the POSIX shim must accept a POSIX path');
assert.equal(isAbsolute('C:\\work\\demo'), false, 'the POSIX shim must not use win32 rules');

console.log('simulating a POSIX host: isAbsolute uses POSIX rules, fixtures see platform "linux"\n');
await import('../run.mjs');
