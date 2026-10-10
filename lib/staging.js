/**
 * Staging area for uploaded archives.
 *
 * An import is two round trips — preview first, then a confirmed commit — so
 * the uploaded bytes have to survive between them without ever being held in
 * memory. Each upload lands in its own file under a random token, is swept
 * once it is older than the configured lifetime, and is deleted as soon as it
 * is consumed or discarded.
 * @module dsh-session-restore/staging
 */
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** How long an unconsumed upload is kept before the sweep removes it. */
export const DEFAULT_STAGING_TTL_MS = 6 * 60 * 60 * 1000;

/** Uploads kept on disk at once before the oldest are dropped. */
const DEFAULT_MAX_STAGED = 24;

/** One staged upload. */
export class Staging {
  /**
   * @param {{ root: string, ttlMs?: number, maxEntries?: number }} options - storage location and retention.
   */
  constructor(options) {
    this.root = options.root;
    this.ttlMs = options.ttlMs ?? DEFAULT_STAGING_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_STAGED;
  }

  /**
   * Stream one upload into a fresh staged file.
   * @param {AsyncIterable<Uint8Array>} chunks - request body chunks.
   * @param {{ signal?: AbortSignal, maxBytes?: number }} [options] - cancellation and size ceiling.
   * @returns {Promise<{ token: string, path: string, bytes: number }>} the staged upload.
   * @throws {Error} when the upload exceeds `maxBytes`; nothing is left behind.
   */
  async stage(chunks, options = {}) {
    const { signal, maxBytes = Number.MAX_SAFE_INTEGER } = options;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const path = join(this.root, `${token}.zip`);
    const handle = await open(path, 'wx', 0o600);
    let bytes = 0;
    try {
      for await (const chunk of chunks) {
        signal?.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new Error(`upload exceeds the ${maxBytes}-byte limit`);
        await handle.write(chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(path, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    await this.sweep();
    return { token, path, bytes };
  }

  /**
   * Resolve one staged upload.
   * @param {unknown} token - token returned by `stage`.
   * @returns {Promise<string | undefined>} the staged path, when it still exists.
   */
  async resolve(token) {
    if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/u.test(token)) return undefined;
    const path = join(this.root, `${token}.zip`);
    try {
      await stat(path);
      return path;
    } catch {
      return undefined;
    }
  }

  /**
   * Delete one staged upload.
   * @param {unknown} token - token returned by `stage`.
   * @returns {Promise<boolean>} whether a staged file was removed.
   */
  async discard(token) {
    const path = await this.resolve(token);
    if (path === undefined) return false;
    await rm(path, { force: true });
    return true;
  }

  /**
   * Remove expired uploads and keep the newest `maxEntries` of the rest.
   * @returns {Promise<number>} how many files were removed.
   */
  async sweep() {
    let names;
    try {
      names = await readdir(this.root);
    } catch {
      return 0;
    }
    const staged = [];
    const now = Date.now();
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.zip')) continue;
      const path = join(this.root, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > this.ttlMs) {
          await rm(path, { force: true });
          removed += 1;
          continue;
        }
        staged.push({ path, mtimeMs: info.mtimeMs });
      } catch {
        // A file that vanished mid-sweep is already gone.
      }
    }
    staged.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const item of staged.slice(this.maxEntries)) {
      await rm(item.path, { force: true });
      removed += 1;
    }
    return removed;
  }
}
