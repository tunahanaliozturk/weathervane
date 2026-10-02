import { murmur3 } from "./murmur3.ts";

export const BUCKET_SCALE = 100_000;

/** A stable position in [0, 100000) for one value of one flag. Changing the salt reshuffles everyone. */
export function bucketOf(flagKey: string, salt: string, value: string): number {
  return murmur3(`${flagKey}.${salt}.${value}`) % BUCKET_SCALE;
}

/**
 * Index of the variation whose cumulative weight range contains `bucket`. Variations sit side by side
 * in index order, so moving weight from the last variation to the first only ever widens the first
 * range; that is what keeps a growing rollout sticky.
 */
export function pickVariation(weights: readonly number[], bucket: number): number | null {
  let upper = 0;
  for (const [index, weight] of weights.entries()) {
    upper += weight;
    if (bucket < upper) {
      return index;
    }
  }
  return null;
}
