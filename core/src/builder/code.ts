// The builder's code view: a spec value pretty-printed into lines, with the lines changed
// since the previous version marked. A pure function for the shell spec:
// `jsonLines(app.spec.screens[focus], last(app.history)?.screens[focus])`.

export interface CodeLine {
  id: string;
  text: string;
  /** "add": new in this version; "del": was in the previous one; "same". */
  kind: "same" | "add" | "del";
}

const pretty = (v: unknown) => (v === undefined ? [] : JSON.stringify(v, null, 2).split("\n"));

export function jsonLines(value: unknown, previous?: unknown): CodeLine[] {
  const now = pretty(value);
  if (previous === undefined || JSON.stringify(previous) === JSON.stringify(value)) {
    return now.map((text, i) => ({ id: `s${i}`, text, kind: "same" }));
  }
  const before = pretty(previous);
  // A line diff by longest common subsequence; large specs skip it rather than stall.
  const n = before.length;
  const m = now.length;
  if (n * m > 400_000) return now.map((text, i) => ({ id: `s${i}`, text, kind: "same" }));
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === now[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: CodeLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === now[j]) {
      out.push({ id: `s${j}`, text: now[j], kind: "same" });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // Removed lines before the lines that replace them, as diffs read.
      out.push({ id: `d${i}`, text: before[i], kind: "del" });
      i++;
    } else {
      out.push({ id: `a${j}`, text: now[j], kind: "add" });
      j++;
    }
  }
  return out;
}
