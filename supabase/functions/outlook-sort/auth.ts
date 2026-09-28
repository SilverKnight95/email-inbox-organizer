import { chicagoSlot } from "./policy.ts";

export function invocationAllowed(authorization: string | null, secret: string | undefined) {
  if (!secret || !authorization || !authorization.startsWith("Bearer ")) return false;
  const presented = authorization.slice("Bearer ".length);
  if (presented.length !== secret.length) return false;
  let mismatch = 0;
  for (let i = 0; i < presented.length; i++) mismatch |= presented.charCodeAt(i) ^ secret.charCodeAt(i);
  return mismatch === 0;
}

export function manualSlot(runKey: string) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(runKey || "")) throw new Error("invalid manual run key");
  return `manual:${runKey}`;
}

export function runStatus(results: Array<{ complete?: boolean; error?: string | null; stored?: boolean }>, expected = 3) {
  if (results.length !== expected || results.some((result) => result.stored !== true)) return "failed";
  if (results.some((result) => result.error && result.error !== "partial scan")) return "failed";
  if (results.some((result) => result.complete !== true)) return "incomplete";
  return "dry_run_complete";
}

export function resolveSlot(body: { manual?: boolean; run_key?: string; apply?: boolean; preview?: boolean }, now: Date) {
  if (body.apply === true && body.manual !== true) {
    return { status: 403, body: { error: "live filing is manual only" } };
  }
  if (body.apply === true && body.preview === true) {
    return { status: 400, body: { error: "apply and preview cannot be combined" } };
  }
  if (body.manual === true) {
    return { status: 200, slot: manualSlot(body.run_key ?? ""), apply: body.apply === true };
  }
  const slot = chicagoSlot(now);
  if (!slot) return { status: 200, body: { action: "skip", reason: "outside schedule" } };
  return { status: 200, slot, apply: false };
}
