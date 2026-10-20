import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const ef=promisify(execFile), ex=promisify(exec);
const source=path.resolve(process.env.SOURCE_ROOT), out=path.resolve(process.env.PROOF_ROOT);
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
const records={identity:{label:'public-cut source-built CLI/createDaemon; inert recorder, not sealed archive/native provider',source:process.env.SOURCE_PIN},commands:[],cli:[],checks:{}};
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
try{
 daemon=await createDaemon({dbPath:path.join(home,'fixture.sqlite'),tmuxExec,terminalBearerToken:null,bearerToken:null,webUiEnabled:false});
 server=serve({fetch:daemon.app.fetch,hostname:'127.0.0.1',port:0});
 await new Promise(r=>server.listening?r():server.once('listening',r));
 const port=server.address().port;process.env.OPENRIG_URL='http://127.0.0.1:'+port;
 records.identity.endpoint=process.env.OPENRIG_URL;records.identity.socket=socket;records.identity.home=home;
 const {db,deps}=daemon,{rigRepo,sessionRegistry,transcriptStore,queueRepo}=deps;
 const rig=rigRepo.createRig('pane-fixture');
 async function seat(logical,nullable){const name=logical.replaceAll('.','-')+'@pane-fixture',record=path.join(out,logical+'.stdin');
  await tmux('new-session','-d','-s',name,'-x','120','-y','35',`FIXTURE_RECORD=${q(record)} exec ${q(path.join(bin,'claude'))} --resume ${token}`);
  let state='';for(let n=0;n<50;n++){state=await tmux('capture-pane','-p','-t',name);if(state.includes('FIXTURE_RECORDER_READY'))break;await sleep(40);}assert.match(state,/FIXTURE_RECORDER_READY/);
  const node=rigRepo.addNode(rig.id,logical,{runtime:'claude-code',cwd:home,podId:null});
  const session=sessionRegistry.registerSession(node.id,name);sessionRegistry.updateStatus(session.id,'running');sessionRegistry.updateStartupStatus(session.id,'ready',new Date().toISOString());
  const pane=(await tmux('display-message','-p','-t',name,'#{pane_id}')).trim();
  sessionRegistry.updateBinding(node.id,{tmuxSession:name,...(nullable?{}:{tmuxPane:pane})});
  // Preserve the reported runtime/resume-type anomaly; never normalize it in this fixture.
  sessionRegistry.updateResumeToken(session.id,'codex_id',token,'hook');
  return {name,node,session,pane,record};}
 const target=await seat('legacy.fixture',true),control=await seat('control.fixture',false);
 const transcriptPath=transcriptStore.getTranscriptPath(rig.rig.name,target.name);
 transcriptStore.ensureTranscriptDir(rig.rig.name);fs.writeFileSync(transcriptPath,'HISTORY_SENTINEL before reconcile\n--- SESSION BOUNDARY: retained fixture marker ---\nHISTORY_SENTINEL prior boundary\n');
 const history=new HistoryQuery({transcriptsRoot:path.dirname(path.dirname(transcriptPath)),exec:async()=>{throw Error('native history backend not selected');}});
 const obligation=await queueRepo.create({qitemId:'qitem-owned-legacy-qualification',sourceSession:control.name,destinationSession:target.name,body:'Owned fixture obligation survives reconcile',nudge:false});
 const facts=async()=>({binding:db.prepare('SELECT * FROM bindings WHERE node_id=?').get(target.node.id),sessions:db.prepare('SELECT * FROM sessions WHERE node_id=? ORDER BY id').all(target.node.id),tenures:db.prepare('SELECT * FROM occupant_tenures WHERE node_id=? ORDER BY generation_ordinal').all(target.node.id),node:db.prepare('SELECT * FROM nodes WHERE id=?').get(target.node.id),queue:db.prepare('SELECT * FROM queue_items WHERE qitem_id=?').get(obligation.qitemId),tmux:(await tmux('display-message','-p','-t',target.name,'#{pid}|#{pane_id}|#{pane_pid}|#{session_id}')).trim(),pane:await tmux('capture-pane','-p','-t',target.name),stdin:fs.existsSync(target.record)?fs.readFileSync(target.record,'utf8'):'',transcript:fs.readFileSync(transcriptPath,'utf8'),history:await history.searchSeat(rig.rig.name,target.name,'HISTORY_SENTINEL'),transcriptPath});
 phase='matching-control';const matching=await cli(['send',control.name,'MATCHING_BINDING_CONTROL','--json']);assert.equal(matching.code,0);assert.equal(data(matching)?.ok,true);
 phase='before-refusal';const initial=await facts();records.before=initial;save();const refused=await cli(['send',target.name,'MUST_NOT_REACH_NULL_BINDING','--json']);assert.notEqual(refused.code,0);assert.match(refused.stdout+refused.stderr,/Managed pane identity unavailable or changed/);assert.equal(fs.readFileSync(target.record,'utf8'),initial.stdin);
 phase='reconcile';const beforeReconcile=await facts();records.beforeReconcile=beforeReconcile;const seq=db.prepare('SELECT max(seq) AS seq FROM events').get().seq;
 const result=await cli(['reconcile-session',target.name,'--no-launch','--json']);records.reconcileBody=data(result);records.afterReconcile=await facts();records.reconcileEvents=db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq').all(seq);save();
 assert.equal(result.code,0);assert.equal(records.reconcileBody?.ok,true);assert.equal(records.reconcileBody.result.continuity,'unverified');
 assert.equal(records.afterReconcile.binding.tmux_pane,target.pane);assert.equal(records.afterReconcile.tmux,beforeReconcile.tmux);assert.equal(records.afterReconcile.stdin,beforeReconcile.stdin);assert.equal(records.afterReconcile.pane,beforeReconcile.pane);
 const forbidden=records.commands.filter(x=>x.phase==='reconcile'&&/\b(?:send-keys|paste-buffer|load-buffer|new-session|respawn-pane|kill-session|kill-pane)\b/.test(x.command));records.checks.reconcileForbiddenCommands=forbidden;assert.equal(forbidden.length,0);
 phase='after-send';const sent=await cli(['send',target.name,'AFTER_RECONCILE_MARKER','--json']);assert.equal(sent.code,0);assert.equal(data(sent)?.ok,true);
 for(let n=0;n<40;n++){if(fs.readFileSync(target.record,'utf8').includes('AFTER_RECONCILE_MARKER'))break;await sleep(50);}records.afterSend=await facts();assert.match(records.afterSend.stdin,/AFTER_RECONCILE_MARKER/);assert.match(records.afterSend.pane,/AFTER_RECONCILE_MARKER/);
 records.checks.queueBytesPreserved=JSON.stringify(initial.queue)===JSON.stringify(records.afterReconcile.queue);assert.equal(records.checks.queueBytesPreserved,true);
 records.checks.historyMarkersPreserved=records.afterReconcile.transcript.includes('HISTORY_SENTINEL before reconcile')&&records.afterReconcile.transcript.includes('retained fixture marker');
 records.checks.oldResumeAnomalyPreserved=records.afterReconcile.sessions.find(s=>s.id===target.session.id).resume_type==='codex_id'&&records.afterReconcile.node.runtime==='claude-code';assert.equal(records.checks.oldResumeAnomalyPreserved,true);
 records.checks.sessionRowsAdded=records.afterReconcile.sessions.length-initial.sessions.length;records.checks.tenuresAdded=records.afterReconcile.tenures.length-initial.tenures.length;
 records.status='completed';await db.backup(path.join(out,'fixture-after.sqlite'));save();
}catch(error){records.status='failed';records.failure={message:error.message,stack:error.stack,phase};save();process.exitCode=1;}
finally{phase='owned-shutdown';try{await tmux('kill-server');records.ownedTmuxShutdown=true;}catch(e){records.ownedTmuxShutdown={error:e.message};}try{if(server)await new Promise(r=>server.close(r));}catch{}try{daemon?.db.close();}catch{}save();}
process.exit(process.exitCode??0);
