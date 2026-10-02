// Anchored, no nested quantifiers: linear time on any input.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Version {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

export function parseSemver(text: string): Version | null {
  const match = SEMVER.exec(text);
  if (match === null) {
    return null;
  }
  const [, major = "", minor = "", patch = "", prerelease] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease === undefined ? [] : prerelease.split("."),
  };
}

/** Semantic Versioning 2.0.0 precedence: negative, zero or positive. Build metadata is ignored. */
export function compareSemver(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const difference = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  // A release outranks any of its pre-releases.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const order = compareIdentifier(a.prerelease[i] ?? "", b.prerelease[i] ?? "");
    if (order !== 0) {
      return order;
    }
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

const NUMERIC = /^\d+$/;

function compareIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) {
    return Math.sign(Number(a) - Number(b));
  }
  if (aNumeric !== bNumeric) {
    return aNumeric ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
