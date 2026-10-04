const test=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {MemoryStore,MemoryEditConflict}=require('../dist/memoryStore');
const {MemoryProduction,bundleScope}=require('../dist/memoryProduction');
const {metadataFor,privacyEligible,authority}=require('../dist/memoryPolicy');
const {extractCandidates}=require('../dist/memoryExtraction');
const {supplementConversation}=require('../dist/memoryContext');
const {handleMemoryCommand,memoryCommandDefinition}=require('../dist/memoryCommands');
const {migrateDatabase}=require('../dist/database');
const scope={kinId:'vincent-villa',storyline:'villa-s1',guildId:'111111111111111111',channelId:'222222222222222222',discordBotId:'333333333333333333'};
const admin='444444444444444444';
const input={content:'Vincent promised Dee a conversation.',category:'promise',importance:3,tags:['promise']};
const candidate={...input,importance:8,confidence:0.6,subjects:[scope.kinId],sourceChannelId:scope.channelId,occurredAt:'2026-10-01T00:00:00Z',sourceMessageIds:['555555555555555555']};
const past='2026-01-01T00:00:00Z';
let pg,db,store,production;
test.before(async()=>{
 pg=await PGlite.create();
 // PGlite has one backend. Schedule whole client transactions exclusively, not individual
 // statements, so concurrent callers cannot accidentally share one backend transaction.
 let tail=Promise.resolve();
 const acquire=async()=>{let release;const next=new Promise(r=>release=r);const previous=tail;tail=next;await previous;return release;};
 const query=async(sql,values)=>{const r=values?await pg.query(sql,values):(await pg.exec(sql)).at(-1);return{rows:r.rows||[],rowCount:r.affectedRows||r.rows?.length||0};};
 db={query:async(...args)=>{const release=await acquire();try{return await query(...args);}finally{release();}},
  connect:async()=>{const release=await acquire();return{query,release};}};
 await migrateDatabase(db);await migrateDatabase(db);
 store=new MemoryStore(db);production=new MemoryProduction(store);
});
test.beforeEach(async()=>{await pg.exec('TRUNCATE memories,memory_contexts,memory_kins,memory_audit,memory_binding_history CASCADE');});
test.after(async()=>{await pg?.close();});

test('privacy gates precede ranking: pinned private/confessional/production notes never enter public prompts',async()=>{
 for(const visibility of ['public','private','confessional','production'])await store.add(scope,{...input,content:`${visibility} promise`,importance:5,metadata:{visibility,pinned:true}},admin);
 assert.deepEqual((await store.retrieve(scope,['promise'])).map(m=>m.metadata.visibility),['public']);
 assert.deepEqual(new Set((await store.retrieve({...scope,visibility:'private'},['promise'])).map(m=>m.metadata.visibility)),new Set(['public','private']));
 assert.deepEqual(new Set((await store.retrieve({...scope,visibility:'confessional'},['promise'])).map(m=>m.metadata.visibility)),new Set(['public','confessional']));
 assert.deepEqual(await store.retrieve({...scope,visibility:'production'},['promise']),[]);
 const recent=[{username:'Dee',text:'promise',timestamp:past}];
 const malicious=(await store.scan(scope)).filter(m=>m.metadata.visibility!=='public');
 assert.strictEqual(await supplementConversation({retrieve:async()=>malicious},scope,recent,'promise'),recent);
});
test('knowledge ownership and reveal times are explicit, scoped and cannot create retroactive omniscience',async()=>{
 const secret=await store.add({...scope,visibility:'private'},{...input,metadata:{visibility:'private',knownAt:'2099-01-01T00:00:00Z'}},admin);
 assert.deepEqual(await store.retrieve({...scope,visibility:'private'},['promise']),[]);
 assert.equal(privacyEligible({...secret.metadata,knownByKinIds:['dee-villa']},scope.kinId,'private'),false);
 await assert.rejects(store.add(scope,{...input,metadata:{knownByKinIds:['dee-villa']}},admin));
 const recipient={...scope,kinId:'dee-villa',discordBotId:'666666666666666666',visibility:'private'};
 const revealed=await store.add(recipient,{...input,metadata:{visibility:'private',revealOf:secret.id,knownAt:past}},admin);
 assert.equal(revealed.metadata.revealOf,secret.id);
 assert.equal((await store.retrieve(recipient,['promise'])).length,1);
 assert.deepEqual(await store.retrieve(scope,['promise']),[]);
 const learned=await store.add(scope,{...input,metadata:{knownAt:'2026-02-01T00:00:00Z'}},admin);
 assert.ok(!(await store.retrieve(scope,['promise'],new Date('2026-01-15T00:00:00Z'))).some(m=>m.id===learned.id));
 assert.ok((await store.retrieve(scope,['promise'],new Date('2026-03-01T00:00:00Z'))).some(m=>m.id===learned.id));
});
test('auto extraction defaults narrow, retains speaker/suspicion/source, and approval never broadens privacy',async()=>{
 const text='Dee thinks Adrian is jealous and suspects he is lying.';
 const extracted=extractCandidates(scope,[{authorId:admin,authorName:'Dee',kind:'user',text,guildId:scope.guildId,channelId:scope.channelId,timestamp:past,messageIds:candidate.sourceMessageIds}])[0];
 const pending=await store.createPending(scope,extracted);
 assert.equal(pending.metadata.statementType,'suspicion');assert.equal(pending.metadata.speakerId,admin);
 assert.equal(pending.metadata.sourceSnapshot,text);assert.equal(pending.metadata.visibility,'private');
 await store.edit(scope,pending.id,{...input,content:'Dee believes Adrian may be jealous.',metadata:{statementType:'belief'}},true,admin);
 const approved=await store.approve(scope,pending.id,admin);
 assert.equal(approved.original_content,pending.content);assert.equal(approved.reviewed_by,admin);
 assert.equal(approved.metadata.visibility,'private');assert.deepEqual(await store.retrieve(scope,['adrian']),[]);
 assert.ok((await store.history(scope,pending.id)).some(r=>r.operation==='edit'));
});
test('events remain historical, states supersede, expired temporary states are filtered without deletion',async()=>{
 const event=await store.add(scope,{...input,content:'Vincent and Naomi coupled on Day 3.',category:'villa_event',metadata:{memoryType:'event'}},admin);
 const state=await store.add(scope,{...input,content:'Vincent is coupled with Naomi.',metadata:{memoryType:'state'}},admin);
 const next=await store.createPending(scope,{...candidate,content:'Vincent is now coupled with Dee.',metadata:{memoryType:'state',visibility:'public'}});
 await assert.rejects(store.approve(scope,next.id,admin,event.id));
 await store.approve(scope,next.id,admin,state.id);
 assert.equal((await store.show(scope,state.id)).status,'superseded');
 assert.equal((await store.show(scope,event.id)).status,'active');
 assert.ok((await store.retrieve(scope,['day'])).some(m=>m.id===event.id));
 const temporary=await store.add(scope,{...input,metadata:{memoryType:'state',expiresAt:past}},admin);
 assert.ok(!(await store.retrieve(scope,['promise'])).some(m=>m.id===temporary.id));
 assert.equal((await store.show(scope,temporary.id)).status,'active');
 await assert.rejects(store.add(scope,{...input,metadata:{memoryType:'event',expiresAt:past}},admin));
});
test('retcons have highest authority, preserve old canon in revisions and can resolve flagged contradictions',async()=>{
 const old=await store.add(scope,{...input,content:'Vincent hates tequila.',category:'preference'},admin);
 const other=await store.add(scope,{...input,content:"Vincent's favorite liquor is tequila.",category:'preference'},admin);
 assert.equal((await store.conflicts(scope)).length,1);assert.deepEqual(await store.retrieve(scope,['tequila']),[]);
 const corrected=await store.retcon(scope,old.id,'Vincent likes tequila.',admin,'Original summary was incorrect; no in-story change.');
 assert.equal(authority(corrected.metadata),4);assert.equal(corrected.original_content,old.content);
 assert.equal((await store.conflicts(scope)).length,0);
 assert.equal((await store.retrieve(scope,['tequila']))[0].id,old.id);
 const history=await store.history(scope,old.id);assert.equal(history[0].operation,'retcon');
 assert.ok(history.some(r=>r.snapshot.content==='Vincent hates tequila.'));
 assert.equal((await store.show(scope,other.id)).status,'active');
});
test('archive and revision restore retain history and do not bypass approval or revive rejected candidates',async()=>{
 const manual=await store.add(scope,input,admin);const original=(await store.history(scope,manual.id))[0];
 await store.edit(scope,manual.id,{...input,content:'Changed promise.'},true,admin);
 await store.delete(scope,manual.id,admin);
 assert.equal(await store.show(scope,manual.id),undefined);
 const restored=await store.restore(scope,manual.id,String(original.id),admin);
 assert.equal(restored.content,input.content);assert.equal(restored.status,'inactive');
 assert.deepEqual(await store.retrieve(scope,['promise']),[]);
 const pending=await store.createPending(scope,{...candidate,content:'A distinct promise for later.'});
 const revision=(await store.history(scope,pending.id))[0];await store.reject(scope,pending.id,admin);
 assert.equal((await store.restore(scope,pending.id,String(revision.id),admin)).status,'rejected');
 assert.equal(await store.approve(scope,pending.id,admin),undefined);
 const operations=(await db.query('SELECT operation FROM memory_audit')).rows.map(r=>r.operation);
 for(const op of ['add','edit','archive','restore','reject'])assert.ok(operations.includes(op));
});
test('manual consolidation preserves duplicate records, source links and the later knowledge boundary',async()=>{
 const first=await store.add(scope,{...input,metadata:{knownAt:past}},admin);
 const second=await store.add(scope,{...input,metadata:{knownAt:'2026-02-01T00:00:00Z'}},admin);
 assert.equal(await store.merge(scope,first.id,second.id,admin),true);
 assert.equal((await store.show(scope,first.id)).metadata.knownAt,'2026-02-01T00:00:00.000Z');
 assert.deepEqual((await store.show(scope,first.id)).metadata.mergedFrom,[second.id]);
 assert.equal((await store.show(scope,second.id,true)).status,'archived');
 const privateNote=await store.add(scope,{...input,metadata:{visibility:'private'}},admin);
 await assert.rejects(store.merge(scope,first.id,privateNote.id,admin));
});
function bundle(items,overrides={}){return{version:1,scope:bundleScope(scope),source:'kindroid_export',namespace:'vincent_export',authoritative:false,items,...overrides};}
test('Kindroid reconciliation previews new/unchanged/changed/conflict/obsolete and stages without replacing canon',async()=>{
 const old=await store.add(scope,{...input,metadata:{sourceType:'kindroid_export',importNamespace:'vincent_export',externalId:'birthday',knownAt:past}},admin);
 await store.approve(scope,old.id,admin);
 const same=bundle([{...input,externalId:'birthday'}]);assert.equal((await production.preview(scope,same)).entries[0].action,'unchanged');
 const changed=bundle([{...input,content:'Vincent promised a different conversation.',externalId:'birthday'}],{authoritative:true});
 const preview=await production.preview(scope,changed);assert.equal(preview.entries[0].action,'changed');
 const staged=await production.stage(scope,changed,preview.token,admin);
 assert.equal((await store.show(scope,old.id)).status,'active');
 assert.equal((await store.show(scope,staged[0])).status,'pending');
 assert.equal((await store.show(scope,staged[0])).metadata.authoritative,true);
 assert.equal((await production.preview(scope,changed)).entries[0].action,'duplicate');
 assert.equal((await production.preview(scope,bundle([{...input,content:'Conflicting edit.',externalId:'birthday'}]))).entries[0].action,'conflict');
 assert.ok((await production.preview(scope,bundle([]))).entries.some(e=>e.action==='obsolete'));
 await store.approve(scope,staged[0],admin,old.id);
 assert.equal((await store.show(scope,old.id)).status,'superseded');
});
test('structured export round-trips without duplicate canon and preserves original provenance',async()=>{
 const old=await store.add(scope,input,admin);
 const exported=await production.export(scope);
 assert.match(exported.readable,/Vincent promised/);
 assert.equal(exported.bundle.items[0].original_content,input.content);
 assert.equal((await production.preview(scope,exported.bundle)).entries[0].action,'unchanged');
 const preview=await production.preview(scope,exported.bundle);
 assert.deepEqual(await production.stage(scope,exported.bundle,preview.token,admin),[]);
 assert.equal((await store.scan(scope)).length,1);
 assert.equal((await store.show(scope,old.id)).metadata.sourceType,'manual');
});
test('changed re-import preserves original Discord evidence and source authority lineage',async()=>{
 const old=await store.add(scope,{...input,provenance:{sourceChannelId:scope.channelId,occurredAt:past,
  sourceMessageIds:candidate.sourceMessageIds,subjects:['dee-villa']},metadata:{speakerId:'dee-villa'}},admin);
 const exported=(await production.export(scope)).bundle;
 exported.authoritative=true;exported.items[0].content='Vincent clarified the original promise.';
 const preview=await production.preview(scope,exported);
 const ids=await production.stage(scope,exported,preview.token,admin);
 const imported=await store.show(scope,ids[0]);
 assert.deepEqual(imported.source_message_ids,candidate.sourceMessageIds);
 assert.equal(imported.occurred_at.toISOString(),new Date(past).toISOString());
 assert.equal(imported.metadata.originalSourceType,'manual');assert.equal(imported.metadata.importOriginalContent,old.original_content);
 assert.equal(imported.metadata.sourceCreatedBy,admin);
 assert.deepEqual(imported.subjects,['dee-villa']);
});
test('bulk imports validate scope and dates, reject stale previews, are transactional and default to pending private',async()=>{
 const items=[{...input,externalId:'one'},{...input,content:'Vincent prefers quiet mornings.',externalId:'two',category:'preference'}];
 const proposed=bundle(items);
 const preview=await production.preview(scope,proposed);
 await assert.rejects(production.preview({...scope,storyline:'another'},proposed));
 await assert.rejects(production.preview(scope,bundle([{...input,externalId:'bad',metadata:{knownAt:'not a date'}}])));
 await store.add(scope,{...input,content:'An intervening admin note.'},admin);
 await assert.rejects(production.stage(scope,proposed,preview.token,admin));
 const fresh=await production.preview(scope,proposed);const ids=await production.stage(scope,proposed,fresh.token,admin);
 assert.equal(ids.length,2);for(const id of ids){const m=await store.show(scope,id);assert.equal(m.status,'pending');assert.equal(m.metadata.visibility,'private');}
 const rollback=bundle([{...input,externalId:'rollback-one'},{...input,content:'Another pending item.',externalId:'rollback-two'}],{namespace:'rollback'});
 const next=await production.preview(scope,rollback);const before=(await store.scan(scope)).length;
 const realAdd=MemoryStore.prototype.add;
 MemoryStore.prototype.add=async function(s,i,a){if(i.metadata.externalId==='rollback-two')throw new Error('simulated failure');return realAdd.call(this,s,i,a);};
 try{await assert.rejects(production.stage(scope,rollback,next.token,admin));}finally{MemoryStore.prototype.add=realAdd;}
 assert.equal((await store.scan(scope)).length,before);
});
test('current-canon snapshots exclude pending, archived, superseded, expired and private notes but retain relevant old events',async()=>{
 const active=await store.add(scope,{...input,metadata:{domain:'identity',pinned:true}},admin);
 const event=await store.add(scope,{...input,content:'Day 3 villa challenge result.',category:'challenge_outcome',metadata:{memoryType:'event',knownAt:past}},admin);
 await store.createPending(scope,candidate);
 await store.add(scope,{...input,metadata:{visibility:'private'}},admin);
 await store.add(scope,{...input,metadata:{memoryType:'state',expiresAt:past}},admin);
 const archived=await store.add(scope,input,admin);await store.delete(scope,archived.id,admin);
 assert.deepEqual(new Set((await production.snapshot(scope)).map(m=>m.id)),new Set([active.id,event.id]));
 assert.ok((await store.retrieve(scope,['day','challenge'])).some(m=>m.id===event.id));
});
test('pending retention archives rather than deletes; edited/deleted source flags preserve original evidence',async()=>{
 const pending=await store.createPending(scope,{...candidate,metadata:{sourceSnapshot:'Original source message.'}});
 await db.query("UPDATE memories SET created_at=now()-interval '40 days' WHERE id=$1",[pending.id]);
 assert.equal(await store.archivePending(scope,30,admin),1);
 const archived=await store.show(scope,pending.id,true);assert.equal(archived.status,'archived');assert.equal(archived.original_content,pending.content);
 await store.flagSource(scope,pending.id,'Source deleted; review provenance.',admin);
 assert.equal((await store.show(scope,pending.id,true)).metadata.sourceSnapshot,'Original source message.');
 assert.ok((await store.history(scope,pending.id)).some(r=>r.operation==='source_review'));
 assert.equal(await store.createPending(scope,candidate),undefined);
});
test('stable kin rebind is controlled and audited; approved aliases normalize without ambiguous guessing',async()=>{
 const saved=await store.add(scope,input,admin);
 await store.setAlias(scope,'Dee','dee-villa',admin);
 assert.equal(await store.resolveAlias(scope,'DEE'),'dee-villa');assert.equal(await store.resolveAlias(scope,'D'),undefined);
 assert.equal(await store.resolveAlias({...scope,storyline:'other'},'Dee'),undefined);
 await assert.rejects(store.rebindKin(scope,'wrong','666666666666666666',admin,'bot rebuild'));
 await store.rebindKin(scope,scope.discordBotId,'666666666666666666',admin,'bot rebuild');
 await assert.rejects(store.show(scope,saved.id));
 assert.equal((await store.show({...scope,discordBotId:'666666666666666666'},saved.id)).id,saved.id);
 assert.equal((await db.query('SELECT * FROM memory_binding_history')).rows.length,1);
});
test('new slash commands and metadata edits remain admin-only and ephemeral',async()=>{
 const definition=memoryCommandDefinition().toJSON();assert.ok(definition.options.length<=25);
 for(const command of ['add','edit'])assert.ok(definition.options.find(c=>c.name===command).options.some(o=>o.name==='visibility'));
 const runtime={config:{enabled:true,adminUserIds:new Set([admin]),contexts:[scope]},store};
 for(const command of ['history','restore','retcon','merge','conflicts','snapshot']){
  const responses=[];
  await handleMemoryCommand({user:{id:'999999999999999999'},reply:async p=>responses.push(p)},scope.kinId,runtime);
  assert.equal(responses[0].flags,64);
 }
});
test('authorized metadata edits, history and snapshots are private and expose reviewable files',async()=>{
 const memory=await store.add(scope,input,admin);
 const runtime={config:{enabled:true,adminUserIds:new Set([admin]),contexts:[scope]},store};
 function interaction(command,values={}){
  const r={user:{id:admin},client:{user:{id:scope.discordBotId}},guildId:scope.guildId,channelId:scope.channelId,channel:null,
   responses:[],deferred:false,replied:false,options:{getSubcommand:()=>command,getString:k=>values[k]??null,getInteger:k=>values[k]??null,getBoolean:k=>values[k]??null}};
  r.reply=async p=>{r.responses.push(p);r.replied=true;};r.deferReply=async p=>{r.responses.push(p);r.deferred=true;};r.editReply=async p=>{r.responses.push(p);};return r;
 }
 for(const [command,values] of [['history',{id:memory.id}],['snapshot',{}],['conflicts',{}],['edit',{id:memory.id,visibility:'private','known-by':scope.kinId,statement:'belief'}]]){
  const invocation=interaction(command,values);await handleMemoryCommand(invocation,scope.kinId,runtime);
  assert.equal(invocation.responses[0].flags,64);
  if(['history','snapshot'].includes(command))assert.ok(invocation.responses.at(-1).files[0].attachment.length);
 }
 assert.equal((await store.show(scope,memory.id)).metadata.visibility,'private');
 assert.equal((await store.show(scope,memory.id)).metadata.statementType,'belief');
 assert.ok((await store.audit(scope)).some(r=>r.operation==='visibility_change'));
});

test('public snapshot followed by private restriction rejects the stale public edit and retains audit history',async()=>{
 const memory=await store.add(scope,input,admin);
 const stale=await store.show(scope,memory.id);assert.equal(stale.metadata.visibility,'public');
 await store.edit(scope,memory.id,{...input,metadata:{visibility:'private'}},undefined,admin);
 await assert.rejects(store.edit(scope,memory.id,{...input,content:'Stale text edit.',metadata:stale.metadata},undefined,admin,stale.edit_version),MemoryEditConflict);
 const current=await store.show(scope,memory.id);assert.equal(current.metadata.visibility,'private');assert.equal(current.content,input.content);
 const fresh=await store.edit(scope,memory.id,{...input,content:'Fresh text edit.'},undefined,admin,current.edit_version);
 assert.equal(fresh.metadata.visibility,'private');
 const history=await store.history(scope,memory.id);assert.equal(history.length,3);
 assert.ok((await store.audit(scope)).some(r=>r.operation==='visibility_change'));
 assert.deepEqual(await store.retrieve(scope,['promise']),[]);
});

test('a Discord edit prepared before a privacy change returns a private retry response',async()=>{
 const memory=await store.add(scope,input,admin),responses=[];
 const commandStore=Object.create(store);
 commandStore.show=async(...args)=>{
  const stale=await store.show(...args);
  await store.edit(scope,memory.id,{...input,metadata:{visibility:'private'}},undefined,admin);
  return stale;
 };
 const invocation={user:{id:admin},client:{user:{id:scope.discordBotId}},guildId:scope.guildId,channelId:scope.channelId,channel:null,
  deferred:false,replied:false,options:{getSubcommand:()=> 'edit',getString:k=>k==='id'?memory.id:k==='content'?'A stale public edit.':null,getInteger:()=>null,getBoolean:()=>null},
  deferReply:async p=>{responses.push(p);invocation.deferred=true;},editReply:async p=>responses.push(p)};
 await handleMemoryCommand(invocation,scope.kinId,{config:{enabled:true,adminUserIds:new Set([admin]),contexts:[scope]},store:commandStore});
 assert.equal(responses[0].flags,64);assert.match(responses.at(-1).content,/Inspect it again and retry/);
 const current=await store.show(scope,memory.id);assert.equal(current.metadata.visibility,'private');assert.equal(current.content,input.content);
});

test('overlapping row-locked edits serialize: a paused public read cannot overwrite the queued private change',async()=>{
 const memory=await store.add(scope,input,admin);
 let resume,captured;const gate=new Promise(r=>resume=r),ready=new Promise(r=>captured=r);const sql=[];
 const pausedDb={query:db.query,connect:async()=>{
  const client=await db.connect();return {release:client.release,query:async(query,values)=>{
   sql.push(query);const result=await client.query(query,values);
   if(query.includes('xmin::text')&&query.includes('FOR UPDATE')){assert.equal(result.rows[0].metadata.visibility,'public');captured();await gate;}
   return result;
  }};
 }};
 const editing=new MemoryStore(pausedDb).edit(scope,memory.id,{...input,content:'Text edit that read public.'},undefined,admin);
 await ready;
 let privateFinished=false;
 const restricting=store.edit(scope,memory.id,{...input,metadata:{visibility:'private'}},undefined,admin).then(r=>{privateFinished=true;return r;});
 await new Promise(r=>setImmediate(r));assert.equal(privateFinished,false);
 resume();await editing;await restricting;
 assert.equal((await store.show(scope,memory.id)).metadata.visibility,'private');
 assert.ok(sql[0]==='BEGIN');assert.ok(sql.some(q=>q.includes('memory_contexts')&&q.includes('FOR UPDATE')));
 assert.equal(sql.at(-1),'COMMIT');
});

test('concurrent governance patches preserve each other; competing edits from one version require an explicit retry',async()=>{
 const memory=await store.add(scope,input,admin);
 await Promise.all([
  store.edit(scope,memory.id,{...input,metadata:{visibility:'private'}},undefined,admin),
  store.edit(scope,memory.id,{...input,metadata:{knownByKinIds:[scope.kinId,'dee-villa'],sourceType:'production_override',authoritative:true}},undefined,admin),
 ]);
 const current=await store.show(scope,memory.id);
 assert.equal(current.metadata.visibility,'private');assert.deepEqual(current.metadata.knownByKinIds,[scope.kinId,'dee-villa']);assert.equal(authority(current.metadata),4);
 const results=await Promise.allSettled([
  store.edit(scope,memory.id,{...input,metadata:{pinned:true}},undefined,admin,current.edit_version),
  store.edit(scope,memory.id,{...input,metadata:{domain:'identity'}},undefined,admin,current.edit_version),
 ]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.ok(results.find(r=>r.status==='rejected').reason instanceof MemoryEditConflict);
 const after=await store.show(scope,memory.id);assert.equal(after.metadata.visibility,'private');assert.equal(authority(after.metadata),4);
});

test('edit/approve ordering is deterministic and stale pre-approval edits cannot deactivate approved canon',async()=>{
 const pending=await store.createPending(scope,candidate);
 const before=await store.show(scope,pending.id);
 const editedText='Vincent clarified his promise to Dee.';
 await Promise.all([
  store.edit(scope,pending.id,{...input,content:editedText},undefined,admin,before.edit_version),
  store.approve(scope,pending.id,admin),
 ]);
 let current=await store.show(scope,pending.id);assert.equal(current.status,'active');assert.equal(current.content,editedText);assert.equal(current.original_content,pending.content);
 await assert.rejects(store.edit(scope,pending.id,input,false,admin,before.edit_version),MemoryEditConflict);
 const afterApproval=await store.edit(scope,pending.id,{...input,content:editedText},undefined,admin,current.edit_version);
 assert.equal(afterApproval.status,'active');assert.equal(afterApproval.metadata.visibility,'private');
 const next=await store.createPending(scope,{...candidate,content:'A different promise for tomorrow.'});
 const preApprove=await store.show(scope,next.id);
 const order=await Promise.allSettled([store.approve(scope,next.id,admin),store.edit(scope,next.id,input,undefined,admin,preApprove.edit_version)]);
 assert.equal(order[0].status,'fulfilled');assert.ok(order[1].reason instanceof MemoryEditConflict);
 assert.equal((await store.show(scope,next.id)).status,'active');
});

test('stale edits cannot undo retcon authority or overwrite merge governance',async()=>{
 const memory=await store.add(scope,{...input,metadata:{knownAt:past}},admin);const stale=await store.show(scope,memory.id);
 await store.retcon(scope,memory.id,'Vincent clarified the promise.',admin,'Explicit production correction.');
 await assert.rejects(store.edit(scope,memory.id,{...input,metadata:stale.metadata},undefined,admin,stale.edit_version),MemoryEditConflict);
 assert.equal(authority((await store.show(scope,memory.id)).metadata),4);
 const first=await store.add(scope,{...input,metadata:{knownAt:past}},admin),second=await store.add(scope,{...input,metadata:{knownAt:past}},admin);
 const oldKeep=await store.show(scope,first.id),oldDuplicate=await store.show(scope,second.id);
 await store.merge(scope,first.id,second.id,admin);
 await assert.rejects(store.edit(scope,first.id,{...input,metadata:oldKeep.metadata},undefined,admin,oldKeep.edit_version),MemoryEditConflict);
 await assert.rejects(store.edit(scope,second.id,input,undefined,admin,oldDuplicate.edit_version),MemoryEditConflict);
 assert.deepEqual((await store.show(scope,first.id)).metadata.mergedFrom,[second.id]);
 assert.equal((await store.show(scope,second.id,true)).status,'archived');
});

test('same-batch equivalent imports stage once and preserve both external keys and source evidence',async()=>{
 const common={...input,provenance:{sourceChannelId:scope.channelId,occurredAt:past,subjects:['dee-villa'],sourceMessageIds:[]}};
 const proposed=bundle([
  {...common,externalId:'first',provenance:{...common.provenance,sourceMessageIds:['555555555555555555']}},
  {...common,externalId:'second',provenance:{...common.provenance,sourceMessageIds:['666666666666666666']}},
 ]);
 const preview=await production.preview(scope,proposed);assert.deepEqual(preview.entries.map(e=>e.action),['new','duplicate']);assert.equal(preview.entries[1].duplicateOfIndex,0);
 const ids=await production.stage(scope,proposed,preview.token,admin);assert.equal(ids.length,1);
 const saved=await store.show(scope,ids[0]);assert.deepEqual(saved.metadata.importAliases,['second']);
 assert.deepEqual(saved.source_message_ids,['555555555555555555','666666666666666666']);assert.equal(saved.status,'pending');assert.equal(saved.metadata.visibility,'private');
 const repeated=await production.preview(scope,proposed);assert.deepEqual(repeated.entries.map(e=>e.action),['duplicate','duplicate']);
 assert.deepEqual(await production.stage(scope,proposed,repeated.token,admin),[]);
});

test('batch deduplication does not collapse differences in privacy, attribution, belief, or event time',async()=>{
 for(const difference of [{visibility:'private'},{statementType:'suspicion'},{speakerId:'dee-villa'},{knownAt:past}]){
  const proposed=bundle([{...input,externalId:'a',metadata:{visibility:'public'}},{...input,externalId:'b',metadata:{visibility:'public',...difference}}]);
  assert.deepEqual((await production.preview(scope,proposed)).entries.map(e=>e.action),['new','new']);
 }
 const event={...input,metadata:{memoryType:'event'},provenance:{sourceChannelId:scope.channelId,occurredAt:past,sourceMessageIds:[],subjects:[]}};
 assert.deepEqual((await production.preview(scope,bundle([{...event,externalId:'day-one'},{...event,externalId:'day-two',provenance:{...event.provenance,occurredAt:'2026-02-01T00:00:00Z'}}]))).entries.map(e=>e.action),['new','new']);
});

function failingClientDatabase(pattern){return {query:db.query,connect:async()=>{const client=await db.connect();return{release:client.release,query:async(sql,values)=>{if(pattern.test(sql))throw new Error('Injected operation failure');return client.query(sql,values);}};}};}
test('alias mutation and audit are atomic, including failed replacement and first scope registration',async()=>{
 await store.setAlias(scope,'Dee','dee-villa',admin);
 const failing=new MemoryStore(failingClientDatabase(/INSERT INTO memory_audit/));
 await assert.rejects(failing.setAlias(scope,'Dee','other-kin',admin));
 assert.equal(await store.resolveAlias(scope,'Dee'),'dee-villa');assert.equal((await store.audit(scope)).filter(r=>r.operation==='alias').length,1);
 const fresh={...scope,kinId:'new-kin',discordBotId:'777777777777777777'};
 await assert.rejects(failing.setAlias(fresh,'D','dee-villa',admin));
 assert.equal((await db.query('SELECT * FROM memory_kins WHERE id=$1',[fresh.kinId])).rows.length,0);
 assert.equal((await db.query('SELECT * FROM memory_aliases WHERE kin_id=$1',[fresh.kinId])).rows.length,0);
});

test('failed memory creation rolls back its kin/context binding too; public exports explicitly warn about confidential originals',async()=>{
 const failing=new MemoryStore(failingClientDatabase(/INSERT INTO memories/));
 await assert.rejects(failing.add(scope,input,admin));
 assert.equal((await db.query('SELECT * FROM memory_kins')).rows.length,0);assert.equal((await db.query('SELECT * FROM memory_contexts')).rows.length,0);
 const privateMemory=await store.add(scope,{...input,content:'Confidential original promise.',metadata:{visibility:'private'}},admin);
 await store.edit(scope,privateMemory.id,{...input,content:'Public summary.',metadata:{visibility:'public'}},undefined,admin);
 const exported=await production.export(scope,{visibility:'public'});
 assert.match(exported.warning,/NOT PUBLICATION-SAFE/);assert.match(exported.readable,/confidential/i);
 assert.equal(exported.bundle.items[0].original_content,'Confidential original promise.');
});
