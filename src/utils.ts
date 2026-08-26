export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  callback: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await callback(items[index], index);
    }
  }));
  return output;
}

export function mapSettledConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  callback: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapConcurrent(items, limit, async (item, index) => {
    try {
      return { status: "fulfilled", value: await callback(item, index) } as const;
    } catch (reason) {
      return { status: "rejected", reason } as const;
    }
  });
}

export class ConcurrencyLimiter {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active++;
    try {
      return await operation();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}

export function metric(current: number, previous?: number, comparedAt?: string) {
  return {
    current,
    previous: previous ?? null,
    delta: previous === undefined ? null : current - previous,
    comparedAt: comparedAt ?? null,
  };
}
