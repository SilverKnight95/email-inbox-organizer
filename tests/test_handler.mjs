import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { database, rpc } from './database.mjs';
import { handler } from '../supabase/functions/outlook-sort/handler.ts';
import { fileDecision } from '../supabase/functions/outlook-sort/policy.ts';
import rules from '../supabase/functions/outlook-sort/rules.json' with {type:'json'};
const db = await database();
after(()=>db.close());
const env = { ORGANIZER_INVOKE_SECRET:'synthetic-invoke', SUPABASE_URL:'https://db.test', SUPABASE_SERVICE_ROLE_KEY:'synthetic-service', AZURE_CLIENT_ID:'synthetic-client', AZURE_CLIENT_SECRET:'synthetic-secret' };
globalThis.Deno = { env: { get: k=>env[k] } };
let messages, moves, refreshes, fault, pages, reads, rotations;
const label = 'personal-outlook-1';
let serial = 0;
const account = (await db.query('select id from organizer_accounts where label=$1',[label])).rows[0].id;
// Pick an existing filing rule so the handler uses its real checked-in policy.
const rule = rules.auto_file.find(r=>r.match==='domain' && !r.include_subject);
const sample = id=>({id,subject:'Seasonal special',from:{emailAddress:{address:'news@'+rule.value}},isRead:true,flag:{flagStatus:'notFlagged'},parentFolderId:'inbox-id'});
assert.equal(fileDecision(sample('x'),rules),'file:'+rule.folder);
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
async function reset(count=2) {
  await db.exec('delete from organizer_apply_journal; delete from organizer_run_results; delete from organizer_runs; update organizer_accounts set enabled=false,apply_enabled=false');
  await db.query('update organizer_accounts set enabled=true,apply_enabled=true where id=$1',[account]);
  messages=Array.from({length:count},(_,i)=>sample('message-'+i));moves=[];refreshes=0;fault={};pages=0;reads=0;rotations=0;
}
globalThis.fetch=async(input,options={})=>{
  const url=new URL(input); const body=options.body && typeof options.body==='string'?JSON.parse(options.body):{};
  if(url.hostname==='db.test') {
    const name=url.pathname.split('/').at(-1);
    if(url.pathname.includes('/rpc/')) {
      if(name==='organizer_refresh_token') return response('synthetic-refresh');
      if(name==='organizer_store_refresh_token') { rotations++; if(fault.rotation) return response({},500);return response(null); }
      if(name==='organizer_step_apply' && fault.intent && body.p_outcome==='pending') {
        if(fault.intent==='after') await rpc(db,name,body);
        throw Error('lost intent');
      }
      if(name==='organizer_step_apply' && fault.progress && body.p_outcome==='moved') {
        if(fault.progress==='after') await rpc(db,name,body);
        throw Error('lost progress');
      }
      if(name==='organizer_finish_apply' && fault.finish) {
        if(fault.finish==='after') await rpc(db,name,body);
        throw Error('lost finish');
      }
      if(fault.rpcHttp && name==='organizer_plan_apply') return new Response(null,{status:500});
      try {
        const result = await rpc(db,name,body);
        if (name === 'organizer_plan_apply' || name === 'organizer_step_apply') {
          return new Response(null, {status: fault.empty200 ? 200 : 204});
        }
        return response(result);
      } catch(e) { return response({error:e.message},400); }
    }
    if(options.method==='POST') {
      const keys=Object.keys(body);await db.query(`insert into ${name}(${keys.join(',')}) values (${keys.map((_,i)=>'$'+(i+1))})`,Object.values(body));return response(null,201);
    }
    if(options.method==='PATCH') {
      const id=url.searchParams.get('id').slice(3);
      await db.query('update organizer_runs set status=$1,finished_at=$2 where id=$3',[body.status,body.finished_at,id]);return response([{id}]);
    }
    const clauses=[],values=[];
    for(const [key,value] of url.searchParams) {
      if(['select','limit'].includes(key)) continue;
      if(value.startsWith('eq.')) {values.push(['enabled','apply_enabled','complete','preview'].includes(key)?value.slice(3)==='true':value.slice(3));clauses.push(`${key}=$${values.length}`);}
      else if(value.startsWith('in.(')) {const v=value.slice(4,-1).split(',');const ph=v.map(x=>{values.push(x);return '$'+values.length});clauses.push(`${key} in (${ph})`);}
      else if(value==='not.is.null') clauses.push(`${key} is not null`);
      else throw Error('unsupported filter '+value);
    }
    return response((await db.query(`select * from ${name} ${clauses.length?'where '+clauses.join(' and '):''}`,values)).rows);
  }
  if(url.hostname==='login.microsoftonline.com') {refreshes++;return response({access_token:'synthetic-access',refresh_token:fault.rotation?'rotated-token':'synthetic-refresh'});}
  assert.equal(url.hostname,'graph.microsoft.com');
  if(url.pathname.endsWith('/move')) {
    const id=decodeURIComponent(url.pathname.split('/').at(-2));
    if(fault.gate) {await fault.gate;}
    moves.push(id);messages=messages.filter(m=>m.id!==id);
    if(fault.revoke) await db.query('update organizer_accounts set apply_enabled=false where id=$1',[account]);
    if(fault.move) throw Error('response lost after Graph moved message');
    return response({id},201);
  }
  if(url.pathname.endsWith('/mailFolders/inbox')) return response({id:'inbox-id'});
  if(url.pathname.endsWith('/mailFolders')) return response({value:[{id:'target-id',displayName:rule.folder,parentFolderId:'root'}]});
  if(url.pathname.endsWith('/inbox/messages')) {
    pages++;
    if(fault.partial) return response({value:Array.from({length:10000},(_,i)=>sample('m'+i)),'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?more=1'});
    if(fault.pagination && !url.searchParams.has('more')) return response({value:messages.slice(0,1),'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?more=1'});
    return response({value:fault.pagination?messages.slice(1):messages});
  }
  if(url.pathname.includes('/me/messages/')) {
    reads++;const m=structuredClone(messages.find(m=>m.id===decodeURIComponent(url.pathname.split('/').at(-1))));
    if(fault.flag) m.flag=fault.flag;
    if(fault.unread) m.isRead=false;
    return response(m);
  }
  throw Error('unhandled request '+url);
};
async function call(body) {
  const result=await handler(new Request('https://function.test',{method:'POST',headers:{authorization:'Bearer synthetic-invoke','content-type':'application/json'},body:JSON.stringify(body)}));
  return {status:result.status,...await result.json()};
}
const key=()=>`test-run-${++serial}`;
async function preview(extra={}) {return call({manual:true,preview:true,apply:false,run_key:key(),account_label:label,...extra});}
function applyBody(p) { return {manual:true,apply:true,run_key:key(),preview_run_key:p.preview_run_key,account_label:label,preview_hash:p.results.find(r=>r.account_label===label).preview_hash,confirmation:'FILE REVIEWED PREVIEW'}; }
async function journal() {return (await db.query('select * from organizer_apply_journal')).rows[0];}

test('one selected account works with the other two disabled; permanent duplicate claim', async()=>{
  await reset();const p=await preview();assert.equal(p.status,200);assert.equal(p.results.length,1);
  const b=applyBody(p), result=await call(b);assert.equal(result.action,'apply_complete',JSON.stringify(result));assert.equal(moves.length,2);
  assert.equal((await call(b)).reason,'duplicate');assert.equal(moves.length,2);
  const j=await journal();assert.equal(j.moved,2);assert.equal(j.active,false);
  const row=(await db.query("select * from organizer_run_results where mode='apply'")).rows[0];assert.equal(row.filed,2);assert.equal(row.summary.prepared,2);
});
test('all-account preview reports disabled accounts explicitly',async()=>{await reset();const p=await preview({account_label:undefined});assert.equal(p.results.length,3);assert.equal(p.results.filter(r=>r.error==='account disabled').length,2);assert.equal(refreshes,1);});
test('disabled and invalid selections do not read mail',async()=>{await reset();assert.equal((await preview({account_label:'college'})).status,400);const p=await preview({account_label:'personal-outlook-2'});assert.equal(p.results[0].error,'account disabled');assert.equal(refreshes,0);});
test('preview lookup and changed preview reject before moving',async()=>{
  await reset();const p=await preview();const b=applyBody(p);b.preview_run_key='missing-preview';assert.equal((await call(b)).action,'failed');assert.equal(moves.length,0);
  messages[0].subject='Different seasonal special';assert.equal((await call(applyBody(p))).action,'failed');assert.equal(moves.length,0);
});
test('missing/unknown/completed flag state is held in preview and immediate recheck',async()=>{
  for(const flag of [undefined,{}, {flagStatus:'unexpected'},{flagStatus:'complete'}]) {
    await reset(1);messages[0].flag=flag;assert.equal((await preview()).results[0].apply_batch_size,0);
  }
  await reset(1);const p=await preview();fault.flag={};const r=await call(applyBody(p));assert.equal(moves.length,0);assert.equal(r.results[0].skipped,1);assert.equal(r.results[0].attempted,0);
});
test('unread recheck skips, pagination completes, partial scan blocks',async()=>{
  await reset();fault.pagination=true;const p=await preview();assert.equal(p.results[0].apply_batch_size,2);assert.equal(pages,2);fault.unread=true;assert.equal((await call(applyBody(p))).results[0].skipped,2);assert.equal(moves.length,0);
  await reset();const p2=await preview();fault.partial=true;assert.equal((await call(applyBody(p2))).action,'failed');assert.equal(moves.length,0);
});
test('rotation failure prevents mailbox scan and releases lease',async()=>{await reset();const p=await preview();const before=pages;fault.rotation=true;const r=await call(applyBody(p));assert.equal(r.action,'failed');assert.equal(pages,before);assert.equal(rotations,1);assert.equal((await journal()).active,false);});
test('different run keys cannot overlap same account',async()=>{
  await reset();const p=await preview();let release;fault.gate=new Promise(r=>release=r);
  const first=call(applyBody(p));for(let i=0; !reads && i<200; i++) await new Promise(r=>setTimeout(r,1));
  const second=await call(applyBody(p));assert.equal(second.action,'blocked');release();assert.equal((await first).action,'apply_complete');assert.equal(moves.length,2);
});
test('intent failure before/after commit produces no Graph move and retains lease',async()=>{for(const mode of ['before','after']) {await reset();const p=await preview();fault.intent=mode;const r=await call(applyBody(p));assert.equal(r.action,'recovery_required');assert.equal(moves.length,0);assert.equal(r.results[0].pending,null);const j=await journal();assert.equal(j.active,true);assert.equal(j.pending,mode==='after'?1:0);}});
test('Graph response loss leaves durable unknown count and stops batch',async()=>{
  await reset();const p=await preview();const b=applyBody(p);fault.move=true;const r=await call(b);assert.equal(r.action,'recovery_required');assert.equal(moves.length,1);assert.equal((await journal()).pending,1);assert.equal((await journal()).moved,0);assert.equal((await call(b)).reason,'duplicate');assert.equal((await call(applyBody(p))).action,'blocked');
  const j=await journal();assert.equal(await rpc(db,'organizer_reconcile_apply',{p_run:j.run_id,p_pending_moved:true}),'apply_partial');assert.equal((await journal()).moved,1);assert.equal((await journal()).active,false);
});
test('progress response loss before/after SQL commit never triggers another move',async()=>{
  for(const mode of ['before','after']) {await reset();const p=await preview();fault.progress=mode;const r=await call(applyBody(p));assert.equal(r.action,'recovery_required');assert.equal(r.results[0].moved,1);assert.equal(moves.length,1);const j=await journal();assert.equal(j.active,true);assert.equal(j.pending,mode==='before'?1:0);assert.equal(j.moved,mode==='after'?1:0);}
});
test('final transaction response loss keeps journal truthful, before and after commit',async()=>{
  for(const mode of ['before','after']) {await reset();const p=await preview();fault.finish=mode;const r=await call(applyBody(p));assert.equal(r.action,'recovery_required');const j=await journal();assert.equal(j.moved,2);assert.equal(j.pending,0);assert.equal(j.active,mode==='before');assert.equal(r.results[0].complete,false);}
});

test('preserves merged revocation behavior and accurate partial counts',async()=>{
  await reset(3);const p=await preview();fault.revoke=true;const r=await call(applyBody(p));
  assert.equal(r.action,'apply_partial');assert.equal(r.results[0].moved,1);assert.equal(r.results[0].attempted,1);assert.equal(r.results[0].skipped,2);
  const j=await journal();assert.equal(j.moved,1);assert.equal(j.skipped,2);assert.equal(j.active,false);
});

test('successful empty 200 void RPC replies complete without retaining the lease',async()=>{
  await reset();const p=await preview();fault.empty200=true;const r=await call(applyBody(p));
  assert.equal(r.action,'apply_complete');assert.equal(moves.length,2);assert.equal((await journal()).active,false);
});
test('unsuccessful empty RPC replies still stop apply before any move',async()=>{
  await reset();const p=await preview();fault.rpcHttp=true;const r=await call(applyBody(p));
  assert.equal(r.action,'recovery_required');assert.equal(moves.length,0);assert.equal((await journal()).active,true);
});
