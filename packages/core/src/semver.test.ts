import { describe, expect, it } from "vitest";
import { compareSemver, parseSemver } from "./semver.ts";

function compare(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null || right === null) {
    throw new Error(`not semver: ${a} or ${b}`);
  }
  return compareSemver(left, right);
}

describe("semver", () => {
  it("orders the precedence example from the specification", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.10.0",
      "2.0.0",
    ];
    for (let i = 0; i + 1 < ordered.length; i++) {
      expect(compare(ordered[i] ?? "", ordered[i + 1] ?? "")).toBe(-1);
      expect(compare(ordered[i + 1] ?? "", ordered[i] ?? "")).toBe(1);
    }
  });

  it("ignores build metadata", () => {
    expect(compare("1.2.3+build.7", "1.2.3")).toBe(0);
  });

  it.each(["1.2", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3-a..b", "", "1.2.3.4"])("rejects %j", (text) => {
    expect(parseSemver(text)).toBeNull();
  });
});
