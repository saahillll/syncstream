// NTP style clock offset estimation over the gateway's clock:ping/clock:pong
// socket exchange. Transport agnostic on purpose: the caller (mobile/web app
// layer) owns the socket emit/listen and just feeds timing triples in here,
// so this stays unit testable without a real socket.

export interface ClockSample {
  offsetMs: number;
  rttMs: number;
}

export const CLOCK_SAMPLE_WINDOW = 5;
export const CLOCK_RESAMPLE_INTERVAL_MS = 30_000;

export class ClockSync {
  private samples: ClockSample[] = [];
  private readonly windowSize: number;

  constructor(windowSize: number = CLOCK_SAMPLE_WINDOW) {
    this.windowSize = windowSize;
  }

  // t0: local Date.now() taken immediately before emitting clock:ping.
  // serverTime: the serverTime field from the clock:pong payload.
  // t1: local Date.now() taken immediately after receiving clock:pong.
  // Assumes symmetric network latency, the standard NTP approximation.
  recordSample(t0: number, serverTime: number, t1: number): void {
    const rttMs = t1 - t0;
    const offsetMs = serverTime - (t0 + t1) / 2;
    this.samples.push({ offsetMs, rttMs });
    if (this.samples.length > this.windowSize) this.samples.shift();
  }

  // Rolling median offset, robust to a single outlier sample (e.g. one hit
  // by a wifi hiccup). 0 until the first sample lands.
  getOffsetMs(): number {
    if (this.samples.length === 0) return 0;
    const sorted = this.samples.map((s) => s.offsetMs).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  toServerTime(localTimeMs: number): number {
    return localTimeMs + this.getOffsetMs();
  }

  sampleCount(): number {
    return this.samples.length;
  }

  reset(): void {
    this.samples = [];
  }
}
