/**
 * Lightweight `.env` loader.
 *
 * Reads a `.env` file from disk and sets each variable on `process.env`,
 * **overriding any pre-existing value**. This is the behaviour most apps
 * want for local development: `.env` should win over the shell.
 *
 * Supports `KEY=VALUE`, optional quoting (single or double), and `#` line
 * comments. Blank lines are skipped. No variable expansion is performed —
 * keep it dependency-free.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnv(filePath: string, { override = true } = {}): void {
  const abs = resolve(filePath);
  if (!existsSync(abs)) return;
  const text = readFileSync(abs, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of matching quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Strip an inline `# comment` after the value.
    const hash = value.indexOf(" #");
    if (hash >= 0) value = value.slice(0, hash).trim();

    if (!override && process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}
