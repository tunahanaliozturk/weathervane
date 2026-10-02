import { ApiError } from "./errors.ts";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function pageLimit(limit: string | undefined): number {
  return Math.min(limit === undefined ? DEFAULT_LIMIT : Number(limit), MAX_LIMIT);
}

/** Opaque to callers: base64url of the last row's sort key. Its contents are not part of the contract. */
export function encodeCursor(value: string | number): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T extends "string" | "number">(
  cursor: string | undefined,
  type: T,
): (T extends "string" ? string : number) | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value === type) {
      return value as T extends "string" ? string : number;
    }
  } catch {
    // Fall through to the error below.
  }
  throw new ApiError(400, "invalid_cursor", "The cursor is not one this endpoint returned.");
}
