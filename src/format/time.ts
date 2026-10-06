function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** "1:05" or "1:01:01" from whole seconds. */
function secondsToClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(sec)}` : `${String(m)}:${pad(sec)}`;
}

/** The `[M:SS]` clock of a text timestamp, floored to whole seconds. */
export function msToClock(ms: number): string {
  return secondsToClock(Math.floor(ms / 1000));
}

/** SRT cue time "HH:MM:SS,mmm", floored to whole milliseconds; VTT swaps the comma for a dot. */
export function srtTimestamp(ms: number, separator: "," | "." = ","): string {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(total % 1000, 3)}`;
}
