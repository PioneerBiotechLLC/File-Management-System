/** Milliseconds that local time in `timeZone` is ahead of UTC at `date`. */
function offsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return localAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant local midnight began in `timeZone` on the local day containing `now`. */
export function startOfDay(now: Date, timeZone: string): Date {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .split("-")
    .map(Number);
  const midnightAsUtc = Date.UTC(year!, month! - 1, day!);
  const first = midnightAsUtc - offsetMs(new Date(midnightAsUtc), timeZone);
  // A DST change between UTC midnight and local midnight shifts the offset; correct once.
  return new Date(midnightAsUtc - offsetMs(new Date(first), timeZone));
}

/** The instant the local month containing `now` began in `timeZone`. */
export function startOfMonth(now: Date, timeZone: string): Date {
  const [year, month] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).format(now).split("-").map(Number);
  const firstAsUtc = Date.UTC(year!, month! - 1, 1);
  const first = firstAsUtc - offsetMs(new Date(firstAsUtc), timeZone);
  return new Date(firstAsUtc - offsetMs(new Date(first), timeZone));
}
