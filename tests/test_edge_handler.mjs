import assert from "node:assert/strict";
import rules from "../supabase/functions/outlook-sort/rules.json" with { type: "json" };
import { previewDigest } from "../supabase/functions/outlook-sort/apply.ts";
import { previewMoves } from "../supabase/functions/outlook-sort/policy.ts";

const env = { ORGANIZER_INVOKE_SECRET: "synthetic-secret", SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "synthetic-key" };
globalThis.Deno = { serve() {}, env: { get: (key) => env[key] } };
const { handleRequest } = await import("../supabase/functions/outlook-sort/index.ts");
const accounts = Array.from({ length: 3 }, (_, i) => ({ id: `account-${i}`, label: `personal-outlook-${i + 1}`, provider: "outlook", role: "personal", enabled: true, apply_enabled: true }));
const rule = rules.auto_file.find((rule) => rule.match === "domain_suffix" && !rule.include_subject);
assert.ok(rule, "fixture requires a broad domain rule");
const message = { id: "message-1", subject: "Weekly product news", from: { emailAddress: { address: `news@${rule.value}` } }, isRead: true, flag: { flagStatus: "notFlagged" }, parentFolderId: "inbox-id" };
assert.equal(previewMoves([message], rules).length, 1);
const hash = await previewDigest(accounts[0].label, previewMoves([message], rules));
const dry = { manual: true, run_key: "review001", preview: true };
const apply = { manual: true, apply: true, run_key: "apply001", preview_run_key: "review001", account_label: accounts[0].label, preview_hash: hash, confirmation: "FILE REVIEWED PREVIEW" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

async function invoke(body, options = {}) {
  const calls = [], saved = [], statuses = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url: url.href, method: init.method ?? "GET" });
    if (url.hostname === "database.example") {
      const path = url.pathname;
      if (path.endsWith("organizer_runs")) {
        if (init.method === "POST") {
          if (options.claimFailure) throw new Error("private provider details");
          return reply(options.duplicate ? [] : [{ id: "run-id" }]);
        }
        if (init.method === "PATCH") {
          statuses.push(JSON.parse(init.body).status);
          if (options.finishFailure) throw new Error("private provider details");
          return reply(options.missingRun ? [] : [{ id: "run-id" }]);
        }
        return reply(options.missingPreview ? [] : [{ id: "preview-id" }]);
      }
      if (path.endsWith("organizer_accounts")) return reply(url.searchParams.has("id") ? [{ ...accounts[0], apply_enabled: !options.revoked }] : (options.accounts ?? accounts));
      if (path.endsWith("organizer_refresh_token")) return reply("refresh-token");
      if (path.endsWith("organizer_run_results")) {
        if (init.method !== "POST") return reply([{ id: "result-id", summary: { preview_hash: hash } }]);
        saved.push(JSON.parse(init.body));
        if (options.saveFailure) throw new Error("private provider details");
        return new Response(null, { status: 201 });
      }
    }
    if (url.hostname === "login.microsoftonline.com") return reply({ access_token: "access-token", refresh_token: "refresh-token" });
    if (url.hostname === "graph.microsoft.com") {
      if (url.pathname.endsWith("/move")) return new Response(null, { status: 201 });
      assert.equal(init.redirect, "error");
      if (url.pathname.endsWith("/messages/message-1")) return reply(options.changedMessage ?? message);
      if (url.pathname.endsWith("/messages")) {
        if (options.scanFailure) throw new Error("private provider details");
        return reply(options.page ?? { value: [message] });
      }
      if (url.pathname.endsWith("/mailFolders")) return reply({ value: [{ id: "destination-id", displayName: rule.folder }] });
      if (url.pathname.includes("/mailFolders/")) return reply({ id: `${url.pathname.split("/").at(-1)}-id` });
    }
    throw new Error(`unexpected test request: ${url.href}`);
  };
  const response = await handleRequest(new Request("https://function.example", { method: "POST", headers: { authorization: "Bearer synthetic-secret" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { status: response.status, body: await response.json(), calls, saved, statuses };
}

for (const body of ["{", "null", "[]", "false", { manual: "true" }, { apply: "true" }, { manual: true, run_key: 12345678 }]) {
  const result = await invoke(body);
  assert.equal(result.status, 400);
  assert.equal(result.calls.length, 0, "invalid requests must not claim or scan");
}
assert.equal((await invoke(dry, { claimFailure: true })).status, 500);
assert.equal((await invoke(dry, { duplicate: true })).calls.length, 1);
let result = await invoke(dry);
assert.equal(result.body.action, "dry_run_complete");
assert.equal(result.body.results.length, 3);
assert.equal(result.body.results[0].preview_hash, hash);
assert.ok(result.calls.every((call) => !call.url.endsWith("/move")));
assert.equal(JSON.stringify(result.body).includes(message.id), false);
for (const options of [{ saveFailure: true }, { scanFailure: true, saveFailure: true }, { finishFailure: true }, { missingRun: true }]) {
  result = await invoke(dry, options);
  assert.equal(result.status, 500);
  assert.equal(result.statuses.length, 1, "terminal update attempted even if saving failed");
  assert.equal(JSON.stringify(result.body).includes("private provider details"), false);
}
for (const page of [{}, { value: {} }, { value: [null] }, { value: [message, message] }, { value: [], "@odata.nextLink": false }, { value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=50&$select=id,subject,from,isRead,flag,parentFolderId" }, { value: [], "@odata.nextLink": "https://untrusted.example/page" }]) {
  result = await invoke(dry, { page });
  assert.equal(result.body.action, "failed");
  assert.equal(result.body.results.length, 3);
  assert.ok(result.calls.length < 20, "bad pagination must terminate");
  assert.ok(result.calls.every((call) => !call.url.includes("untrusted.example")));
}
result = await invoke(apply);
assert.equal(result.status, 200);
assert.equal(result.body.results[0].moved, 1);
assert.equal(result.calls.filter((call) => call.url.endsWith("/move")).length, 1);
result = await invoke(apply, { saveFailure: true });
assert.equal(result.status, 207);
assert.equal(result.body.action, "apply_partial");
assert.equal(result.body.results[0].moved, 1);
assert.deepEqual(result.statuses, ["apply_partial"]);
result = await invoke(apply, { changedMessage: { ...message, isRead: false } });
assert.equal(result.body.results[0].skipped, 1);
assert.equal(result.calls.filter((call) => call.url.endsWith("/move")).length, 0);
console.log("edge handler: validation, scan integrity, previews, apply, and persistence failures passed");

for (const invalidAccounts of [[...accounts, { ...accounts[0], id: "extra" }], [accounts[0], accounts[0], accounts[2]], [accounts[0], accounts[1], { ...accounts[2], label: "unknown-account" }]]) {
  result = await invoke(dry, { accounts: invalidAccounts });
  assert.equal(result.status, 500);
  assert.ok(result.calls.every((call) => !call.url.includes("graph.microsoft.com")));
}
for (const options of [{ missingPreview: true }, { revoked: true }]) {
  result = await invoke(apply, options);
  assert.ok(result.calls.every((call) => !call.url.endsWith("/move")));
}
result = await invoke({ ...apply, preview_hash: "0".repeat(64) });
assert.equal(result.status, 409);
assert.ok(result.calls.every((call) => !call.url.endsWith("/move")));
result = await invoke(apply, { finishFailure: true });
assert.equal(result.status, 207);
assert.equal(result.body.action, "apply_partial");
assert.equal(result.body.results[0].moved, 1);
assert.equal(result.body.results[0].complete, false);
console.log("edge handler: account roster, preview binding, revocation, and apply finalization passed");
