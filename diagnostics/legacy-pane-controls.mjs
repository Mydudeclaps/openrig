import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const source=path.resolve(process.env.SOURCE_ROOT),out=path.resolve(process.env.PROOF_ROOT);
const home=path.join(out,'controls-home');fs.mkdirSync(home,{recursive:true});
for(const k of Object.keys(process.env))if(/^(OPENRIG_|RIGGED_|CLAUDE_|CODEX_|ANTHROPIC_|OPENAI_|TMUX)/.test(k))delete process.env[k];
Object.assign(process.env,{HOME:home,OPENRIG_HOME:path.join(home,'.openrig'),CODEX_HOME:path.join(home,'.codex')});
const req=createRequire(path.join(source,'package.json')),Database=req('better-sqlite3');
const load=rel=>import(pathToFileURL(path.join(source,'packages/daemon/dist',rel+'.js')));
const {migrate}=await load('db/migrate'),{ALL_MIGRATIONS}=await load('db/all-migrations');
const {RigRepository}=await load('domain/rig-repository'),{SessionRegistry}=await load('domain/session-registry');
const {DiscoveryRepository}=await load('domain/discovery-repository'),{EventBus}=await load('domain/event-bus');
const {ClaimService}=await load('domain/claim-service');
const {SeatDeliveryGuard,resolveGuardTarget}=await load('domain/seat-delivery-guard');
const records=[];
for(const mode of ['nonsole','unobservable']){
 const db=new Database(':memory:');migrate(db,ALL_MIGRATIONS);
 try{
  const rigRepo=new RigRepository(db),sessionRegistry=new SessionRegistry(db),eventBus=new EventBus(db);
  const rig=rigRepo.createRig('private-controls'),node=rigRepo.addNode(rig.id,'worker',{runtime:'claude-code',podId:null});
  const seat='worker@private-controls';sessionRegistry.registerSession(node.id,seat);sessionRegistry.updateBinding(node.id,{tmuxSession:seat});
  const calls=[];const tmux={hasSession:async()=>true,listPanes:async()=>{if(mode==='unobservable')throw Error('fixture observation unavailable');return[{id:'%1'},{id:'%2'}];},getPaneCommand:async()=> 'claude',setSessionOption:async(...args)=>{calls.push(['metadata',args]);return{ok:true};},sendText:async()=>{throw Error('forbidden input');},sendKeys:async()=>{throw Error('forbidden input');},createSession:async()=>{throw Error('forbidden launch');}};
  tmux.deliveryGuard=new SeatDeliveryGuard(db,name=>resolveGuardTarget(db,name));
  const svc=new ClaimService({db,rigRepo,sessionRegistry,eventBus,discoveryRepo:new DiscoveryRepository(db),tmuxAdapter:tmux,transcriptStore:{enabled:false}});
  const result=await svc.reconcileSession({sessionName:seat});
  const binding=sessionRegistry.getBindingForNode(node.id),sessions=db.prepare('SELECT * FROM sessions WHERE node_id=? ORDER BY id').all(node.id);
  const identity=db.prepare('SELECT * FROM seat_identity_verdicts WHERE node_id=?').get(node.id);
  assert.equal(result.ok,true);assert.equal(binding.tmuxPane,null);assert(result.result.projectionDrift.some(x=>x.includes(mode==='nonsole'?'2 panes':'fixture observation unavailable')));
  records.push({mode,label:'synthetic pane observation seam; real SQLite/ClaimService; no CLI or real tmux control',result,binding,sessions,identity,calls,sendabilityNotRestored:true});
 }finally{db.close();}
}
fs.writeFileSync(path.join(out,'CONTROLS.json'),JSON.stringify(records,null,2));
console.log('two remaining observation controls completed; HTTP/ok is not pane-repair proof');
