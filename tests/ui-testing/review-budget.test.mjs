import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, response, decision } from '../support/ui-design-fixture.mjs';
import { DesignReviewService } from '../../packages/ui-testing/dist/index.js';

test('host renewal preserves same-task failed attempts and adds only explicitly authorized rounds', async t => {
 const f=await setup(t); let calls=0;
 const fail=async()=>{calls++;throw new Error('controlled provider failure');};
 for(let i=1;i<=3;i++) await assert.rejects(f.service.assess(f.taskRef,f.assetRef,'failed-'+i,fail),/评估调用失败/);
 await assert.rejects(f.service.assess(f.taskRef,f.assetRef,'fourth-before',fail),/预算已耗尽/);
 const loop=(await readdir(join(f.authority,'loops')))[0], dir=join(f.authority,'loops',loop);
 const originals=await Promise.all([1,2,3].map(n=>readFile(join(dir,'attempt-'+n+'.json'))));
 const grant={authorization_id:'human-extra-two',additional_rounds:2,reason:'Explicit human authorization for two remaining calls'};
 await assert.rejects(f.service.renewBudget(f.taskRef,f.assetRef,grant,async()=>false),/授权/);
 await assert.rejects(f.service.assess(f.taskRef,f.assetRef,'fourth-denied',fail),/预算已耗尽/);
 await assert.rejects(f.service.renewBudget(f.taskRef,f.assetRef,{...grant,additional_rounds:4},async()=>true),/1.*3/);
 const receipt=await f.service.renewBudget(f.taskRef,f.assetRef,grant,async request=>{
  assert.equal(request.used_rounds,3);assert.equal(request.current_limit,3);assert.equal(request.additional_rounds,2);return true;
 });
 assert.equal(receipt.total_limit,5);
 const restored=new DesignReviewService(f.root,f.authority);
 assert.deepEqual(await restored.renewBudget(f.taskRef,f.assetRef,grant,async()=>{throw new Error('duplicate must not prompt');}),receipt);
 await assert.rejects(restored.renewBudget(f.taskRef,f.assetRef,{...grant,additional_rounds:1},async()=>true),/同一授权/);
 for(let i=4;i<=5;i++)await assert.rejects(restored.assess(f.taskRef,f.assetRef,'failed-'+i,fail),/评估调用失败/);
 await assert.rejects(restored.assess(f.taskRef,f.assetRef,'sixth',fail),/预算已耗尽/);
 assert.equal(calls,5);
 for(let n=1;n<=3;n++)assert.deepEqual(await readFile(join(dir,'attempt-'+n+'.json')),originals[n-1]);
 assert.deepEqual((await f.store.load(f.assetRef)).data.readiness,'design-only');
});

test('renewal rejects pending requests and cannot approve a candidate or move loops',async t=>{
 const f=await setup(t);let resolve;const waiting=new Promise(r=>resolve=r);
 const pending=f.service.assess(f.taskRef,f.assetRef,'pending',async input=>{await waiting;return response(input);});
 // Wait for the native pending record, not an arbitrary delay.
 let dir;
 for(let i=0;i<100;i++){
  try{const loop=(await readdir(join(f.authority,'loops')))[0];dir=join(f.authority,'loops',loop);await readFile(join(dir,'attempt-1.json'));break;}catch{await new Promise(r=>setTimeout(r,10));}
 }
 try{await assert.rejects(f.service.renewBudget(f.taskRef,f.assetRef,{authorization_id:'pending-grant',additional_rounds:1,reason:'No unknown replay'},async()=>true),/执行|不明/);}finally{resolve();await pending;}
 assert.equal((await f.store.load(f.taskRef)).data.stage,'design-review');
});


test('fourth review after explicit host renewal registers a real validated response without resetting round',async t=>{
 const f=await setup(t);
 for(let n=1;n<=3;n++)await assert.rejects(f.service.assess(f.taskRef,f.assetRef,'old-error-'+n,async()=>{throw new Error('controlled error');}),/评估调用失败/);
 await f.service.renewBudget(f.taskRef,f.assetRef,{authorization_id:'fourth-response',additional_rounds:1,reason:'Human explicitly permits one extra review'},async()=>true);
 const reviewed=await f.service.assess(f.taskRef,f.assetRef,'fourth-response',response);
 assert.equal(reviewed.round,4);assert.equal(reviewed.decision,'approved');
 const artifact=await f.store.load(reviewed.review_ref);assert.equal(artifact.data.round,4);
 await assert.rejects(f.service.gate(f.assetRef,reviewed.review_ref),/运行就绪/);
 await assert.rejects(f.service.assess(f.taskRef,f.assetRef,'fifth-rejected',response),/预算已耗尽/);
});


test('an intervening provider error retains latest completed review and improvement lineage',async t=>{
 const f=await setup(t);
 const first=await f.service.assess(f.taskRef,f.assetRef,'needs-revision',async input=>({raw:JSON.stringify(decision(input,'revise')),provider:'control',model:'control'}));
 const revised=await f.make('v2');
 await assert.rejects(f.service.assess(f.taskRef,revised.assetRef,'provider-error',async()=>{throw new Error('controlled provider failure');}),/评估调用失败/);
 const next=await f.service.assess(f.taskRef,revised.assetRef,'improved',async input=>{
  assert.equal(input.previous.id,(await f.store.load(first.review_ref)).id);
  return response(input);
 });
 const saved=await f.store.load(next.review_ref);assert.equal(saved.data.improvement,'improved');assert.deepEqual(saved.data.previous_review_ref,first.review_ref);
});
