// Dry-run only. Does not unsubscribe, send, trash, or move mail.
// Gmail is not handled. A school mailbox must not be stored.

import { invocationAllowed, resolveSlot } from "./auth.ts";
import { classifyInbox } from "./policy.ts";
import rules from "./rules.json" with { type: "json" };

const GRAPH = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }
  if (!invocationAllowed(request.headers.get("authorization"), Deno.env.get("ORGANIZER_INVOKE_SECRET"))) {
    return json({ error: "unauthorized" }, 401);
  }
  const body = await request.json().catch(() => ({}));
  let resolved
  try {
    resolved = resolveSlot(body, new Date());
  } catch {
    return json({ error: "invalid manual run key" }, 400);
  }
  if (resolved.status === 403) {
    return json(resolved.body, 403);
  }
  if (!resolved.slot) {
    return json(resolved.body, resolved.status);
  }
  const slot = resolved.slot;

  const supabase = supabaseClient();
  const claimed = await supabase.rpcClaim(slot);
  if (!claimed) {
    return json({ action: "skip", reason: "duplicate", slot });
  }

  let accounts
  try {
    accounts = await supabase.accounts();
  } catch {
    await supabase.finish(claimed, "failed");
    return json({ action: "failed", slot, error: "account list was not read" }, 500);
  }
  const results = [];
  for (const account of accounts) {
    if (account.provider !== "outlook" || account.role !== "personal" || account.apply_enabled) {
      results.push({ account_id: account.id, error: "account is not an eligible personal Outlook dry run" });
      continue;
    }
    try {
      const refreshToken = await supabase.token(account.id);
      const refreshed = await refreshAccessToken(refreshToken);
      if (refreshed.refreshToken !== refreshToken) {
        await supabase.storeToken(account.id, refreshed.refreshToken);
      }
      const scan = await listInbox(refreshed.accessToken);
      const summary = classifyInbox(scan.messages, rules);
      summary.complete = scan.complete;
      if (!scan.complete) {
        summary.error = "partial scan";
      }
      await supabase.saveResult(claimed, account.id, summary, summary.error);
      results.push({ account_id: account.id, complete: scan.complete, error: summary.error ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "account run failed";
      const saved = await supabase.saveResult(claimed, account.id, emptySummary(), message);
      results.push({ account_id: account.id, complete: false, error: saved ? message : "result write failed" });
    }
  }
  const status = runStatus(results);
  const finished = await supabase.finish(claimed, status);
  if (!finished) {
    return json({ action: "failed", slot, error: "run status was not saved", results }, 500);
  }
  return json({ action: status, slot, apply: false, results }, status === "dry_run_complete" ? 200 : 500);
});

function runStatus(results: Array<{ complete?: boolean; error?: string | null }>) {
  if (!results.length || results.some((result) => result.error && result.error !== "partial scan")) {
    return "failed";
  }
  if (results.some((result) => result.complete === false)) {
    return "incomplete";
  }
  return "dry_run_complete";
}

function emptySummary() {
  return {
    inbox_scanned: 0,
    would_file: 0,
    left_unread: 0,
    left_flagged: 0,
    left_for_review: 0,
    filed: 0,
    by_folder: {},
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function supabaseClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("supabase service configuration is missing");
  }
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  return {
    async rpcClaim(slot: string) {
      const response = await fetch(`${url}/rest/v1/organizer_runs`, {
        method: "POST",
        headers: { ...headers, prefer: "return=representation,resolution=ignore-duplicates" },
        body: JSON.stringify({ slot_key: slot, status: "running" }),
      });
      if (response.status === 409) {
        return null;
      }
      if (!response.ok) {
        throw new Error("run claim was not saved");
      }
      const rows = await response.json();
      return Array.isArray(rows) && rows[0] ? rows[0].id : null;
    },
    async accounts() {
      const response = await fetch(
        `${url}/rest/v1/organizer_accounts?enabled=eq.true&provider=eq.outlook&role=eq.personal&select=id,provider,role,apply_enabled&limit=3`,
        { headers },
      );
      if (!response.ok) {
        throw new Error("account list was not read");
      }
      const rows = await response.json();
      if (!Array.isArray(rows)) {
        throw new Error("account list was not read");
      }
      return rows;
    },
    async token(accountId: string) {
      const response = await fetch(`${url}/rest/v1/rpc/organizer_refresh_token`, {
        method: "POST",
        headers,
        body: JSON.stringify({ account_id: accountId }),
      });
      if (!response.ok) {
        throw new Error("token lookup failed");
      }
      const token = await response.json();
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("token lookup failed");
      }
      return token;
    },
    async storeToken(accountId: string, token: string) {
      const response = await fetch(`${url}/rest/v1/rpc/organizer_store_refresh_token`, {
        method: "POST",
        headers,
        body: JSON.stringify({ account_id: accountId, token }),
      });
      if (!response.ok) {
        throw new Error("refresh token rotation was not saved");
      }
    },
    async saveResult(runId: string, accountId: string, summary: ReturnType<typeof emptySummary> & { complete?: boolean }, error?: string) {
      const response = await fetch(`${url}/rest/v1/organizer_run_results`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          run_id: runId,
          account_id: accountId,
          mode: "dry_run",
          inbox_scanned: summary.inbox_scanned,
          would_file: summary.would_file,
          left_unread: summary.left_unread,
          left_flagged: summary.left_flagged,
          left_for_review: summary.left_for_review,
          filed: 0,
          complete: summary.complete === true && !error,
          error: error ?? null,
          summary: { by_folder: summary.by_folder },
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

async function refreshAccessToken(refreshToken: string) {
  const form = new URLSearchParams({
    client_id: Deno.env.get("AZURE_CLIENT_ID") ?? "",
    client_secret: Deno.env.get("AZURE_CLIENT_SECRET") ?? "",
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read",
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) {
    throw new Error("token refresh failed");
  }
  const payload = await response.json();
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error("token refresh failed");
  }
  return { accessToken: String(payload.access_token), refreshToken: String(payload.refresh_token) };
}

async function listInbox(accessToken: string) {
  const messages = [];
  let next: string | null = `${GRAPH}/me/mailFolders/inbox/messages?$top=50&$select=id,subject,from,isRead,flag`;
  while (next) {
    const response = await fetch(next, {
      headers: { authorization: `Bearer ${accessToken}`, prefer: 'IdType="ImmutableId"' },
    });
    if (!response.ok) {
      throw new Error("mailbox read failed");
    }
    const page = await response.json();
    messages.push(...(page.value ?? []));
    next = page["@odata.nextLink"] ?? null;
    if (next && messages.length >= 10000) {
      return { messages, complete: false };
    }
  }
  return { messages, complete: true };
}

export { classifyInbox };
