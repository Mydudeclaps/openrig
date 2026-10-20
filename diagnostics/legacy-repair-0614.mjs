import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const ef=promisify(execFile), ex=promisify(exec);
const source=path.resolve(process.env.SOURCE_ROOT), out=path.resolve(process.env.PROOF_ROOT);
const version=process.env.LEGACY_VERSION;
const home=path.join(out,'scratch-home'), socket=path.join(out,'fixture.sock');
fs.mkdirSync(home,{recursive:true});
// This process and every CLI child receive only the scratch homes and owned endpoint.
for(const key of Object.keys(process.env)) if(/^(OPENRIG_|RIGGED_|CLAUDE_|CODEX_|ANTHROPIC_|OPENAI_|TMUX)/.test(key)) delete process.env[key];
Object.assign(process.env,{HOME:home,OPENRIG_HOME:path.join(home,'.openrig'),XDG_CONFIG_HOME:path.join(home,'.config'),CODEX_HOME:path.join(home,'.codex')});
const bin=path.join(home,'bin');fs.mkdirSync(bin,{recursive:true});
process.env.PATH=bin+':'+process.env.PATH;
fs.writeFileSync(path.join(bin,'codex'),'#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.139.0";; --help) echo "Usage: codex [OPTIONS] [PROMPT]"; echo "--no-daemon";; esac\n',{mode:0o755});
// Inert stdin recorder; its executable name/argv can be read by the unmodified runtime observer.
fs.writeFileSync(path.join(out,'recorder.c'),`#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(int argc,char **argv){if(argc>1&&!strcmp(argv[1],"--version")){puts("2.1.0 (Claude Code)");return 0;}if(argc>1&&!strcmp(argv[1],"--help")){puts("Usage: claude [options] [prompt]");return 0;}setvbuf(stdout,NULL,_IONBF,0);puts("FIXTURE_RECORDER_READY");FILE *f=fopen(getenv("FIXTURE_RECORD"),"ab");if(!f)return 2;char b[4096];while(fgets(b,sizeof b,stdin)){fputs(b,f);fflush(f);printf("RECORDER_READ:%s",b);}fclose(f);return 0;}\n`);
await ef('cc',['-O0',path.join(out,'recorder.c'),'-o',path.join(bin,'claude')]);
const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
const records={identity:{label:'historical schema/writers; synthetic records and inert native recorder; source-built product-tree equivalent, not sealed installed archive',version,source:process.env.SOURCE_PIN},commands:[],cli:[],checks:{}};
const save=()=>fs.writeFileSync(path.join(out,'RESULT.json'),JSON.stringify(records,null,2));
let phase='startup',daemon,server;
const tmuxExec=async command=>{assert.match(command,/^tmux\b/);records.commands.push({phase,command});return (await ex(command.replace(/^tmux\b/,'tmux -S '+q(socket)),{env:process.env,timeout:10000,maxBuffer:4*1024*1024})).stdout;};
const tmux=async(...args)=>(await ef('tmux',['-S',socket,...args],{env:process.env,timeout:10000})).stdout;
const req=createRequire(path.join(source,'package.json'));
const {serve}=await import(pathToFileURL(req.resolve('@hono/node-server')));
const {createDaemon}=await import(pathToFileURL(path.join(source,'packages/daemon/dist/startup.js')));
const {HistoryQuery}=await import(pathToFileURL(path.join(source,'packages/daemon/dist/domain/history-query.js')));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const token='00000000-0000-4000-8000-000000000001';
const cli=async args=>{const startedAt=new Date().toISOString();let r;try{const x=await ef(process.execPath,[path.join(source,'packages/cli/dist/index.js'),...args],{env:process.env,timeout:25000,maxBuffer:4*1024*1024});r={code:0,...x};}catch(e){r={code:typeof e.code==='number'?e.code:1,stdout:e.stdout??'',stderr:e.stderr??'',error:e.message};}records.cli.push({phase,args,startedAt,endedAt:new Date().toISOString(),...r});save();return r;};
const data=r=>{try{return JSON.parse(r.stdout);}catch{return null;}};
try {
 const old=req(path.join(source,`.l1-old-${version}.cjs`));
 const dbPath=path.join(home,'fixture.sqlite'), historical=old.createDb(dbPath);old.migrateOld(historical);
 const rigs=new old.RigRepository(historical), sessions=new old.SessionRegistry(historical);
 const rig=rigs.createRig('pane-fixture'), seats={};
 for(const logical of ['legacy.fixture','control.fixture','ambiguous.fixture','protected.fixture','missing.fixture']) {
  const name=logical.replaceAll('.','-')+'@pane-fixture',record=path.join(out,logical+'.stdin');
  await tmux('new-session','-d','-s',name,'-x','120','-y','35',`FIXTURE_RECORD=${q(record)} exec ${q(path.join(bin,'claude'))} --resume ${token}`);
  let screen='';for(let n=0;n<50;n++){screen=await tmux('capture-pane','-p','-t',name);if(screen.includes('FIXTURE_RECORDER_READY'))break;await sleep(40);}assert.match(screen,/FIXTURE_RECORDER_READY/);
  const node=rigs.addNode(rig.id,logical,{runtime:'claude-code',cwd:home,podId:null});
  // These are the historical repository writers used by the historical launcher.
  // No old launcher/provider is executed: owned inert tmux was created above.
  const session=sessions.registerSession(node.id,name);sessions.updateStatus(session.id,'running');sessions.updateStartupStatus(session.id,'ready',new Date().toISOString());
  sessions.updateBinding(node.id,{tmuxSession:name});sessions.updateResumeToken(session.id,'codex_id',token,'hook');
  historical.prepare("UPDATE bindings SET updated_at='2000-01-01' WHERE node_id=?").run(node.id);
  if(version==='050')historical.prepare("UPDATE sessions SET restore_policy='relaunch_fresh' WHERE id=?").run(session.id);
  const pane=(await tmux('display-message','-p','-t',name,'#{pane_id}')).trim();
  assert.equal(historical.prepare('SELECT tmux_pane FROM bindings WHERE node_id=?').get(node.id).tmux_pane,null);
  seats[logical]={name,node,session,pane,record};
 }
 records.historical={migrations:historical.prepare('SELECT * FROM schema_migrations ORDER BY name').all(),sessions:historical.prepare('SELECT * FROM sessions ORDER BY id').all(),bindings:historical.prepare('SELECT * FROM bindings ORDER BY node_id').all()};
 await historical.backup(path.join(out,'historical-preimage.sqlite'));historical.close();save();
 daemon=await createDaemon({dbPath,tmuxExec,terminalBearerToken:null,bearerToken:null,webUiEnabled:false});
 server=serve({fetch:daemon.app.fetch,hostname:'127.0.0.1',port:0});await new Promise(r=>server.listening?r():server.once('listening',r));
 process.env.OPENRIG_URL='http://127.0.0.1:'+server.address().port;
 const {db,deps}=daemon, {sessionTransport,transcriptStore}=deps, guard=sessionTransport.deliveryGuard;
 assert.ok(guard);records.identity.endpoint=process.env.OPENRIG_URL;records.identity.socket=socket;
 const target=seats['legacy.fixture'],control=seats['control.fixture'];
 const transcriptPath=transcriptStore.getTranscriptPath(rig.name,target.name);transcriptStore.ensureTranscriptDir(rig.name);
 fs.appendFileSync(transcriptPath,'\nHISTORY_SENTINEL retained legacy bytes\n');
 await sleep(100);
 const stored=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'"').all()]));
 const native=async()=>({identity:(await tmux('display-message','-p','-t',target.name,'#{pid}|#{pane_id}|#{pane_pid}|#{session_id}')).trim(),stdin:fs.readFileSync(target.record,'utf8'),transcript:fs.readFileSync(transcriptPath,'utf8')});
 const repair=seat=>cli(['reconcile-session',seat.name,'--repair-missing-pane','--no-launch','--json']);
 // Matching binding positive control: sending is possible to this owned recorder.
 db.prepare('UPDATE bindings SET tmux_pane=? WHERE node_id=?').run(control.pane,control.node.id);
 phase='matching-send-control';const matching=await cli(['send',control.name,'MATCHING_BINDING_CONTROL','--json']);assert.equal(matching.code,0);assert.equal(data(matching)?.ok,true);
 for(let n=0;n<40&&!fs.readFileSync(control.record,'utf8').includes('MATCHING_BINDING_CONTROL');n++)await sleep(25);
 assert.match(fs.readFileSync(control.record,'utf8'),/MATCHING_BINDING_CONTROL/);
 phase='before-null-refusal';const refused=await cli(['send',target.name,'MUST_NOT_REACH_NULL_BINDING','--json']);assert.notEqual(refused.code,0);assert.match(refused.stdout+refused.stderr,/Managed pane identity unavailable or changed/);assert.equal(fs.readFileSync(target.record,'utf8'),'');
 // Freeze a real retained outbox record with the NULL-pane identity.
 phase='freeze-retained';await guard.set(target.node.id,{mode:'hold'},'fixture','owned preservation control');
 const held=await sessionTransport.send(target.name,'STALE_NULL_SNAPSHOT',{deliveryId:'owned-retained-before-repair',actorSession:control.name});assert.equal(held.sent,false);assert.equal(held.outcome,'retained');
 const heldBefore=db.prepare('SELECT * FROM outbox_entries WHERE outbox_id=?').get('owned-retained-before-repair');
 assert.equal(JSON.parse(heldBefore.guard_binding).pane,null);await guard.set(target.node.id,{mode:'off'},'fixture','owned repair phase');
 // Observe production adapter calls without substituting their implementation.
 const adapter=deps.tmuxAdapter,counts={};assert.ok(adapter);
 for(const key of ['probeSession','listSessions','listPanes','getPanePid']){const original=adapter[key].bind(adapter);adapter[key]=async(...args)=>{counts[key]=(counts[key]??0)+1;const result=await original(...args);records.observations??=[];records.observations.push({phase,key,args,result});return result;};}
 phase='repair';const before=stored(),nativeBefore=await native();records.before=before;records.nativeBefore=nativeBefore;save();
 const result=await repair(target),body=data(result);records.repair={result,body,counts:{...counts}};
 const after=stored(),nativeAfter=await native();records.after=after;records.nativeAfter=nativeAfter;save();
 assert.equal(result.code,0);assert.equal(body?.result?.mode,'repair-missing-pane');assert.equal(body.result.sessionId,target.session.id);assert.equal(body.result.continuity,'unverified');
 assert.deepEqual(counts,{probeSession:2,listSessions:2,listPanes:2,getPanePid:2});
 const bindingBefore=before.bindings.find(b=>b.node_id===target.node.id),bindingAfter=after.bindings.find(b=>b.node_id===target.node.id);
 assert.equal(bindingAfter.tmux_pane,target.pane);assert.notEqual(bindingAfter.updated_at,bindingBefore.updated_at);
 assert.deepEqual({...bindingAfter,tmux_pane:bindingBefore.tmux_pane,updated_at:bindingBefore.updated_at},bindingBefore);
 assert.deepEqual({...after,bindings:before.bindings},before);assert.deepEqual(nativeAfter,nativeBefore);
 const forbidden=records.commands.filter(x=>x.phase==='repair'&&/\b(?:send-keys|paste-buffer|load-buffer|new-session|respawn-pane|kill-session|kill-pane|pipe-pane)\b/.test(x.command));assert.deepEqual(forbidden,[]);
 records.checks.nullOnlyAllTablesPreserved=true;records.checks.sameNativePidHistoryInput=true;records.checks.twoMatchingObservations=true;
 records.checks.legacyAbsentTenure={count:after.occupant_tenures.filter(t=>t.node_id===target.node.id).length,accepted:true};assert.equal(records.checks.legacyAbsentTenure.count,0);
 assert.equal(after.sessions.find(s=>s.id===target.session.id).restore_policy,version==='050'?'relaunch_fresh':'resume_if_possible');
 // No automatic retarget or delivery; retries keep the real stored binding bytes.
 phase='stale-snapshot';const stale=await sessionTransport.send(target.name,'STALE_NULL_SNAPSHOT',{committedOutboxIds:['owned-retained-before-repair'],actorSession:control.name});
 assert.equal(stale.ok,false);assert.equal(stale.reason,'guard_target_changed');
 const retry=await sessionTransport.send(target.name,'STALE_NULL_SNAPSHOT',{deliveryId:'owned-retained-before-repair',actorSession:control.name});assert.equal(retry.sent,false);assert.equal(retry.outcome,'retained');
 assert.deepEqual(db.prepare('SELECT * FROM outbox_entries WHERE outbox_id=?').get('owned-retained-before-repair'),heldBefore);assert.equal(fs.readFileSync(target.record,'utf8'),nativeBefore.stdin);records.stale={stale,retry};
 // Real ambiguous topology, protected seat, and missing-current-session controls.
 records.refusals=[];
 const negative=async(label,seat)=>{phase=label;const before=stored(),r=await repair(seat),after=stored();records.refusals.push({label,result:r,body:data(r)});save();assert.notEqual(r.code,0);assert.equal(data(r)?.ok,false);assert.deepEqual(after,before);assert.equal(fs.readFileSync(seat.record,'utf8'),'');};
 await tmux('split-window','-d','-t',seats['ambiguous.fixture'].name,'sleep 120');await negative('ambiguous-pane',seats['ambiguous.fixture']);
 await guard.set(seats['protected.fixture'].node.id,{mode:'hold'},'fixture','preserve person protection');await negative('protected',seats['protected.fixture']);
 db.prepare('DELETE FROM sessions WHERE node_id=?').run(seats['missing.fixture'].node.id);await negative('missing-current-session',seats['missing.fixture']);
 phase='after-send';const sent=await cli(['send',target.name,'AFTER_REPAIR_MARKER','--json']);records.afterSend=sent;assert.equal(sent.code,0);assert.equal(data(sent)?.ok,true);
 for(let n=0;n<40&&!fs.readFileSync(target.record,'utf8').includes('AFTER_REPAIR_MARKER');n++)await sleep(25);
 assert.match(fs.readFileSync(target.record,'utf8'),/AFTER_REPAIR_MARKER/);assert.doesNotMatch(fs.readFileSync(target.record,'utf8'),/STALE_NULL_SNAPSHOT|MUST_NOT_REACH_NULL_BINDING/);
 records.checks.afterRepairNewSendWorks=true;records.status='completed';await db.backup(path.join(out,'fixture-after.sqlite'));save();
} catch(error) {records.status='failed';records.failure={message:error.message,stack:error.stack,phase};save();process.exitCode=1;}
finally {phase='owned-shutdown';try{await tmux('kill-server');records.ownedTmuxShutdown=true;}catch(e){records.ownedTmuxShutdown={error:e.message};}try{if(server)await new Promise(r=>server.close(r));}catch{}try{daemon?.db.close();}catch{}save();}
process.exit(process.exitCode??0);
