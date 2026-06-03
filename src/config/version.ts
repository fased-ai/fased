export type FasedAgentVersion = {
  major: number;
  minor: number;
  patch: number;
  revision: number;
  flavor: "semver" | "calendar";
};

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?/;
const CALENDAR_VERSION_RE = /^v?(20\d{2})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?$/;

export function parseFasedAgentVersion(raw: string | null | undefined): FasedAgentVersion | null {
  if (!raw) {
    return null;
  }
  const match = raw.trim().match(VERSION_RE);
  if (!match) {
    return null;
  }
  const [, major, minor, patch, revision] = match;
  const calendarMatch = raw.trim().match(CALENDAR_VERSION_RE);
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    revision: revision ? Number.parseInt(revision, 10) : 0,
    flavor: calendarMatch ? "calendar" : "semver",
  };
}

export function compareFasedAgentVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const parsedA = parseFasedAgentVersion(a);
  const parsedB = parseFasedAgentVersion(b);
  if (!parsedA || !parsedB) {
    return null;
  }
  if (parsedA.flavor !== parsedB.flavor) {
    return 0;
  }
  if (parsedA.major !== parsedB.major) {
    return parsedA.major < parsedB.major ? -1 : 1;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor < parsedB.minor ? -1 : 1;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch < parsedB.patch ? -1 : 1;
  }
  if (parsedA.revision !== parsedB.revision) {
    return parsedA.revision < parsedB.revision ? -1 : 1;
  }
  return 0;
}
