// One scanner for unbounded repetition, shared by the gate and the tests.
//
// The naive version of this check -- `regex.includes(".*")` -- is wrong twice
// over. It misses bare `*` and `+`, which is how a vendor rule like
// `xoxb-[0-9]{10,13}[a-zA-Z0-9-]*` gets an unbounded tail while looking
// anchored; and it false-positives on a character class such as `[\w=~@.+/-]`,
// where `.` and `+` are literals. Both failures are silent, and a silent failure
// in a redactor's own safety gate is not acceptable, so the check walks the
// pattern the way the engine does: escapes and character classes included.

/**
 * Every unbounded repetition in `pattern`, as the tokens that carry it.
 *
 * Empty means fully bounded. `{n,}` is reported as written; a bare `*`/`+` is
 * reported as itself.
 */
export function unboundedIn(pattern: string): string[] {
  const found: string[] = [];
  for (const match of pattern.matchAll(/\{\d+,\}/g)) found.push(match[0]);

  let inClass = false;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 2; // the escaped character is a literal, whatever it is
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      i += 1;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      i += 1;
      if (pattern[i] === "^") i += 1;
      // A `]` right after `[` or `[^` is a literal member, not the closing one.
      if (pattern[i] === "]") i += 1;
      continue;
    }
    if (ch === "*" || ch === "+") {
      found.push(ch);
      i += 1;
      continue;
    }
    i += 1;
  }
  return found;
}

/** True when `pattern` is fully bounded. */
export function isBounded(pattern: string): boolean {
  return unboundedIn(pattern).length === 0;
}
