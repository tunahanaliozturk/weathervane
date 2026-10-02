const encoder = new TextEncoder();

/**
 * MurmurHash3, x86 32-bit variant, over the UTF-8 bytes of `input`. Chosen over a cryptographic hash
 * because bucketing needs uniformity, not secrecy, and because SDKs in other languages can reproduce it
 * from the published reference without a crypto library.
 */
export function murmur3(input: string, seed = 0): number {
  const bytes = encoder.encode(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.byteLength;
  const blockEnd = length - (length % 4);
  let h = seed >>> 0;

  for (let i = 0; i < blockEnd; i += 4) {
    h ^= scramble(view.getUint32(i, true));
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  let tail = 0;
  for (let i = length - 1; i >= blockEnd; i--) {
    tail = (tail << 8) | view.getUint8(i);
  }
  if (length > blockEnd) {
    h ^= scramble(tail);
  }

  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function scramble(k: number): number {
  k = Math.imul(k, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  return Math.imul(k, 0x1b873593);
}
