import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../styles.css";
import "./deadlines.css";
import { countdown, formatDay, localDay } from "./time.ts";

// Fills the countdowns from the visitor's own clock; the pages are complete without this, minus the day counts.
const today = localDay(new Date());
let passed = 0;
let ahead = 0;

for (const slot of document.querySelectorAll<HTMLElement>("[data-countdown]")) {
  const c = countdown(slot.dataset.date || null, today, "approx" in slot.dataset);
  const fig = Object.assign(document.createElement("span"), {
    className: "cd-fig",
    textContent: c.figure,
  });
  const cap = Object.assign(document.createElement("span"), {
    className: "cd-cap",
    textContent: c.caption,
  });
  const said = Object.assign(document.createElement("span"), {
    className: "visually-hidden",
    textContent: c.sentence,
  });
  fig.setAttribute("aria-hidden", "true");
  cap.setAttribute("aria-hidden", "true");
  slot.replaceChildren(fig, cap, said);
  const row = slot.closest<HTMLElement>("[data-row]");
  if (row) row.dataset.state = c.state;
  if (c.state === "passed") passed++;
  else if (c.state !== "undated") ahead++;
}

// On the timetable, a "today" rule between what has passed and what is still ahead.
const board = document.querySelector(".timetable");
if (board) {
  const next = board.querySelector<HTMLElement>('[data-row]:not([data-state="passed"])');
  const now = document.createElement("li");
  now.className = "tt-now";
  now.innerHTML = `<span class="tt-now-label">Today, <time datetime="${today}">${formatDay(today)}</time></span>`;
  board.insertBefore(now, next);

  const line = document.querySelector<HTMLElement>("[data-today]");
  if (line) {
    line.textContent = `By your clock it is ${formatDay(today)}: ${passed} of these dates ${passed === 1 ? "has" : "have"} passed, ${ahead} ${ahead === 1 ? "is" : "are"} still ahead.`;
    line.hidden = false;
  }
}
