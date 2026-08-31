export class LoopError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "LoopError";
    this.code = code;
  }
}

export const DEFAULT_INTERVAL = "5m";
export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const COMPACT = /^(\d+)(s|m|h|d)$/;

export interface ParsedInterval {
  compact: string;
  ms: number;
  raised: boolean;
}

export function parseInterval(token: string): ParsedInterval {
  const match = COMPACT.exec(token.trim());
  if (!match) {
    throw new LoopError("INVALID_INTERVAL", `not a compact interval: ${token}`);
  }
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new LoopError("INVALID_INTERVAL", "interval must be a positive integer");
  }
  const unit = match[2] as "s" | "m" | "h" | "d";
  let ms = n * 1000;
  if (unit === "m") ms = n * 60_000;
  else if (unit === "h") ms = n * 3_600_000;
  else if (unit === "d") ms = n * 86_400_000;
  if (ms > MAX_INTERVAL_MS) {
    throw new LoopError("INVALID_INTERVAL", `${token} exceeds the 7-day session TTL`);
  }
  if (ms < MIN_INTERVAL_MS) {
    return { compact: "60s", ms: MIN_INTERVAL_MS, raised: true };
  }
  return { compact: `${n}${unit}`, ms, raised: false };
}
