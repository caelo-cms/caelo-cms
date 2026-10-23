// SPDX-License-Identifier: MPL-2.0

/**
 * Run `worker` over `items` with at most `parallelism` in flight, in item
 * order. File and network I/O of a build (page writes, the `current/`
 * mirror, uploads) goes through this: one-at-a-time costs a round trip per
 * file, unbounded `Promise.all` exhausts file descriptors and memory on
 * large sites.
 *
 * The first rejection rejects the whole call; workers already running
 * finish, no new item starts.
 */
export async function runBatched<T>(
  items: ReadonlyArray<T>,
  parallelism: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new Error(`runBatched: parallelism must be a positive integer, got ${parallelism}`);
  }
  let cursor = 0;
  let failed = false;
  const next = async (): Promise<void> => {
    while (!failed && cursor < items.length) {
      const i = cursor++;
      try {
        // biome-ignore lint/style/noNonNullAssertion: cursor < length checked
        await worker(items[i]!);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  const workers: Promise<void>[] = [];
  const n = Math.min(parallelism, items.length);
  for (let i = 0; i < n; i++) workers.push(next());
  await Promise.all(workers);
}
