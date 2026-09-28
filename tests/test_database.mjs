import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { database, rpc } from './database.mjs';
const db=await database();after(()=>db.close());
const account=(await db.query("update organizer_accounts set enabled=true,apply_enabled=true where label='personal-outlook-1' returning id")).rows[0].id;
let serial=0;
async function begin() {
  const run=await rpc(db,'organizer_claim_run',{p_slot:'manual:sql-test-'+ ++serial,p_preview:false});
  assert.equal(await rpc(db,'organizer_begin_apply',{p_run:run,p_account:account}),true);return run;
}
async function step(run,n,outcome) {return rpc(db,'organizer_step_apply',{p_run:run,p_step:n,p_outcome:outcome});}
async function plan(run,n=2) {return rpc(db,'organizer_plan_apply',{p_run:run,p_scanned:n,p_eligible:n,p_batch:n});}
async function finish(run,error=null) {return rpc(db,'organizer_finish_apply',{p_run:run,p_error:error});}
async function clean() {await db.exec('delete from organizer_apply_journal; delete from organizer_run_results; delete from organizer_runs');}

test('SQL claim returns null for duplicates, including simultaneous claims',async()=>{
  await clean();const calls=await Promise.all([rpc(db,'organizer_claim_run',{p_slot:'manual:duplicate',p_preview:false}),rpc(db,'organizer_claim_run',{p_slot:'manual:duplicate',p_preview:false})]);assert.equal(calls.filter(Boolean).length,1);assert.equal(calls.filter(x=>x===null).length,1);
});
test('one account lease; sequential idempotent journal; unresolved intent blocks finalization',async()=>{
  await clean();const run=await begin();const other=await rpc(db,'organizer_claim_run',{p_slot:'manual:other-run',p_preview:false});
  assert.equal(await rpc(db,'organizer_begin_apply',{p_run:other,p_account:account}),false);
  await plan(run);await step(run,1,'pending');await step(run,1,'pending');
  await assert.rejects(finish(run),/pending/);await assert.rejects(step(run,2,'moved'),/unexpected/);
  await step(run,1,'moved');await step(run,1,'moved');await step(run,2,'skipped');
  assert.equal(await finish(run,'one skipped'),'apply_partial');assert.equal(await finish(run),'apply_partial');
  const j=(await db.query('select * from organizer_apply_journal where run_id=$1',[run])).rows[0];assert.equal(j.moved,1);assert.equal(j.prepared,1);assert.equal(j.skipped,1);
  await assert.rejects(step(run,2,'pending'),/inactive/);
  assert.equal(await rpc(db,'organizer_begin_apply',{p_run:other,p_account:account}),true);
});
test('result and status writes plus lease release are one atomic transaction',async()=>{
  for(const table of ['organizer_run_results','organizer_runs']) {
    await clean();const run=await begin();await plan(run,1);await step(run,1,'pending');await step(run,1,'moved');
    await db.exec(`create function reject_write() returns trigger language plpgsql as $$begin raise exception 'synthetic write failure'; end$$;
      create trigger fail_write before ${table==='organizer_runs'?'update':'insert'} on ${table} for each row execute function reject_write();`);
    await assert.rejects(finish(run),/synthetic write failure/);
    assert.equal((await db.query('select count(*)::int as n from organizer_run_results')).rows[0].n,0);
    const j=(await db.query('select * from organizer_apply_journal')).rows[0];assert.equal(j.active,true);assert.equal(j.moved,1);
    assert.equal((await db.query('select status from organizer_runs where id=$1',[run])).rows[0].status,'running');
    await db.exec(`drop trigger fail_write on ${table}; drop function reject_write();`);
    assert.equal(await finish(run),'apply_complete');
  }
});
test('admin reconciliation preserves prepared count for verified not-moved request',async()=>{
  await clean();const run=await begin();await plan(run);await step(run,1,'pending');
  await assert.rejects(rpc(db,'organizer_reconcile_apply',{p_run:run,p_pending_moved:null}),/verify/);
  assert.equal(await rpc(db,'organizer_reconcile_apply',{p_run:run,p_pending_moved:false}),'failed');
  const j=(await db.query('select * from organizer_apply_journal')).rows[0];assert.equal(j.prepared,1);assert.equal(j.failed,1);assert.equal(j.pending,0);assert.equal(j.active,false);
});
test('RLS and function grants keep journal private and reconciliation admin-only',async()=>{
  await clean();assert.equal((await db.query("select relrowsecurity from pg_class where relname='organizer_apply_journal'")).rows[0].relrowsecurity,true);
  for(const role of ['anon','authenticated']) {
    await db.exec('set role '+role);
    await assert.rejects(db.query('select * from organizer_apply_journal'),/permission denied/);
    await assert.rejects(rpc(db,'organizer_claim_run',{p_slot:'manual:denied',p_preview:false}),/permission denied/);
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  const run=await begin();await plan(run,1);await step(run,1,'pending');await step(run,1,'moved');assert.equal(await finish(run),'apply_complete');
  await assert.rejects(rpc(db,'organizer_reconcile_apply',{p_run:run,p_pending_moved:null}),/permission denied/);
  await db.exec('reset role');
});
test('new migration is transactional and leaves prior schema intact on failure',async()=>{
  // Remove only the newly added objects, then inject a failing statement before COMMIT.
  await db.exec(`drop table organizer_apply_journal cascade;
    drop function organizer_claim_run(text,boolean),organizer_begin_apply(uuid,uuid),organizer_plan_apply(uuid,integer,integer,integer),organizer_step_apply(uuid,integer,text),organizer_finish_apply(uuid,text),organizer_reconcile_apply(uuid,boolean);`);
  const sql=await readFile(new URL('../supabase/migrations/20260928225109_outlook_apply_journal.sql',import.meta.url),'utf8');
  await assert.rejects(db.exec(sql.replace('commit;',"select 1/0; commit;")),/division by zero/);
  await db.exec('rollback');
  assert.equal((await db.query("select to_regclass('public.organizer_apply_journal') as name")).rows[0].name,null);
  assert.notEqual((await db.query("select to_regclass('public.organizer_runs') as name")).rows[0].name,null);
  await db.exec(sql);
});
