/**
 * Shared validation helpers for input builders.
 *
 * These checks mirror Noir circuit assertions but produce clear
 * error messages instead of cryptic circuit execution failures.
 */

const MIN_TIMESTAMP = 1609459200; // 2021-01-01
const MAX_TIMESTAMP = 1099511627776; // 2^40 (~year 36812)
const MAX_REPORTING_THRESHOLD = 204962515653461695n; // 2^64 / 90

export function validateSignal(signal: number, index: number): void {
  if (!Number.isInteger(signal) || signal < 0 || signal > 100) {
    throw new Error(`Signal[${String(index)}] must be 0-100, got ${String(signal)}`);
  }
}

export function validateWeight(weight: number, index: number, active: boolean): void {
  if (active && weight <= 0) {
    throw new Error(
      `Weight[${String(index)}] must be > 0 for active provider, got ${String(weight)}`,
    );
  }
  if (!active && weight !== 0) {
    throw new Error(
      `Weight[${String(index)}] must be 0 for inactive provider, got ${String(weight)}`,
    );
  }
}

export function validateProviderId(id: string, index: number, active: boolean): void {
  if (active && (id === "0" || id === "")) {
    throw new Error(`Provider ID[${String(index)}] must be non-zero for active provider`);
  }
  if (!active && id !== "0") {
    throw new Error(`Provider ID[${String(index)}] must be "0" for inactive provider, got "${id}"`);
  }
}

export function validateTimestamp(ts: number): void {
  if (ts < MIN_TIMESTAMP || ts >= MAX_TIMESTAMP) {
    throw new Error(
      `Timestamp must be in [${String(MIN_TIMESTAMP)}, ${String(MAX_TIMESTAMP)}), got ${String(ts)}`,
    );
  }
}

export function validateReportingThreshold(threshold: number): void {
  if (BigInt(threshold) > MAX_REPORTING_THRESHOLD) {
    throw new Error(
      `Reporting threshold must be <= ${String(MAX_REPORTING_THRESHOLD)}, got ${String(threshold)}`,
    );
  }
}

export function validateCredentialType(ct: number): void {
  if (!Number.isInteger(ct) || ct < 1 || ct > 4) {
    throw new Error(`Credential type must be 1-4, got ${String(ct)}`);
  }
}

/**
 * Reject a zero or malformed submitter. Mirrors `assert(submitter != 0)` in
 * every circuit -- the contract also rejects `submitter == address(0)`.
 */
export function validateSubmitter(submitter: string): void {
  if (typeof submitter !== "string" || !submitter.startsWith("0x")) {
    throw new Error(`submitter must be a 0x-prefixed hex string, got ${String(submitter)}`);
  }
  const body = submitter.slice(2);
  if (body.length === 0 || /^0+$/.test(body)) {
    throw new Error("submitter cannot be the zero address");
  }
}

export function validateActiveProviders(
  signals: number[],
  weights: number[],
  providerIds: string[],
  numProviders: number,
): void {
  for (let i = 0; i < 8; i++) {
    const active = i < numProviders;
    validateSignal(signals[i], i);
    validateWeight(weights[i], i, active);
    validateProviderId(providerIds[i], i, active);
  }

  const weightSum = weights.slice(0, numProviders).reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    throw new Error("Weight sum must be > 0");
  }
}
