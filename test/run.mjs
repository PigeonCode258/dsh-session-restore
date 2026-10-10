/**
 * Run the whole suite in one process.
 *
 * `node --test test/` would spawn a child process per file, which some
 * confined environments refuse; importing the files keeps every run local.
 */
import './helpers.mjs';
import './archive.test.mjs';
import './restore.test.mjs';
import './routes.test.mjs';
import './client.test.mjs';
import './plugin.test.mjs';
