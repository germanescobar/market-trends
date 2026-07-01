/**
 * File-backed logger for cron services.
 *
 * `tsx watch` is known to buffer stdout/stderr in some configurations, so
 * a `console.log` can sit for minutes before becoming visible in the
 * terminal. This logger appends synchronously to `backfill.log` in CWD and
 * also writes to stderr, so `tail -f backfill.log` gives a real-time view
 * that doesn't depend on the terminal pane.
 *
 * Best-effort: if the file can't be written (read-only fs, etc.) the
 * service still functions — the stderr line will at least be visible
 * eventually.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG_PATH = join(process.cwd(), "backfill.log");

export function log(line: string): void {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}\n`;
  try {
    appendFileSync(LOG_PATH, msg);
  } catch {
    // Ignore: the stderr line below is our fallback.
  }
  // eslint-disable-next-line no-console
  console.error(line);
}