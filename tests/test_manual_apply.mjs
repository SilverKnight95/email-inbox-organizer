import assert from "node:assert/strict";
import { manualBatch, previewDigest, MAX_MANUAL_MOVES } from "../supabase/functions/outlook-sort/apply.ts";
import { resolveSlot } from "../supabase/functions/outlook-sort/auth.ts";
import { classifyInbox, previewMoves } from "../supabase/functions/outlook-sort/policy.ts";

const at = new Date("2026-09-28T12:00:00Z");
assert.equal(resolveSlot({ apply: true }, at).status, 403, "scheduled apply must be rejected");
assert.equal(resolveSlot({ manual: true, apply: true, run_key: "apply001" }, at).apply, true);
assert.equal(resolveSlot({ manual: true, apply: true, preview: true, run_key: "apply001" }, at).status, 400);
assert.equal(resolveSlot({ manual: true, apply: false, run_key: "preview001" }, at).apply, false);

const rules = { auto_file: [{ match: "domain", value: "offers.example", folder: "Promotions" }] };
const messages = [
  { id: "1", subject: "Sale", from: { emailAddress: { address: "news@offers.example" } }, isRead: true, body: { secret: "never returned" } },
  { id: "2", subject: "Unread sale", from: { emailAddress: { address: "news@offers.example" } }, isRead: false },
  { id: "3", subject: "Flagged sale", from: { emailAddress: { address: "news@offers.example" } }, isRead: true, flag: { flagStatus: "flagged" } },
  { id: "4", subject: "OAuth Application Approval", from: { emailAddress: { address: "news@offers.example" } }, isRead: true },
  { id: "5", subject: "Unknown read state", from: { emailAddress: { address: "news@offers.example" } } },
  { id: "6", subject: "Personal", from: { emailAddress: { address: "friend@example.org" } }, isRead: true },
];
const summary = classifyInbox(messages, rules);
const moves = previewMoves(messages, rules);
assert.equal(summary.would_file, 1);
assert.equal(summary.left_unread, 1);
assert.equal(summary.left_flagged, 1);
assert.equal(summary.left_for_review, 3);
assert.equal(moves.length, 1);
assert.equal(moves[0].folder, "Promotions");
assert.equal(JSON.stringify(moves).includes("never returned"), false);

const oversized = Array.from({ length: 8 }, (_, index) => ({
  messageId: `id-${index}`, from: "news@offers.example", subject: `Sale ${index}`, folder: "Promotions",
}));
assert.equal(manualBatch(oversized).length, MAX_MANUAL_MOVES);
const digest = await previewDigest("personal-outlook-1", oversized);
assert.match(digest, /^[a-f0-9]{64}$/);
assert.equal(await previewDigest("personal-outlook-1", [...oversized].reverse()), digest, "candidate order must not change digest");
assert.notEqual(await previewDigest("personal-outlook-1", oversized.map((item, i) => i ? item : { ...item, subject: "Different subject" })), digest,
  "changed preview metadata must invalidate confirmation");
assert.notEqual(await previewDigest("personal-outlook-2", oversized), digest, "digest must be account-bound");
console.log("manual apply tests passed");

const permissive = { ...rules, never_move_unread: false, skip_flagged: false };
assert.equal(previewMoves(messages, permissive).length, 1, "safety guards cannot be disabled by rules");
