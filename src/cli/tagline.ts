const DEFAULT_TAGLINE = "Fased Agent";

const HOLIDAY_TAGLINES = {
  newYear:
    "New Year's Day: New year, new config—same old EADDRINUSE, but this time we resolve it like grown-ups.",
  lunarNewYear:
    "Lunar New Year: May your builds be lucky, your branches prosperous, and your merge conflicts chased away with fireworks.",
  christmas:
    "Christmas: Ho ho ho—Santa's little fased-assistant is here to ship joy, roll back chaos, and stash the keys safely.",
  eid: "Eid al-Fitr: Celebration mode: queues cleared, tasks completed, and good vibes committed to main with clean history.",
  diwali:
    "Diwali: Let the logs sparkle and the bugs flee—today we light up the terminal and ship with pride.",
  easter:
    "Easter: I found your missing environment variable—consider it a tiny CLI egg hunt with fewer jellybeans.",
  hanukkah:
    "Hanukkah: Eight nights, eight retries, zero shame—may your gateway stay lit and your deployments stay peaceful.",
  halloween:
    "Halloween: Spooky season: beware haunted dependencies, cursed caches, and the ghost of node_modules past.",
  thanksgiving:
    "Thanksgiving: Grateful for stable ports, working DNS, and a bot that reads the logs so nobody has to.",
  valentines:
    "Valentine's Day: Roses are typed, violets are piped—I'll automate the chores so you can spend time with humans.",
} as const;

const TAGLINES: string[] = [];

type HolidayRule = (date: Date) => boolean;

function utcParts(date: Date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
  };
}

const onMonthDay =
  (month: number, day: number): HolidayRule =>
  (date) => {
    const parts = utcParts(date);
    return parts.month === month && parts.day === day;
  };

const HOLIDAY_RULES = new Map<string, HolidayRule>([
  [HOLIDAY_TAGLINES.christmas, onMonthDay(11, 25)],
]);

function isTaglineActive(tagline: string, date: Date): boolean {
  const rule = HOLIDAY_RULES.get(tagline);
  if (!rule) {
    return true;
  }
  return rule(date);
}

export interface TaglineOptions {
  env?: NodeJS.ProcessEnv;
  random?: () => number;
  now?: () => Date;
}

export function activeTaglines(options: TaglineOptions = {}): string[] {
  if (TAGLINES.length === 0) {
    return [DEFAULT_TAGLINE];
  }
  const today = options.now ? options.now() : new Date();
  const filtered = TAGLINES.filter((tagline) => isTaglineActive(tagline, today));
  return filtered.length > 0 ? filtered : TAGLINES;
}

export function pickTagline(options: TaglineOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env?.FASED_TAGLINE_INDEX;
  if (override !== undefined) {
    const parsed = Number.parseInt(override, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      const pool = TAGLINES.length > 0 ? TAGLINES : [DEFAULT_TAGLINE];
      return pool[parsed % pool.length];
    }
  }
  const pool = activeTaglines(options);
  const rand = options.random ?? Math.random;
  const index = Math.floor(rand() * pool.length) % pool.length;
  return pool[index];
}

export { TAGLINES, HOLIDAY_RULES, DEFAULT_TAGLINE };
