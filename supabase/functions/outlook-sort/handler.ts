// Scheduled calls are dry-run only. Filing is available only through the
// authenticated manual path after an exact per-account preview is reviewed.
// Gmail is not handled; school mailboxes are not eligible accounts.

import { invocationAllowed, manualSlot, resolveSlot, runStatus } from "./auth.ts";
import { isDigest, manualBatch, previewDigest } from "./apply.ts";
import { classifyInbox, fileDecision, previewMoves } from "./policy.ts";
import rules from "./rules.json" with { type: "json" };

const GRAPH = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const ACCOUNT_LABELS = new Set(["personal-outlook-1", "personal-outlook-2", "personal-outlook-3"]);
const PROTECTED_DESTINATIONS = new Set(["inbox", "deleted items", "deleted", "trash", "junk email", "junk", "drafts", "sent items", "outbox"]);

export async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!invocationAllowed(request.headers.get("authorization"), Deno.env.get("ORGANIZER_INVOKE_SECRET"))) {
    return json({ error: "unauthorized" }, 401);
  }
  const parsed = await request.json().catch(() => ({}));
  const body: RequestBody = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  if (body.preview === true && body.manual !== true) return json({ error: "preview requires a manual run" }, 400);

  const applying = body.apply === true;
  let slot: string;
  try {
    if (applying) validateApplyRequest(body);
    const resolved = resolveSlot(body, new Date());
    if (resolved.status !== 200) return json(resolved.body, resolved.status);
    if (!resolved.slot) return json(resolved.body, resolved.status);
    slot = resolved.slot;
  } catch {
    return json({ error: "invalid manual apply request" }, 400);
  }

  const selected = body.manual === true ? body.account_label : undefined;
  if (selected !== undefined && !ACCOUNT_LABELS.has(selected)) return json({ error: "unknown account label" }, 400);
  const supabase = supabaseClient();
  let claimed: string | null;
  try { claimed = await supabase.rpcClaim(slot, body.preview === true); }
  catch { return json({ action: "failed", error: "run claim was not saved" }, 503); }
  if (!claimed) return json({ action: "skip", reason: "duplicate", slot });

  let accounts: OrganizerAccount[];
  try {
    accounts = await supabase.accounts(selected);
  } catch {
    await supabase.finish(claimed, "failed");
    return json({ action: "failed", slot, error: "account list was not read" }, 500);
  }
  if (accounts.length !== (selected ? 1 : 3)) {
    await supabase.finish(claimed, "failed");
    return json({ action: "failed", slot, error: selected ? "selected personal Outlook account is unavailable" : "expected three configured personal Outlook accounts" }, 500);
  }

  if (applying) {
    const account = accounts.find((item) => item.label === body.account_label);
    if (!account || !account.enabled || account.provider !== "outlook" || account.role !== "personal") {
      await supabase.finish(claimed, "failed");
      return json({ action: "failed", slot, error: "selected account is not an enabled personal Outlook account" }, 403);
    }
    if (!account.apply_enabled) {
      const summary = blankSummary();
      const stored = await supabase.saveResult(claimed, account.id, summary, {
        mode: "apply",
        filed: 0,
        complete: false,
        error: "manual filing is not enabled for this account",
      });
      await supabase.finish(claimed, "failed");
      return json({ action: "failed", slot, results: [{
        account_label: account.label, complete: false, stored,
        scanned: 0, eligible: 0, attempted: 0, moved: 0, skipped: 0, failed: 0, deferred: 0,
        error: stored ? "manual filing is not enabled for this account" : "result write failed",
      }] }, 403);
    }
    return await applyOneAccount({ body, slot, runId: claimed, account, supabase });
  }

  const results = [];
  for (const account of accounts) {
    if (!account.enabled) {
      const stored = await supabase.saveResult(claimed, account.id, blankSummary(), {
        mode: "dry_run", filed: 0, complete: false, error: "account disabled",
      }).catch(() => false);
      results.push({ account_label: account.label, complete: false, stored, error: "account disabled" });
      continue;
    }
    if (account.provider !== "outlook" || account.role !== "personal") {
      results.push({ account_id: account.id, complete: false, stored: false, error: "account is not an eligible personal Outlook dry run" });
      continue;
    }
    try {
      const scan = await scanAccount(account, supabase);
      const summary = { ...classifyInbox(scan.messages, rules), complete: scan.complete };
      const error = scan.complete ? null : "partial scan";
      const proposals = body.preview === true && scan.complete ? previewMoves(scan.messages, rules) : [];
      const previewHash = proposals.length > 0 ? await previewDigest(account.label, proposals) : null;
      const summaryWithHash = previewHash ? { ...summary, preview_hash: previewHash } : summary;
      const stored = await supabase.saveResult(claimed, account.id, summaryWithHash, {
        mode: "dry_run",
        filed: 0,
        complete: scan.complete,
        error,
      });
      const batchIds = new Set(manualBatch(proposals).map((move) => move.messageId));
      results.push({
        account_id: account.id,
        complete: stored && scan.complete,
        stored,
        error: stored ? error : "result write failed",
        ...(body.preview === true && stored && scan.complete ? {
          account_label: account.label,
          proposed_moves: proposals.map(({ messageId, from, subject, folder }) => ({
            from, subject, folder, in_apply_batch: batchIds.has(messageId),
          })),
          apply_batch_size: batchIds.size,
          preview_hash: previewHash,
        } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "account run failed";
      const stored = await supabase.saveResult(claimed, account.id, blankSummary(), {
        mode: "dry_run",
        filed: 0,
        complete: false,
        error: message,
      });
      results.push({ account_id: account.id, complete: false, stored, error: stored ? message : "result write failed" });
    }
  }
  const status = runStatus(results, selected ? 1 : 3);
  const finished = await supabase.finish(claimed, status);
  if (!finished) return json({ action: "failed", slot, error: "run status was not saved", results }, 500);
  return json({
    action: status,
    slot,
    apply: false,
    ...(body.preview === true ? { preview_run_key: body.run_key } : {}),
    results,
  }, status === "dry_run_complete" ? 200 : 500);
}


type OrganizerAccount = {
  id: string;
  label: string;
  provider: string;
  role: string;
  enabled: boolean;
  apply_enabled: boolean;
};

type RequestBody = {
  manual?: boolean;
  preview?: boolean;
  apply?: boolean;
  run_key?: string;
  preview_run_key?: string;
  account_label?: string;
  preview_hash?: unknown;
  confirmation?: unknown;
};

function validateApplyRequest(body: RequestBody) {
  if (body.manual !== true || body.preview === true) throw new Error("manual apply only");
  if (typeof body.run_key !== "string") throw new Error("run key missing");
  const applySlot = manualSlot(body.run_key);
  if (typeof body.preview_run_key !== "string" || manualSlot(body.preview_run_key) === applySlot) {
    throw new Error("a different preview run key is required");
  }
  if (typeof body.account_label !== "string" || !ACCOUNT_LABELS.has(body.account_label)) {
    throw new Error("unknown account label");
  }
  if (!isDigest(body.preview_hash) || body.confirmation !== "FILE REVIEWED PREVIEW") {
    throw new Error("review confirmation is incomplete");
  }
}

async function applyOneAccount({ body, slot, runId, account, supabase }: {
  body: RequestBody; slot: string; runId: string; account: OrganizerAccount;
  supabase: ReturnType<typeof supabaseClient>;
}) {
  // A persistent account lease is acquired before refreshing tokens or scanning.
  // It never expires automatically: an interrupted Graph request needs reconciliation.
  let acquired = false;
  try { acquired = await supabase.beginApply(runId, account.id); }
  catch {
    return json({ action: "recovery_required", slot, run_id: runId,
      error: "apply claim outcome unknown; inspect journal before retrying" }, 503);
  }
  if (!acquired) {
    await supabase.finish(runId, "failed").catch(() => false);
    return json({ action: "blocked", slot, error: "account busy or manual filing disabled" }, 409);
  }
  let scanned = 0, eligible = 0, batchSize = 0, attempted = 0, moved = 0, skipped = 0, failed = 0;
  let pending = 0;
  let revoked = false;
  let auditUncertain = false;
  let error: string | null = null;
  try {
    const preview = await supabase.verifyPreview(body.preview_run_key!, account.id);
    if (!preview) throw new Error("the referenced completed manual preview was not found for this account");
    const scan = await scanAccount(account, supabase);
    scanned = scan.messages.length;
    const candidates = previewMoves(scan.messages, rules);
    const batch = manualBatch(candidates);
    eligible = candidates.length;
    batchSize = batch.length;
    try { await supabase.planApply(runId, scanned, eligible, batchSize); }
    catch { auditUncertain = true; throw new Error("apply plan was not acknowledged"); }
    const hash = await previewDigest(account.label, candidates);
    if (!scan.complete) throw new Error("partial scan; no messages moved");
    if (!batchSize) throw new Error("no eligible messages in the reviewed batch");
    if (hash !== body.preview_hash || hash !== preview.preview_hash) throw new Error("preview changed; no messages moved");
    const folderIds = await resolveDestinationFolders(scan.accessToken, batch.map((move) => move.folder));
    for (const [index, candidate] of batch.entries()) {
      let outcome = "skipped";
      let current;
      try { current = await getMessage(scan.accessToken, candidate.messageId); }
      catch { outcome = "failed"; }
      const currentFrom = current?.from?.emailAddress?.address ?? "";
      const safe = current && current.parentFolderId === scan.inboxId && current.isRead === true &&
        current.flag?.flagStatus === "notFlagged" && (current.subject ?? "") === candidate.subject &&
        currentFrom.toLowerCase() === candidate.from.toLowerCase() &&
        fileDecision(current, rules) === `file:${candidate.folder}`;
      const enabled = !revoked && await supabase.applyEnabled(account.id).catch(() => false);
      if (!enabled) revoked = true;
      if (safe && enabled) {
        // Commit intent BEFORE Graph. A lost response leaves this pending, never retried.
        try { await supabase.stepApply(runId, index + 1, "pending"); }
        catch { auditUncertain = true; throw new Error("move intent was not acknowledged"); }
        pending = 1;
        attempted++;
        try { await moveMessage(scan.accessToken, candidate.messageId, folderIds.get(candidate.folder)!); }
        catch { throw new Error("move outcome unknown; reconciliation required"); }
        moved++;
        outcome = "moved";
      }
      try { await supabase.stepApply(runId, index + 1, outcome); }
      catch { auditUncertain = true; throw new Error("move progress was not acknowledged"); }
      pending = 0;
      if (outcome === "skipped") skipped++;
      if (outcome === "failed") failed++;
    }
    if (moved !== batchSize) error = "some reviewed messages changed, were disabled, or could not be read";
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "account run failed";
  }
  let status = "recovery_required";
  let stored = false;
  if (!pending && !auditUncertain) {
    try { status = await supabase.finishApply(runId, error); stored = true; }
    catch { error = "final audit transaction was not acknowledged; inspect journal"; }
  }
  return json({ action: status, slot, run_id: runId, preview_run_key: body.preview_run_key, apply: true,
    results: [{ account_label: account.label, complete: status === "apply_complete", stored,
      scanned, eligible, attempted, moved, skipped, failed, pending: auditUncertain ? null : pending,
      deferred: Math.max(0, eligible - batchSize),
      unprocessed: Math.max(0, batchSize - moved - skipped - failed),
      recovery_required: status === "recovery_required", error }],
  }, status === "apply_complete" ? 200 : 207);
}

function blankSummary() {
  return {
    inbox_scanned: 0,
    would_file: 0,
    left_unread: 0,
    left_flagged: 0,
    left_for_review: 0,
    filed: 0,
    by_folder: {} as Record<string, number>,
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function supabaseClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("supabase service configuration is missing");
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
  async function rpc(name: string, body: Record<string, unknown>) {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error("audit database request failed");
    if (response.status === 204) return null;
    const text = await response.text();
    return text.length === 0 ? null : JSON.parse(text);
  }
  return {
    async beginApply(runId: string, accountId: string) {
      return await rpc("organizer_begin_apply", { p_run: runId, p_account: accountId }) === true;
    },
    async planApply(runId: string, scanned: number, eligible: number, batch: number) {
      await rpc("organizer_plan_apply", { p_run: runId, p_scanned: scanned, p_eligible: eligible, p_batch: batch });
    },
    async stepApply(runId: string, step: number, outcome: string) {
      await rpc("organizer_step_apply", { p_run: runId, p_step: step, p_outcome: outcome });
    },
    async finishApply(runId: string, error: string | null) {
      return await rpc("organizer_finish_apply", { p_run: runId, p_error: error }) as string;
    },
    async rpcClaim(slot: string, preview = false) {
      return await rpc("organizer_claim_run", { p_slot: slot, p_preview: preview }) as string | null;
    },
    async accounts(label?: string): Promise<OrganizerAccount[]> {
      const labels = label ? `eq.${encodeURIComponent(label)}` : `in.(${[...ACCOUNT_LABELS].join(",")})`;
      const response = await fetch(`${url}/rest/v1/organizer_accounts?label=${labels}&provider=eq.outlook&role=eq.personal&select=id,label,provider,role,enabled,apply_enabled`, { headers });
      if (!response.ok) throw new Error("account list was not read");
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error("account list was not read");
      return rows;
    },
    async verifyPreview(previewRunKey: string, accountId: string) {
      const runResponse = await fetch(
        `${url}/rest/v1/organizer_runs?slot_key=eq.${encodeURIComponent(`manual:${previewRunKey}`)}&status=in.(dry_run_complete,incomplete,failed)&finished_at=not.is.null&preview=eq.true&select=id&limit=1`,
        { headers },
      );
      if (!runResponse.ok) return null;
      const runs = await runResponse.json();
      if (!Array.isArray(runs) || typeof runs[0]?.id !== "string") return null;
      const resultResponse = await fetch(
        `${url}/rest/v1/organizer_run_results?run_id=eq.${encodeURIComponent(runs[0].id)}&account_id=eq.${encodeURIComponent(accountId)}&mode=eq.dry_run&complete=eq.true&select=id,summary&limit=1`,
        { headers },
      );
      if (!resultResponse.ok) return null;
      const results = await resultResponse.json();
      if (!Array.isArray(results) || results.length === 0 || !results[0] || typeof results[0].id !== "string") return null;
      const summary = results[0].summary;
      const previewHash = summary && typeof summary === "object" && typeof (summary as Record<string, unknown>).preview_hash === "string"
        ? (summary as Record<string, unknown>).preview_hash
        : null;
      if (typeof previewHash !== "string") return null;
      return { runId: runs[0].id, preview_hash: previewHash };
    },
    async applyEnabled(accountId: string) {
      const response = await fetch(
        `${url}/rest/v1/organizer_accounts?id=eq.${encodeURIComponent(accountId)}&select=enabled,apply_enabled&limit=1`,
        { headers },
      );
      if (!response.ok) return false;
      const rows = await response.json();
      return Array.isArray(rows) && rows[0]?.enabled === true && rows[0]?.apply_enabled === true;
    },
    async token(accountId: string) {
      const response = await fetch(`${url}/rest/v1/rpc/organizer_refresh_token`, {
        method: "POST",
        headers,
        body: JSON.stringify({ account_id: accountId }),
      });
      if (!response.ok) throw new Error("token lookup failed");
      const token = await response.json();
      if (typeof token !== "string" || token.length === 0) throw new Error("token lookup failed");
      return token;
    },
    async storeToken(accountId: string, token: string) {
      const response = await fetch(`${url}/rest/v1/rpc/organizer_store_refresh_token`, {
        method: "POST",
        headers,
        body: JSON.stringify({ account_id: accountId, token }),
      });
      if (!response.ok) throw new Error("refresh token rotation was not saved");
    },
    async saveResult(runId: string, accountId: string, summary: ReturnType<typeof blankSummary>, result: {
      mode: "dry_run" | "apply";
      filed: number;
      complete: boolean;
      error: string | null;
      details?: Record<string, number>;
    }) {
      const response = await fetch(`${url}/rest/v1/organizer_run_results`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          run_id: runId,
          account_id: accountId,
          mode: result.mode,
          inbox_scanned: summary.inbox_scanned,
          would_file: summary.would_file,
          left_unread: summary.left_unread,
          left_flagged: summary.left_flagged,
          left_for_review: summary.left_for_review,
          filed: result.filed,
          complete: result.complete,
          error: result.error,
          summary: { by_folder: summary.by_folder, ...(result.details ?? {}), ...(typeof (summary as Record<string, unknown>).preview_hash === "string" ? { preview_hash: (summary as Record<string, unknown>).preview_hash } : {}) },
        }),
      });
      return response.ok;
    },
    async finish(runId: string, status: string) {
      const response = await fetch(`${url}/rest/v1/organizer_runs?id=eq.${runId}`, {
        method: "PATCH",
        headers: { ...headers, prefer: "return=representation" },
        body: JSON.stringify({ status, finished_at: new Date().toISOString() }),
      });
      return response.ok;
    },
  };
}

async function scanAccount(account: OrganizerAccount, supabase: ReturnType<typeof supabaseClient>) {
  const refreshToken = await supabase.token(account.id);
  const refreshed = await refreshAccessToken(refreshToken);
  if (refreshed.refreshToken !== refreshToken) await supabase.storeToken(account.id, refreshed.refreshToken);
  return { ...(await listInbox(refreshed.accessToken)), accessToken: refreshed.accessToken };
}

async function refreshAccessToken(refreshToken: string) {
  const form = new URLSearchParams({
    client_id: Deno.env.get("AZURE_CLIENT_ID") ?? "",
    client_secret: Deno.env.get("AZURE_CLIENT_SECRET") ?? "",
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read",
  });
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  if (!response.ok) throw new Error("token refresh failed");
  const payload = await response.json();
  if (!payload.access_token || !payload.refresh_token) throw new Error("token refresh failed");
  return { accessToken: String(payload.access_token), refreshToken: String(payload.refresh_token) };
}

async function listInbox(accessToken: string) {
  const folderResponse = await graphFetch(accessToken, `${GRAPH}/me/mailFolders/inbox?$select=id`);
  const inbox = await folderResponse.json();
  if (typeof inbox.id !== "string") throw new Error("inbox was not identified");
  const messages = [];
  let next: string | null = `${GRAPH}/me/mailFolders/inbox/messages?$top=50&$select=id,subject,from,isRead,flag,parentFolderId`;
  while (next) {
    const response = await graphFetch(accessToken, next);
    const page = await response.json();
    messages.push(...(page.value ?? []));
    next = page["@odata.nextLink"] ?? null;
    if (next && messages.length >= 10000) return { messages, complete: false, inboxId: inbox.id };
  }
  return { messages, complete: true, inboxId: inbox.id };
}

async function resolveDestinationFolders(accessToken: string, names: string[]) {
  // Match the configured display name exactly; no trimming or case folding.
  const wanted = new Set(names);
  for (const name of wanted) {
    if (PROTECTED_DESTINATIONS.has(name.trim().toLowerCase())) throw new Error("protected destination");
  }
  const wantedFolded = new Set([...wanted].map((name) => name.trim().toLowerCase()));
  const result = new Map<string, string>();
  const seenFolded = new Set<string>();
  let next: string | null = `${GRAPH}/me/mailFolders?$top=100&$select=id,displayName,parentFolderId`;
  while (next) {
    const response = await graphFetch(accessToken, next);
    const page = await response.json();
    for (const folder of page.value ?? []) {
      const name = String(folder.displayName ?? "");
      const folded = name.trim().toLowerCase();
      if (!wantedFolded.has(folded)) continue;
      if (PROTECTED_DESTINATIONS.has(folded)) throw new Error("protected destination");
      // Near-duplicates (case or spacing variants) make the destination ambiguous.
      if (seenFolded.has(folded)) throw new Error("ambiguous destination folder");
      seenFolded.add(folded);
      if (!wanted.has(name)) continue;
      // /me/mailFolders returns root children; their parentFolderId is the mailbox root.
      if (typeof folder.id !== "string") throw new Error("destination folder id missing");
      result.set(name, folder.id);
    }
    next = page["@odata.nextLink"] ?? null;
  }
  if (result.size !== wanted.size) throw new Error("destination folder missing");
  return result;
}

async function getMessage(accessToken: string, messageId: string) {
  const response = await graphFetch(accessToken, `${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=id,subject,from,isRead,flag,parentFolderId`);
  return await response.json();
}

async function moveMessage(accessToken: string, messageId: string, destinationId: string) {
  const response = await fetch(`${GRAPH}/me/messages/${encodeURIComponent(messageId)}/move`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", prefer: 'IdType="ImmutableId"' },
    body: JSON.stringify({ destinationId }),
  });
  if (response.status !== 201) throw new Error("message move failed");
}

async function graphFetch(accessToken: string, url: string) {
  // Never send the mailbox token off-host, including via @odata.nextLink.
  if (!url.startsWith(`${GRAPH}/`)) throw new Error("unexpected Graph URL");
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, prefer: 'IdType="ImmutableId"' } });
  if (!response.ok) throw new Error("mailbox request failed");
  return response;
}

export { classifyInbox };

