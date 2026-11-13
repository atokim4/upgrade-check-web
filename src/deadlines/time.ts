/** Date maths for the deadline pages. Dates are calendar days (YYYY-MM-DD); "today" is the visitor's local date. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(iso: string): [number, number, number] {
  const m = ISO_DAY.exec(iso);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${iso}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The local calendar date of `now` as YYYY-MM-DD. */
export function localDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whole days from `today` to `date` (negative once it has passed). */
export function daysBetween(today: string, date: string): number {
  const [y1, m1, d1] = parts(today);
  const [y2, m2, d2] = parts(date);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** "14 Jan 2027", "Apr 2027" for an approximate date, or "No date yet". */
export function formatDay(date: string | null, approx = false): string {
  if (!date) return "No date yet";
  const [y, m, d] = parts(date);
  return approx ? `${MONTHS[m - 1]} ${y}` : `${d} ${MONTHS[m - 1]} ${y}`;
}

export type CountdownState = "upcoming" | "today" | "passed" | "undated";

export interface Countdown {
  state: CountdownState;
  /** The big figure: "62", "Today", "Passed". */
  figure: string;
  /** The words under it: "days left", "days ago". */
  caption: string;
  /** One sentence for screen readers and the page lede. */
  sentence: string;
}

const days = (n: number) => (n === 1 ? "day" : "days");

/** What to show for a deadline on `today`. */
export function countdown(date: string | null, today: string, approx = false): Countdown {
  if (!date)
    return {
      state: "undated",
      figure: "TBA",
      caption: "no date set",
      sentence: "The vendor hasn't set a date yet.",
    };
  const n = daysBetween(today, date);
  if (n > 0)
    return {
      state: "upcoming",
      figure: `${approx ? "~" : ""}${n}`,
      caption: `${days(n)} left`,
      sentence: `${approx ? "About " : ""}${n} ${days(n)} left.`,
    };
  if (n === 0)
    return {
      state: "today",
      figure: "Today",
      caption: "it happens today",
      sentence: "It happens today.",
    };
  const ago = -n;
  return {
    state: "passed",
    figure: `${ago}`,
    caption: `${days(ago)} ago`,
    sentence: `Passed ${approx ? "about " : ""}${ago} ${days(ago)} ago.`,
  };
}
