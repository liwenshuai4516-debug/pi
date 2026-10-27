import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { UiWorkflowService, RuntimeAdmissionService, capabilities, assetDigest } from '../../packages/ui-testing/dist/index.js';
import { setup, response } from '../support/ui-design-fixture.mjs';
import { ready } from '../support/ui-run-fixture.mjs';
import { analyzeTask } from '../../packages/ui-testing/dist/analysis.js';
const runtime={tools:['read',...capabilities.map(c=>c.tool)],skills:['ui-discover-record','ui-case-design','ui-design-review','ui-test-run','ui-result-analysis','ui-result-review','ui-test-workflow']};
const service=f=>new UiWorkflowService(f.root,f.authority,runtime);

test('U03: task-id handoff validates once, survives concurrent duplicate/reopen/cancel and never grants execution consent',async t=>{
 const f=await setup(t), w=service(f), before=f.fixture.state.browserRequests;
 let state=await w.start({task_id:'only-record',mode:'record',scope_ref:f.asset.data.scope_ref,discovery:'source'});
 const inv=await f.store.load(f.asset.data.inventory_ref);inv.id='handoff-inventory';inv.data.draft_refs=[await f.store.putFile('qa/ui/inventories/handoff-inventory/source.ts','// declared source')];const ref=await f.store.put(inv);
 const event={task_id:'only-record',stage:'discover-record',output_refs:[ref]};
 const duplicates=await Promise.allSettled([w.handoff(event),w.handoff(event)]);
 assert.equal(duplicates.filter(s=>s.status==='fulfilled').length,1);
 assert.match(duplicates.find(s=>s.status==='rejected').reason.message,/占用/);
 assert.equal((await w.find('only-record')).task.data.stage,'case-design');
 assert.equal((await service(f).handoff(event)).replayed,true);
 await assert.rejects(w.handoff({...event,output_refs:[f.assetRef]}),/重复交接/);
 const cancelled=new AbortController();cancelled.abort();
 await assert.rejects(w.handoff({task_id:'only-record',stage:'case-design',output_refs:[f.assetRef]},cancelled.signal),/取消/);
 const candidate=structuredClone(f.asset);candidate.id='handoff-candidate';candidate.data.inventory_ref=ref;candidate.data.content_sha256=assetDigest(candidate);const assetRef=await f.store.put(candidate);
 state=await w.handoff({task_id:'only-record',stage:'case-design',output_refs:[assetRef]});
 assert.deepEqual(state.stage_inputs.asset_refs,[assetRef]);assert.deepEqual(state.directory.map(s=>s.skill),['ui-design-review']);
 const review=await f.service.assess(state.task_ref,assetRef,'handoff-design',response);
 state=await w.handoff({task_id:'only-record',stage:'design-review',output_refs:[review.review_ref]});
 await assert.rejects(w.handoff({...event,output_refs:[assetRef]}),/原阶段/);
 assert.equal(state.task.data.state,'completed');assert.equal(state.task.data.run_ids.length,0);
 await assert.rejects(w.continueExecute('only-record',assetRef),/new/);
 assert.equal(f.fixture.state.browserRequests,before);
});

test('U07/U03: valid diagnostic lookup launches nothing; all-pass analyze-task creates candidate, handoff and restart are idempotent', {timeout:60000},async t=>{
 const d=await ready(t),{f}=d,w=service(f), admission=new RuntimeAdmissionService(f.root,f.authority);
 const before=f.fixture.state.browserRequests;
 const reused=await admission.reuse(d.assetRef,d.reviewed.review_ref,d.specRef);
 assert.equal(reused.runtime_ready,true);assert.equal(reused.reused,true);assert.equal(f.fixture.state.browserRequests,before);
 await assert.rejects(admission.reuse(d.assetRef,d.reviewed.review_ref,{...d.specRef,sha256:'0'.repeat(64)}),/诊断|摘要/);
 const task=await w.start({task_id:'optimized-run',mode:'execute',asset_ref:d.assetRef});
 const run=await d.service.start({...d.request,task_id:'optimized-run',request_id:'optimized-run'});
 const current=await w.find('optimized-run');assert.equal(current.stage_inputs.run_ref.sha256,run.run_ref.sha256);
 const requests=f.fixture.state.browserRequests;
 const first=await analyzeTask(w,'optimized-run');assert.equal(first.workflow.task.data.stage,'result-review');assert.equal(first.summary.counts.passed,1);assert.deepEqual(first.groups,[]);
 const again=await analyzeTask(service(f),'optimized-run');assert.equal(again.replayed,true);assert.deepEqual(again.report_ref,first.report_ref);assert.equal(f.fixture.state.browserRequests,requests);
 const report=await f.store.load(first.report_ref);assert.equal(report.kind,'report');
 await assert.rejects(w.handoff({task_id:'optimized-run',stage:'result-review',output_refs:[first.report_ref]}),/批准|评审|评估/);
 const view=await w.start({task_id:'only-view',mode:'view',run_ref:run.run_ref});
 await assert.rejects(analyzeTask(w,'only-view'),/查看/);assert.equal(f.fixture.state.browserRequests,requests);
 // A child task must analyze its own run, never its frozen parent input.
 const parentBytes=await readFile(join(f.root,run.run_ref.path));
 await w.start({task_id:'optimized-child',mode:'rerun-all',run_ref:run.run_ref});
 const child=await d.service.start({...d.request,task_id:'optimized-child',request_id:'optimized-child',parent_run_ref:run.run_ref});
 assert.deepEqual((await w.find('optimized-child')).stage_inputs.run_ref,child.run_ref);
 const childAnalysis=await analyzeTask(w,'optimized-child');
 assert.deepEqual((await f.store.load(childAnalysis.report_ref)).data.run_ref,child.run_ref);
 assert.deepEqual(await readFile(join(f.root,run.run_ref.path)),parentBytes);
 const queries=f.fixture.state.browserRequests;
 // Every registered input is revalidated, including target deployment/role/data declarations and helper/config/source bytes.
 const targets=[d.config,d.spec.environment_ref,d.asset.data.bindings[0].script_ref,d.asset.data.files.find(r=>r.path.endsWith('data-rules.json')),d.asset.data.files.find(r=>r.path.endsWith('positive-source.html'))];
 for(const ref of targets){
  const path=join(f.root,ref.path),bytes=await readFile(path);
  await writeFile(path,Buffer.concat([bytes,Buffer.from('\nchanged fixture input')]));
  await assert.rejects(admission.reuse(d.assetRef,d.reviewed.review_ref,d.specRef));
  await writeFile(path,bytes);
 }
 const requestPath=join(f.authority,'runtime/requests/unknown-fixture.json');
 await writeFile(requestPath,JSON.stringify({request_id:'unknown-fixture',state:'unknown',module_ids:['names']}));
 await assert.rejects(admission.reuse(d.assetRef,d.reviewed.review_ref,d.specRef),/未核对/);await rm(requestPath);
 const accepted=join(f.authority,'runtime/accepted');
 const receiptPath=join(accepted,(await readdir(accepted))[0]),receipt=await readFile(receiptPath);
 await writeFile(receiptPath,JSON.stringify({...JSON.parse(receipt),rules_version:'outdated-fixture'}));
 await assert.rejects(admission.reuse(d.assetRef,d.reviewed.review_ref,d.specRef),/失效|规则/);await writeFile(receiptPath,receipt);
 assert.equal((await admission.reuse(d.assetRef,d.reviewed.review_ref,d.specRef)).reused,true);
 assert.equal(f.fixture.state.browserRequests,queries);

});

test('U07: failed instances keep evidence, findings cannot omit an instance, partial evidence never becomes approved',{timeout:60000},async t=>{
 const d=await ready(t,{targetFault:true}),{f}=d,w=service(f);
 await w.start({task_id:'failed-analysis',mode:'analyze',run_ref:(await d.service.start(d.request)).run_ref});
 const before=f.fixture.state.browserRequests;
 const pending=await analyzeTask(w,'failed-analysis');
 assert.equal(pending.summary.counts.failed,1);assert.equal(pending.groups.length,1);assert.equal(pending.workflow.task.data.stage,'analyze');
 const instance=pending.groups[0].instances[0];assert.ok(instance.attempts.length);assert.ok(instance.attempts[0].evidence_refs.length);
 await assert.rejects(analyzeTask(w,'failed-analysis',[]),/遗漏/);
 const findings=[{instance_id:instance.instance_id,classification:'insufficient-evidence',certainty:'unknown',facts:['The persistence assertion failed in this native attempt.'],hypotheses:[],supporting_refs:instance.attempts[0].evidence_refs,alternatives:['UI evidence does not establish an internal server cause.'],next_action:'Inspect this instance trace; do not replay unknown effects.'}];
 const done=await analyzeTask(w,'failed-analysis',findings);
 assert.equal(done.workflow.task.data.stage,'result-review');assert.equal(done.summary.counts.failed,1);
 assert.equal(f.fixture.state.browserRequests,before);
 await assert.rejects(analyzeTask(w,'failed-analysis',[{...findings[0],facts:['Changed explanation']}]),/更换结论/);
 const beforeTask=await w.find('failed-analysis');const controller=new AbortController();controller.abort();
 await assert.rejects(analyzeTask(w,'failed-analysis',undefined,controller.signal),/取消/);
 assert.deepEqual((await w.find('failed-analysis')).task_ref,beforeTask.task_ref);
});

test('U03: completed new task needs matching whole-asset consent; duplicate continuation creates one execution task',{timeout:60000},async t=>{
 const d=await ready(t),{f}=d,w=service(f);
 let task=await w.start({task_id:'create-and-run',mode:'new',scope_ref:f.asset.data.scope_ref,discovery:'source'});
 const inv=await f.store.load(f.asset.data.inventory_ref);inv.data.draft_refs=[await f.store.putFile('qa/ui/inventories/inventory-1/drafts/source.ts','// source')];
 // Use a fresh immutable inventory/candidate and earn protocol-fixture approval/diagnostics.
 inv.id='continue-inventory';const invRef=await f.store.put(inv);
 const candidate=structuredClone(d.asset);candidate.id='continue-candidate';candidate.data.inventory_ref=invRef;candidate.data.content_sha256=assetDigest(candidate);const ref=await f.store.put(candidate);
 task=await w.handoff({task_id:task.task.id,stage:'discover-record',output_refs:[invRef]});
 task=await w.handoff({task_id:task.task.id,stage:'case-design',output_refs:[ref]});
 const reviewed=await f.service.assess(task.task_ref,ref,'continue-design',response);
 task=await w.handoff({task_id:task.task.id,stage:'design-review',output_refs:[reviewed.review_ref]});
 await assert.rejects(w.continueExecute(task.task.id,d.assetRef),/完整资产/);
 await assert.rejects(w.continueExecute(task.task.id,ref),/运行就绪/);
 await new RuntimeAdmissionService(f.root,f.authority).diagnose(ref,reviewed.review_ref,d.specRef,'continue-diagnostic');
 const before=f.fixture.state.browserRequests;
 const first=await w.continueExecute(task.task.id,ref),second=await service(f).continueExecute(task.task.id,ref);
 assert.equal(first.task.id,second.task.id);assert.equal(first.source_task_id,task.task.id);assert.equal(first.execution_scope.full_asset,true);
 assert.deepEqual(first.execution_scope.case_ids,['C1']);assert.equal(first.task.data.stage,'execute');assert.deepEqual(first.task.data.run_ids,[]);
 assert.equal(f.fixture.state.browserRequests,before,'continuation registers a task, never launches browser');
});

test('U07: grouping retains separate attempts, flaky state, cancellation, cleanup and evidence gaps',async()=>{
 const {groupFailures}=await import('../../packages/ui-testing/dist/analysis.js');
 const ref={path:'qa/ui/runs/sample/report.json',sha256:'a'.repeat(64)};
 const attempt={attempt:0,native_status:'failed',errors:['same observed failure'],evidence_refs:[ref]};
 const instances=[{instance_id:'I1',status:'failed',evidence_state:'complete',attempts:[attempt]},{instance_id:'I2',status:'failed',evidence_state:'complete',attempts:[{...attempt,evidence_refs:[{...ref,path:'qa/ui/runs/sample/output/I2/trace.zip'}]}]},{instance_id:'I3',status:'flaky',evidence_state:'missing',attempts:[attempt,{attempt:1,native_status:'passed',errors:[],evidence_refs:[ref]}]},{instance_id:'I4',status:'cancelled',evidence_state:'missing',attempts:[]}];
 const details=instances.map(i=>({instance_id:i.instance_id,cleanup:[{status:'retained',reason:'fixture residual'}],evidence_gaps:['fixture gap']}));
 const groups=groupFailures({data:{instances},details:{instances:details}});
 assert.equal(groups.length,3);assert.deepEqual(groups[0].instances.map(i=>i.instance_id),['I1','I2']);
 assert.equal(groups.flatMap(g=>g.instances).length,4);assert.equal(groups.find(g=>g.status==='flaky').instances[0].attempts.length,2);
 assert.deepEqual(groups.flatMap(g=>g.details),details);assert.notDeepEqual(groups[0].instances[0].attempts[0].evidence_refs,groups[0].instances[1].attempts[0].evidence_refs);
});

test('U03: cancellation during artifact validation leaves the current stage unchanged',async t=>{
 const f=await setup(t),w=service(f),controller=new AbortController();
 const task=await w.start({task_id:'cancel-validation',mode:'record',scope_ref:f.asset.data.scope_ref,discovery:'source'});
 const inv=await f.store.load(f.asset.data.inventory_ref);inv.id='cancel-inventory';inv.data.draft_refs=[await f.store.putFile('qa/ui/inventories/cancel-inventory/source.ts','// source')];
 const ref=await f.store.put(inv),load=w.store.load.bind(w.store);
 w.store.load=async(...args)=>{const value=await load(...args);if(args[0].path===ref.path)controller.abort();return value;};
 await assert.rejects(w.handoff({task_id:task.task.id,stage:'discover-record',output_refs:[ref]},controller.signal),/取消/);
 assert.deepEqual((await service(f).find(task.task.id)).task_ref,task.task_ref);
});
