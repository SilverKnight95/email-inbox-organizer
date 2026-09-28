import assert from "node:assert/strict";
globalThis.Deno = { serve() {}, env: { get() {} } };
const { resolveDestinationFolders } = await import("../supabase/functions/outlook-sort/index.ts");
const GRAPH = "https://graph.microsoft.com/v1.0";

async function resolve(pages, names) {
  let calls = 0;
  globalThis.fetch = async (url) => {
    const system = new URL(url).pathname.match(/\/mailFolders\/(inbox|deleteditems|junkemail|drafts|sentitems|outbox)$/);
    if (system) return Response.json({ id: `${system[1]}-id` });
    assert.equal(url.startsWith(GRAPH + "/me/mailFolders?"), true);
    assert.equal(url.includes("/childFolders"), false);
    const page = pages[calls++];
    assert.ok(page, "unexpected request");
    return Response.json(page);
  };
  return resolveDestinationFolders("synthetic-token", names);
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

for (const name of ["inbox", "deleteditems", "junkemail", "drafts", "sentitems", "outbox"]) {
  await assert.rejects(resolve([{ value: [{ id: `${name}-id`, displayName: "Promotions" }] }], ["Promotions"]), /protected/);
}
await assert.rejects(resolve([{}], ["Promotions"]), /invalid folder page/);
await assert.rejects(resolve([{ value: [], "@odata.nextLink": GRAPH + "/me/mailFolders?$top=100&$select=id,displayName,parentFolderId" }], ["Promotions"]), /repeated/);
console.log("folder resolver: localized system folders and malformed pagination passed");
