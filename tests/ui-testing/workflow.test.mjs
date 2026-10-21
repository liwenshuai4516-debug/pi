import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UiWorkflowService, DesignReviewService, ArtifactStore, capabilities, assetDigest,
  sha256, collectResults, saveAnalysis, draftReport } from '../../packages/ui-testing/dist/index.js';
import { setup, prepareDiagnostic, response, decision } from '../support/ui-design-fixture.mjs';
import { ready } from '../support/ui-run-fixture.mjs';
import { resultFixture, resultDecision, finding } from '../support/ui-result-fixture.mjs';
import { artifact } from '../support/ui-artifacts.mjs';
import { PluginManager } from '../../dist/main/plugins/manager.js';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { repoRoot, textContent } from '../support/ui-fixture.mjs';

const runtime={tools:['read',...capabilities.map(c=>c.tool),'mcp__playwright_test__generator_setup_page'],
  skills:['ui-discover-record','ui-case-design','ui-design-review','ui-test-run','ui-result-analysis','ui-result-review','ui-test-workflow']};
const service=f=>new UiWorkflowService(f.root,f.authority,runtime);

test('UI-09: source-only record persists verified stages and stops after design approval without executing a browser',async t=>{
  const f=await setup(t),workflow=service(f),before=f.fixture.state.browserRequests;
  let task=await workflow.start({task_id:'record-only',mode:'record',scope_ref:f.asset.data.scope_ref,discovery:'source'});
  await assert.rejects(workflow.start({task_id:'invalid-mode',mode:'unsupported',scope_ref:f.asset.data.scope_ref}),/不符合契约/);
  await assert.rejects(workflow.start({task_id:'unknown-schema',mode:'record',scope_ref:f.asset.data.scope_ref,schema_version:'2.0'}),/不符合契约/);
  assert.deepEqual(task.sequence,['discover-record','case-design','design-review']);assert.equal(task.task.data.state,'running');
  assert.deepEqual(task.directory.map(d=>d.skill),['ui-discover-record','ui-case-design','ui-design-review']);
  await assert.rejects(workflow.checkpoint(task.task_ref,'execute',[f.assetRef]),/阶段/);
  const inventory=await f.store.load(f.asset.data.inventory_ref);inventory.id='source-workflow';
  inventory.data.draft_refs=[await f.store.putFile('qa/ui/inventories/source-workflow/drafts/name.spec.ts','// source-grounded draft; not browser-recorded')];
  const inventoryRef=await f.store.put(inventory);
  const originalTaskRef=task.task_ref;task=await workflow.checkpoint(task.task_ref,'discover-record',[inventoryRef]);
  await assert.rejects(workflow.checkpoint(originalTaskRef,'case-design',[f.assetRef]),/摘要/);
  await assert.rejects(workflow.checkpoint(task.task_ref,'case-design',[f.assetRef]),/功能清单/);
  const candidate=structuredClone(f.asset);candidate.id='workflow-candidate';candidate.data.inventory_ref=inventoryRef;
  candidate.data.content_sha256=assetDigest(candidate);const assetRef=await f.store.put(candidate);
  task=await workflow.checkpoint(task.task_ref,'case-design',[assetRef]);
  await assert.rejects(workflow.checkpoint(task.task_ref,'design-review',[f.assetRef]),/设计评估/);
  const reviewed=await new DesignReviewService(f.root,f.authority).assess(task.task_ref,assetRef,'record-review',response);
  task=await workflow.checkpoint(task.task_ref,'design-review',[reviewed.review_ref]);
  assert.equal(task.task.data.state,'completed');assert.equal(task.next_stage,null);assert.equal(task.follow_up,null);
  assert.deepEqual(task.task.data.run_ids,[]);assert.equal(f.fixture.state.browserRequests,before);
  const reopened=await new UiWorkflowService(f.root,f.authority,runtime).find('record-only');
  assert.equal(reopened.task.data.state,'completed');
  await assert.rejects(workflow.start({task_id:'record-only',mode:'new',scope_ref:f.asset.data.scope_ref,discovery:'source'}),/不能更换/);
  let fresh=await workflow.start({task_id:'new-tests',mode:'new',scope_ref:f.asset.data.scope_ref,discovery:'source'});
  fresh=await workflow.checkpoint(fresh.task_ref,'discover-record',[inventoryRef]);
  fresh=await workflow.checkpoint(fresh.task_ref,'case-design',[assetRef]);
  fresh=await workflow.checkpoint(fresh.task_ref,'design-review',[reviewed.review_ref]);
  assert.equal(fresh.task.data.state,'completed');assert.match(fresh.follow_up,/execute/);
  assert.deepEqual(fresh.task.data.run_ids,[],'new mode hands off to a separate execution task');
  const corrupt=structuredClone(f.asset);corrupt.data.content_sha256='0'.repeat(64);
  await writeFile(join(f.root,f.assetRef.path),JSON.stringify(corrupt));
  const catalog=await workflow.catalog();assert.ok(catalog.invalid.some(i=>i.path===f.assetRef.path));
  assert.ok(catalog.assets.some(a=>a.asset_ref.path===assetRef.path),'an unrelated corrupt asset does not hide valid candidates');
});

test('UI-09: missing capability and incompatible versions persist blockers; interrupted tasks cannot be bypassed with a fresh task id',{timeout:60000},async t=>{
  const f=await setup(t);
  const missing=new UiWorkflowService(f.root,f.authority,{tools:['read'],skills:[]});
  const blocked=await missing.start({task_id:'missing',mode:'record',scope_ref:f.asset.data.scope_ref,discovery:'browser'});
  assert.equal(blocked.task.data.state,'blocked');assert.ok(blocked.blockers.some(b=>b.category==='missing-capability'));
  assert.ok((await f.store.load(blocked.task_ref)).data.blockers.some(b=>b.includes('MCP')));
  await mkdir(join(f.root,'node_modules-other/playwright'),{recursive:true});
  await writeFile(join(f.root,'node_modules-other/playwright/package.json'),JSON.stringify({name:'playwright',version:'0.0.0'}));
  const other=join(f.root,'version-project');await mkdir(other);await symlink(join(f.root,'node_modules-other'),join(other,'node_modules'),'dir');
  await writeFile(join(other,'package.json'),'{}');
  const otherStore=new ArtifactStore(other),scope=await f.store.load(f.asset.data.scope_ref);
  scope.data.sources=[];const scopeRef=await otherStore.put(scope);
  const incompatible=await new UiWorkflowService(other,f.authority,runtime).start({task_id:'incompatible',mode:'record',scope_ref:scopeRef,discovery:'browser'});
  assert.ok(incompatible.blockers.some(b=>b.category==='incompatible-version'&&b.message.includes('0.0.0')));
  const d=await ready(t),active=await d.service.start(d.request,new AbortController().signal);
  assert.equal(active.run.data.state,'finished');
  const reservation=await d.f.store.reserveRun(artifact('run',{...active.run.data,request_id:'orphan',state:'pending',pid:undefined,
    exit_code:undefined,output_refs:[],process_token:sha256('orphan')},'orphan-run'));
  assert.ok(reservation.created);
  const guarded=await service(d.f).start({task_id:'different-task',mode:'execute',asset_ref:d.assetRef});
  assert.equal(guarded.task.data.state,'blocked');assert.ok(guarded.blockers.some(b=>b.message.includes('换任务 ID')));
  const clonedScope=await d.f.store.load(d.asset.data.scope_ref);clonedScope.id='same-target-new-scope';
  const clonedScopeRef=await d.f.store.put(clonedScope);
  const clonedAsset=structuredClone(d.asset);clonedAsset.id='same-target-new-asset';clonedAsset.data.scope_ref=clonedScopeRef;
  clonedAsset.data.content_sha256=assetDigest(clonedAsset);const clonedAssetRef=await d.f.store.put(clonedAsset);
  const changedScope=await service(d.f).start({task_id:'different-scope-task',mode:'execute',asset_ref:clonedAssetRef});
  assert.ok(changedScope.blockers.some(b=>b.message.includes('换任务 ID')),'renaming scope for the same target cannot hide the orphan launch');
  const changed=structuredClone(guarded.task);changed.data.workflow.mode='record';
  await assert.rejects(d.f.store.updateTask(guarded.task_ref,changed),/任务输入/);
});

async function runProcess(f,prompt,name){
  const output=join(f.root,`${name}.json`);
  await promisify(execFile)(process.execPath,[join(repoRoot,'tests/support/ui-workflow-process.mjs'),f.fixture.agentDir,f.root,output,prompt],
    {cwd:repoRoot,timeout:60000,maxBuffer:1024*1024});
  if(f.fixture.state.responseError)throw f.fixture.state.responseError;
  return JSON.parse(await readFile(output,'utf8'));
}
const previous=body=>JSON.parse(textContent(body.messages.filter(m=>m.role==='tool').at(-1)?.content));

test('UI-09: a fully exited Agent process is replaced by a new session that discovers and runs the approved asset without recording or redesign',{timeout:180000},async t=>{
  const d=await prepareDiagnostic(t),{f,assetRef,specRef,spec,config}=d;
  await new PluginManager(f.fixture.agentDir,f.root).install(join(repoRoot,'packages/ui-testing'),'package');
  let phase=1,count=0,reviewRef,taskRef,runRef,secondRun;
  f.fixture.state.respond=body=>{
    if(body.messages.some(m=>m.role==='system'&&JSON.stringify(m.content).includes('你是独立 UI 测试设计评估者'))){
      const user=body.messages.find(m=>m.role==='user');return {text:JSON.stringify(decision(JSON.parse(textContent(user.content))))};
    }
    if(count++===0)return phase===1?{tool:'ui_design_review',args:{task_ref:f.taskRef,asset_ref:assetRef,request_id:'first-process-review'}}
      :{tool:'ui_test_workflow',args:{request:{operation:'catalog'}}};
    if(count===(phase===1?6:4)){
      assert.match(textContent(body.messages.filter(m=>m.role==='tool').at(-1)?.content),/ui-test-run/);
      return {tool:'ui_test_run',args:{request:{operation:'start',input:{task_id:`process-${phase}`,request_id:'formal',asset_ref:assetRef,
        review_ref:reviewRef,environment_ref:spec.environment_ref,config_ref:config,timeout_ms:15000}}}};
    }
    const last=previous(body);
    assert.equal(last.status,'completed',JSON.stringify(last));
    if(phase===1&&count===2){reviewRef=last.output.review_ref;return {tool:'ui_design_diagnose',args:{request:{operation:'diagnose',asset_ref:assetRef,review_ref:reviewRef,spec_ref:specRef,request_id:'first-process-diagnostic'}}};}
    if(phase===1&&count===3)return {tool:'ui_test_workflow',args:{request:{operation:'catalog'}}};
    const step=count-(phase===1?2:0);
    if(step===2){
      const selected=last.output.assets.find(a=>a.asset_ref.path===assetRef.path);assert.equal(selected.runtime_ready,true);
      reviewRef=selected.review_refs[0];
      return {tool:'ui_test_workflow',args:{request:{operation:'start',input:{task_id:`process-${phase}`,mode:'execute',asset_ref:selected.asset_ref}}}};
    }
    if(step===3){taskRef=last.output.task_ref;assert.deepEqual(last.output.sequence,['execute','analyze','result-review']);
      return {tool:'read',args:{path:last.output.directory[0].path}};}
    if(step===5){runRef=last.output.run_ref;assert.equal(last.output.replayed,false);return {tool:'ui_test_workflow',args:{request:{operation:'status',task_id:`process-${phase}`}}};}
    if(step===6){taskRef=last.output.task_ref;return {tool:'ui_test_workflow',args:{request:{operation:'checkpoint',task_ref:taskRef,stage:'execute',output_refs:[runRef]}}};}
    assert.equal(last.output.next_stage,'analyze');if(phase===2)secondRun=runRef;
    return {text:'Formal run saved with stage checkpoint; result analysis remains pending.'};
  };
  const first=await runProcess(f,'Prepare and execute the selected asset in process one, then stop at the saved analysis checkpoint.','first-process');
  const firstRun=runRef;phase=2;count=0;
  const before=f.fixture.state.browserRequests;
  const second=await runProcess(f,'NEW_SESSION_MARKER Discover existing approved assets and execute one new batch. Do not record or regenerate.','second-process');
  assert.notEqual(first.session_id,second.session_id);assert.notDeepEqual(firstRun,secondRun);assert.ok(f.fixture.state.browserRequests>before);
  assert.deepEqual(second.calls,['ui_test_workflow','ui_test_workflow','read','ui_test_run','ui_test_workflow','ui_test_workflow']);
  assert.equal(second.calls.some(name=>/record|design/.test(name)),false);assert.ok(second.skills.includes('ui-test-workflow'));
  const selected=f.fixture.state.payloads.filter(body=>JSON.stringify(body.messages).includes('NEW_SESSION_MARKER'));
  assert.ok(selected.every(body=>!JSON.stringify(body.messages).includes('Prepare and execute the selected asset in process one')));
  const ended=await service(f).find('process-2');assert.equal(ended.task.data.stage,'analyze');assert.deepEqual(ended.task.data.completed_stages,['execute']);
});

test('UI-09: analyze and view routes use old evidence only; full result review completes the selected workflow',{timeout:60000},async t=>{
  const d=await resultFixture(t),{f,execution,result}=d;
  await new PluginManager(f.fixture.agentDir,f.root).install(join(repoRoot,'packages/ui-testing'),'package');
  const host=new AgentHost(()=>{},()=>{},f.fixture.agentDir);t.after(()=>host.dispose());const view=await host.create(f.root,true);
  let count=0,taskRef,parsed,reportRef,reviewRef;
  const before=f.fixture.state.browserRequests;
  f.fixture.state.respond=body=>{
    if(body.messages.some(m=>m.role==='system'&&JSON.stringify(m.content).includes('你是独立 UI 测试结果评估者'))){
      const user=body.messages.find(m=>m.role==='user');return {text:JSON.stringify(resultDecision(JSON.parse(textContent(user.content))))};
    }
    if(count++===0)return {tool:'ui_test_workflow',args:{request:{operation:'start',input:{task_id:'analyze-old',mode:'analyze',run_ref:execution.run_ref}}}};
    const last=previous(body);assert.equal(last.status,'completed',JSON.stringify(last));
    if(count===2){taskRef=last.output.task_ref;assert.deepEqual(last.output.directory.map(d=>d.skill),['ui-result-analysis','ui-result-review']);
      return {tool:'ui_result_analysis',args:{request:{operation:'parse',run_ref:execution.run_ref,result_id:'workflow-analysis'}}};}
    if(count===3){parsed=last.output;return {tool:'ui_result_analysis',args:{request:{operation:'save-analysis',analysis:artifact('analysis',{
      run_ref:execution.run_ref,results_ref:parsed.results_ref,findings:[finding(parsed)]},'workflow-analysis')}}};}
    if(count===4)return {tool:'ui_result_analysis',args:{request:{operation:'draft-report',results_ref:parsed.results_ref,analysis_ref:last.output.analysis_ref,report_id:'workflow-analysis'}}};
    if(count===5){reportRef=last.output.report_ref;return {tool:'ui_test_workflow',args:{request:{operation:'checkpoint',task_ref:taskRef,stage:'analyze',output_refs:[reportRef]}}};}
    if(count===6){taskRef=last.output.task_ref;return {tool:'ui_result_review',args:{request:{operation:'review',report_ref:reportRef,request_id:'workflow-result-review'}}};}
    if(count===7){reviewRef=last.output.review_ref;return {tool:'ui_test_workflow',args:{request:{operation:'checkpoint',task_ref:taskRef,stage:'result-review',output_refs:[reviewRef]}}};}
    assert.equal(last.output.task.data.state,'completed');return {text:'The selected old run remains failed; the report workflow is completed.'};
  };
  await host.send(view.id,'/skill:ui-test-workflow Analyze this old run only; independently review the report.',[],[]);
  if(f.fixture.state.responseError)throw f.fixture.state.responseError;
  assert.equal(f.fixture.state.browserRequests,before);assert.equal(result.data.counts.failed,1);
  const workflow=service(f);let task=await workflow.start({task_id:'view-old',mode:'view',run_ref:execution.run_ref});
  assert.equal(task.directory.length,0);task=await workflow.checkpoint(task.task_ref,'analyze',[execution.run_ref]);
  assert.equal(task.task.data.state,'completed');assert.equal(f.fixture.state.browserRequests,before);
  // 合成未启动批次只验证报告归属门禁，不伪装真实业务执行。
  const unexecutedTask=artifact('task',{intent:'execute',scope_ref:f.asset.data.scope_ref,state:'running',stage:'execute',completed_stages:[],
    asset_refs:[execution.run.data.asset_ref],run_ids:[],output_refs:[],blockers:[],input_sha256:sha256('synthetic-no-execution')},'unexecuted-task');
  await f.store.put(unexecutedTask);
  const reservation=await f.store.reserveRun(artifact('run',{...execution.run.data,task_id:unexecutedTask.id,request_id:'never-started',
    state:'pending',pid:undefined,exit_code:undefined,output_refs:[],command:['synthetic-no-execution'],process_token:sha256('unexecuted')},'unexecuted-run'));
  const unexecutedRef=await f.store.finishRun(reservation.ref,null,[],true);
  const unexecuted=await collectResults(f.root,unexecutedRef,'unexecuted-result');
  const unknown=finding(unexecuted);unknown.classification='insufficient-evidence';unknown.facts=['No native report exists; execution outcome is unknown.'];
  const unexecutedAnalysis=await saveAnalysis(f.root,artifact('analysis',{run_ref:unexecutedRef,results_ref:unexecuted.results_ref,findings:[unknown]},'unexecuted-analysis'));
  const otherReport=await draftReport(f.root,unexecuted.results_ref,unexecutedAnalysis.analysis_ref,'unexecuted-report');
  let guarded=await workflow.start({task_id:'selected-run-guard',mode:'analyze',run_ref:execution.run_ref});
  guarded=await workflow.checkpoint(guarded.task_ref,'analyze',[d.report_ref]);
  await assert.rejects(workflow.checkpoint(guarded.task_ref,'result-review',[otherReport.report_ref]),/选定批次/);
  const trace=execution.run.data.output_refs.find(r=>r.path.endsWith('trace.zip'));await rm(join(f.root,trace.path));
  const partial=await collectResults(f.root,execution.run_ref,'workflow-missing-trace');
  const analysis=await saveAnalysis(f.root,artifact('analysis',{run_ref:execution.run_ref,results_ref:partial.results_ref,
    findings:[finding(partial)]},'workflow-partial-analysis'));
  const report=await draftReport(f.root,partial.results_ref,analysis.analysis_ref,'workflow-partial-report');
  let incomplete=await workflow.start({task_id:'analyze-partial',mode:'analyze',run_ref:execution.run_ref});
  incomplete=await workflow.checkpoint(incomplete.task_ref,'analyze',[report.report_ref]);
  incomplete=await workflow.checkpoint(incomplete.task_ref,'result-review',[report.report_ref]);
  assert.equal(incomplete.task.data.state,'completed');assert.ok(incomplete.delivery_ref);
  assert.match(await readFile(join(f.root,incomplete.delivery_ref.path),'utf8'),/阶段报告；完整性未通过/);
  assert.equal(f.fixture.state.browserRequests,before);
});
