import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type KeyKind = "admin" | "sdk";

const KEY_PATTERN = /^wv_(admin|sdk)_([0-9a-f]{16})_([0-9a-f]{64})$/;

export interface ParsedKey {
  readonly kind: KeyKind;
  readonly id: string;
  readonly secret: string;
}

export interface NewKey extends ParsedKey {
  readonly token: string;
  readonly secretHash: Buffer;
}

/** `wv_<kind>_<id>_<secret>`: the id finds the row, only a hash of the secret is stored. */
export function newKey(kind: KeyKind): NewKey {
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("hex");
  return { kind, id, secret, token: `wv_${kind}_${id}_${secret}`, secretHash: sha256(secret) };
}

export function parseKey(token: string): ParsedKey | null {
  const match = KEY_PATTERN.exec(token);
  if (match === null) {
    return null;
  }
  const [, kind, id, secret] = match;
  return kind === "admin" || kind === "sdk" ? { kind, id: id ?? "", secret: secret ?? "" } : null;
}

export function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** Constant-time for equal lengths; SHA-256 digests always are. */
export function sameHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
