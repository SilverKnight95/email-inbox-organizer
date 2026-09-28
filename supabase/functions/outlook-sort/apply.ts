export type MoveCandidate = {
  messageId: string;
  from: string;
  subject: string;
  folder: string;
};

export const MAX_MANUAL_MOVES = 5;

export function manualBatch(moves: MoveCandidate[]) {
  return [...moves]
    .sort((a, b) => a.messageId.localeCompare(b.messageId))
    .slice(0, MAX_MANUAL_MOVES);
}

// The digest is an opaque confirmation for the exact first batch only; deferred
// candidates beyond MAX_MANUAL_MOVES are intentionally excluded so new mail
// outside the batch does not invalidate a reviewed preview. Message IDs stay
// server-side; only the digest and sender/subject/folder preview are sent.
export async function previewDigest(accountLabel: string, moves: MoveCandidate[]) {
  const ordered = manualBatch(moves).map(({ messageId, from, subject, folder }) => ({ messageId, from, subject, folder }));
  const bytes = new TextEncoder().encode(JSON.stringify({ accountLabel, moves: ordered }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
