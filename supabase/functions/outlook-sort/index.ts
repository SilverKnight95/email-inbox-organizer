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
const PROTECTED_DESTINATIONS = new Set(["inbox", "deleted items", "deleted", "trash", "junk email", "junk", "drafts", "sent items"]);

Deno.serve(async (request) => {
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

  const supabase = supabaseClient();
  const claimed = await supabase.rpcClaim(slot);
  if (!claimed) return json({ action: "skip", reason: "duplicate", slot });

  let accounts: OrganizerAccount[];
  try {
    accounts = await supabase.accounts();
  } catch {
    await supabase.finish(claimed, "failed");
    return json({ action: "failed", slot, error: "account list was not read" }, 500);
  }
  if (accounts.length !== 3) {
    await supabase.finish(claimed, "failed");
    return json({ action: "failed", slot, error: "expected three personal Outlook accounts" }, 500);
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
        mode: "apply", filed: 0, complete: false, error: "manual filing is not enabled for this account",
      });
      await supabase.finish(claimed, "failed");
      return json({ action: "failed", slot, results: [{ account_label: account.label, complete: false, stored, error: "manual filing is not enabled for this account" }] }, 403);
    }
    return await applyOneAccount({ body, slot, runId: claimed, account, supabase });
  }

  const results = [];
  for (const account of accounts) {
    if (account.provider !== "outlook" || account.role !== "personal") {
      results.push({ account_id: account.id, complete: false, stored: false, error: "account is not an eligible personal Outlook dry run" });
      continue;
    }
    try {
      const scan = await scanAccount(account, supabase);
      const summary = classifyInbox(scan.messages, rules);
      summary.complete = scan.complete;
      const error = scan.complete ? null : "partial scan";
      const stored = await supabase.saveResult(claimed, account.id, summary, {
        mode: "dry_run", filed: 0, complete: scan.complete, error,
      });
      results.push({
        account_id: account.id,
        complete: stored && scan.complete,
        stored,
        error: stored ? error : "result write failed",
        ...(body.preview === true && stored && scan.complete ? {
          account_label: account.label,
          proposed_moves: previewMoves(scan.messages, rules).map(({ from, subject, folder }) => ({ from, subject, folder })),
          apply_batch_size: Math.min(previewMoves(scan.messages, rules).length, 5),
          preview_hash: await previewDigest(account.label, previewMoves(scan.messages, rules)),
        } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "account run failed";
      const stored = await supabase.saveResult(claimed, account.id, blankSummary(), {
        mode: "dry_run", filed: 0, complete: false, error: message,
      });
      results.push({ account_id: account.id, complete: false, stored, error: stored ? message : "result write failed" });
    }
  }
  const status = runStatus(results);
  const finished = await supabase.finish(claimed, status);
  if (!finished) return json({ action: "failed", slot, error: "run status was not saved", results }, 500);
  return json({ action: status, slot, apply: false, results }, status === "dry_run_complete" ? 200 : 500);
});

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
  body: RequestBody;
  slot: string;
  runId: string;
  account: OrganizerAccount;
  supabase: ReturnType<typeof supabaseClient>;
}) {
  const summary = blankSummary();
  let scan: Awaited<ReturnType<typeof scanAccount>>;
  try {
    scan = await scanAccount(account, supabase);
  } catch (error) {
    const message = error instanceof Error ? error.message : "account run failed";
    const stored = await supabase.saveResult(runId, account.id, summary, {
      mode: "apply", filed: 0, complete: false, error: message,
    });
    await supabase.finish(runId, "failed");
    return json({ action: "failed", slot, results: [{ account_label: account.label, complete: false, stored, moved: 0, error: stored ? message : "result write failed" }] }, 500);
  }

  const candidates = previewMoves(scan.messages, rules);
  const batch = manualBatch(candidates);
  const hash = await previewDigest(account.label, candidates);
  summary.inbox_scanned = scan.messages.length;
  summary.would_file = candidates.length;
  for (const candidate of candidates) summary.by_folder[candidate.folder] = (summary.by_folder[candidate.folder] ?? 0) + 1;
  if (!scan.complete || batch.length === 0 || hash !== body.preview_hash) {
    const error = !scan.complete ? "partial scan; no messages moved" : batch.length === 0 ? "no eligible messages in the reviewed batch" : "preview changed; no messages moved";
    const stored = await supabase.saveResult(runId, account.id, summary, {
      mode: "apply", filed: 0, complete: false, error,
      details: { attempted: 0, moved: 0, skipped: 0, failed: 0, deferred: Math.max(0, candidates.length - batch.length) },
    });
    await supabase.finish(runId, "failed");
    return json({ action: "failed", slot, results: [{ account_label: account.label, complete: false, stored, scanned: scan.messages.length, eligible: candidates.length, attempted: 0, moved: 0, error: stored ? error : "result write failed" }] }, 409);
  }

  let folderIds: Map<string, string>;
  try {
    folderIds = await resolveDestinationFolders(scan.accessToken, batch.map((move) => move.folder));
  } catch {
    const error = "one or more destination folders could not be resolved safely; no messages moved";
    const stored = await supabase.saveResult(runId, account.id, summary, {
      mode: "apply", filed: 0, complete: false, error,
      details: { attempted: 0, moved: 0, skipped: 0, failed: batch.length, deferred: candidates.length - batch.length },
    });
    await supabase.finish(runId, "failed");
    return json({ action: "failed", slot, results: [{ account_label: account.label, complete: false, stored, scanned: scan.messages.length, eligible: candidates.length, attempted: 0, moved: 0, error: stored ? error : "result write failed" }] }, 500);
  }

  let moved = 0;
  let skipped = 0;
  let failed = 0;
  const movedByFolder: Record<string, number> = {};
  for (const candidate of batch) {
    try {
      const current = await getMessage(scan.accessToken, candidate.messageId);
      if (current.parentFolderId !== scan.inboxId || current.isRead !== true ||
        current.flag?.flagStatus === "flagged" || fileDecision(current, rules) !== `file:${candidate.folder}`) {
        skipped++;
        continue;
      }
      const folderId = folderIds.get(candidate.folder.toLowerCase());
      if (!folderId) {
        failed++;
        continue;
      }
      await moveMessage(scan.accessToken, candidate.messageId, folderId);
      moved++;
      movedByFolder[candidate.folder] = (movedByFolder[candidate.folder] ?? 0) + 1;
    } catch {
      // Do not expose message identifiers or Graph payloads in response/database.
      failed++;
    }
  }
  const complete = moved === batch.length && skipped === 0 && failed === 0;
  const error = complete ? null : "some reviewed messages changed or could not be filed";
  const stored = await supabase.saveResult(runId, account.id, {
    ...summary,
    by_folder: movedByFolder,
  }, {
    mode: "apply", filed: moved, complete, error,
    details: { attempted: batch.length, moved, skipped, failed, deferred: candidates.length - batch.length },
  });
  const status = !stored ? "failed" : complete ? "apply_complete" : "apply_partial";
  const finished = await supabase.finish(runId, status);
  const result = {
    account_label: account.label,
    complete: complete && stored && finished,
    stored,
    scanned: scan.messages.length,
    eligible: candidates.length,
    attempted: batch.length,
    moved,
    skipped,
    failed,
    deferred: candidates.length - batch.length,
    error: stored ? error : "result write failed",
  };
  return json({ action: status, slot, preview_run_key: body.preview_run_key, apply: true, results: [result] }, complete && stored && finished ? 200 : 207);
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
  return {
    async rpcClaim(slot: string) {
      const response = await fetch(`${url}/rest/v1/organizer_runs`, {
        method: "POST",
        headers: { ...headers, prefer: "return=representation,resolution=ignore-duplicates" },
        body: JSON.stringify({ slot_key: slot, status: "running" }),
      });
      if (response.status === 409) return null;
      if (!response.ok) throw new Error("run claim was not saved");
      const rows = await response.json();
      return Array.isArray(rows) && rows[0] ? rows[0].id : null;
    },
    async accounts(): Promise<OrganizerAccount[]> {
      const response = await fetch(`${url}/rest/v1/organizer_accounts?enabled=eq.true&provider=eq.outlook&role=eq.personal&select=id,label,provider,role,enabled,apply_enabled&limit=3`, { headers });
      if (!response.ok) throw new Error("account list was not read");
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error("account list was not read");
      return rows;
    },
    async token(accountId: string) {
      const response = await fetch(`${url}/rest/v1/rpc/organizer_refresh_token`, {
        method: "POST", headers, body: JSON.stringify({ account_id: accountId }),
      });
      if (!response.ok) throw new Error("token lookup failed");
      const token = await response.json();
      if (typeof token !== "string" || token.length === 0) throw new Error("token lookup failed");
      return token;
    },
    async storeToken(accountId: string, token: string) {
      const response = await fetch(`${url}/rest/v1/rpc/organizer_store_refresh_token`, {
        method: "POST", headers, body: JSON.stringify({ account_id: accountId, token }),
      });
      if (!response.ok) throw new Error("refresh token rotation was not saved");
    },
    async saveResult(runId: string, accountId: string, summary: ReturnType<typeof blankSummary>, result: {
      mode: "dry_run" | "apply"; filed: number; complete: boolean; error: string | null;
      details?: Record<string, number>;
    }) {
      const response = await fetch(`${url}/rest/v1/organizer_run_results`, {
        method: "POST", headers,
        body: JSON.stringify({
          run_id: runId, account_id: accountId, mode: result.mode,
          inbox_scanned: summary.inbox_scanned, would_file: summary.would_file,
          left_unread: summary.left_unread, left_flagged: summary.left_flagged,
          left_for_review: summary.left_for_review, filed: result.filed,
          complete: result.complete, error: result.error,
          summary: { by_folder: summary.by_folder, ...(result.details ?? {}) },
        }),
      });
      return response.ok;
    },
    async finish(runId: string, status: string) {
      const response = await fetch(`${url}/rest/v1/organizer_runs?id=eq.${runId}`, {
        method: "PATCH", headers: { ...headers, prefer: "return=representation" },
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
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const result = new Map<string, string>();
  let next: string | null = `${GRAPH}/me/mailFolders?$top=100&$select=id,displayName`;
  while (next) {
    const response = await graphFetch(accessToken, next);
    const page = await response.json();
    for (const folder of page.value ?? []) {
      const name = String(folder.displayName ?? "").trim();
      const key = name.toLowerCase();
      if (!wanted.has(key)) continue;
      if (PROTECTED_DESTINATIONS.has(key)) throw new Error("protected destination");
      if (result.has(key)) throw new Error("ambiguous destination folder");
      if (typeof folder.id !== "string") throw new Error("destination folder id missing");
      result.set(key, folder.id);
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
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, prefer: 'IdType="ImmutableId"' } });
  if (!response.ok) throw new Error("mailbox request failed");
  return response;
}
