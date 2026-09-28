// Dry-run only. Does not unsubscribe, send, trash, or move mail.
// Gmail is not handled. A school mailbox must not be stored.

import { classifyInbox, chicagoSlot } from "./policy.ts";
import rules from "./rules.json" with { type: "json" };

const GRAPH = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }
  const body = await request.json().catch(() => ({}));
  if (body.apply === true) {
    return json({ error: "live filing is disabled until a dry run has been reviewed" }, 403);
  }

  const now = new Date();
  const slot = chicagoSlot(now);
  if (!slot) {
    return json({ action: "skip", reason: "outside schedule" });
  }

  const supabase = supabaseClient();
  const claimed = await supabase.rpcClaim(slot);
  if (!claimed) {
    return json({ action: "skip", reason: "duplicate", slot });
  }

  const accounts = await supabase.accounts();
  const results = [];
  for (const account of accounts) {
    if (account.provider !== "outlook" || account.role !== "personal" || account.apply_enabled) {
      results.push({ account_id: account.id, error: "account is not an eligible personal Outlook dry run" });
      continue;
    }
    try {
      const refreshToken = await supabase.token(account.id);
      const access = await refreshAccessToken(refreshToken);
      const messages = await listInbox(access);
      const summary = classifyInbox(messages, rules);
      await supabase.saveResult(claimed, account.id, summary);
      results.push({ account_id: account.id, ...summary });
    } catch (error) {
      const message = error instanceof Error ? error.message : "account run failed";
      await supabase.saveResult(claimed, account.id, emptySummary(), message);
      results.push({ account_id: account.id, error: "account run failed" });
    }
  }
  await supabase.finish(claimed);
  return json({ action: "dry_run", slot, apply: false, results });
});

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
      const rows = await response.json();
      return Array.isArray(rows) && rows[0] ? rows[0].id : null;
    },
    async accounts() {
      const response = await fetch(
        `${url}/rest/v1/organizer_accounts?enabled=eq.true&provider=eq.outlook&role=eq.personal&select=id,provider,role,apply_enabled,token_secret_id&limit=3`,
        { headers },
      );
      return response.json();
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
    async saveResult(runId: string, accountId: string, summary: ReturnType<typeof emptySummary>, error?: string) {
      await fetch(`${url}/rest/v1/organizer_run_results`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          run_id: runId,
          account_id: accountId,
          mode: "dry_run",
          ...summary,
          filed: 0,
          error: error ?? null,
          summary: { by_folder: summary.by_folder },
        }),
      });
    },
    async finish(runId: string) {
      await fetch(`${url}/rest/v1/organizer_runs?id=eq.${runId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "dry_run_complete", finished_at: new Date().toISOString() }),
      });
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
  if (!payload.access_token) {
    throw new Error("token refresh failed");
  }
  return payload.access_token as string;
}

async function listInbox(accessToken: string) {
  const messages = [];
  let skip = 0;
  while (skip <= 5000) {
    const url = new URL(`${GRAPH}/me/mailFolders/inbox/messages`);
    url.searchParams.set("$top", "50");
    url.searchParams.set("$skip", String(skip));
    url.searchParams.set("$select", "id,subject,from,isRead,flag");
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, prefer: 'IdType="ImmutableId"' },
    });
    if (!response.ok) {
      throw new Error("mailbox read failed");
    }
    const page = await response.json();
    const values = page.value ?? [];
    if (!values.length) {
      break;
    }
    messages.push(...values);
    skip += values.length;
  }
  return messages;
}

export { classifyInbox };
