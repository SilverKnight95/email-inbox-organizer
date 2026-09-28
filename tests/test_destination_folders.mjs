import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../supabase/functions/outlook-sort/index.ts", import.meta.url), "utf8");
const start = source.indexOf("async function resolveDestinationFolders(");
const end = source.indexOf("\nasync function getMessage(", start);
const { stripTypeScriptTypes } = await import("node:module");
const resolverSource = stripTypeScriptTypes(source.slice(start, end));
const GRAPH = "https://graph.microsoft.com/v1.0";
const PROTECTED_DESTINATIONS = new Set(["inbox", "deleted items", "trash", "junk email", "drafts", "sent items"]);

async function resolve(pages, names) {
  let calls = 0;
  const graphFetch = async (_token, url) => {
    assert.equal(url.startsWith(GRAPH + "/me/mailFolders?"), true);
    assert.equal(url.includes("/childFolders"), false);
    const page = pages[calls++];
    assert.ok(page, "unexpected request");
    return { json: async () => page };
  };
  const resolver = new Function("GRAPH", "PROTECTED_DESTINATIONS", "graphFetch",
    resolverSource + "; return resolveDestinationFolders;")(GRAPH, PROTECTED_DESTINATIONS, graphFetch);
  return resolver("synthetic-token", names);
}
const rootChild = { id: "promotions-id", displayName: "Promotions", parentFolderId: "mailbox-root-id" };
assert.equal((await resolve([{ value: [rootChild] }], ["Promotions"])).get("Promotions"), "promotions-id");
await assert.rejects(resolve([{ value: [] }], ["Promotions"]), /missing/);
await assert.rejects(resolve([{ value: [{ ...rootChild, displayName: " Promotions " }] }], ["Promotions"]), /missing/);
await assert.rejects(resolve([{ value: [{ ...rootChild, displayName: "promotions" }] }], ["Promotions"]), /missing/);
await assert.rejects(resolve([{ value: [rootChild, { ...rootChild, id: "variant-id", displayName: "promotions" }] }], ["Promotions"]), /ambiguous/);
await assert.rejects(resolve([{ value: [rootChild, { ...rootChild, id: "duplicate-id" }] }], ["Promotions"]), /ambiguous/);
await assert.rejects(resolve([{ value: [{ id: "deleted-id", displayName: "Deleted Items", parentFolderId: "root-id" }] }], ["Deleted Items"]), /protected/);
const paged = await resolve([
  { value: [], "@odata.nextLink": GRAPH + "/me/mailFolders?$skiptoken=synthetic" },
  { value: [rootChild] },
], ["Promotions"]);
assert.equal(paged.get("Promotions"), "promotions-id");
console.log("folder resolver: root parent, missing, duplicate, protected, pagination passed");
