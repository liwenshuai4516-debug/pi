import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ArtifactStore, UiWorkflowService, DesignReviewService, ResultReviewService, sha256 } from '../../packages/ui-testing/dist/index.js';
import { setupUiFixture, copyLiveModel, repoRoot } from '../support/ui-fixture.mjs';
import { scope } from '../support/ui-artifacts.mjs';
import { PluginManager } from '../../dist/main/plugins/manager.js';

test('UI-10 live: model creates recorded assets, reviews and runs them, reuses after process exit, and reports a real failure', {
  skip:process.env.PI_UI_FULL_LIVE!=='1',timeout:2700000,
},async t=>{
  const fixture=await setupUiFixture(),broken=await setupUiFixture({discardPersistence:true});
  t.after(()=>fixture.close());t.after(()=>broken.close());
  const root=fixture.project,store=new ArtifactStore(root),base='qa/ui/scopes/live-input';
  const evidence=join(repoRoot,'evidence/ui-testing/ui-10/full-workflow',String(Date.now()));await mkdir(evidence,{recursive:true});
  const summary={scope:'External model through production Pi package/Skills; isolated controlled target, not a real business deployment.',phases:[],m3_complete:false};
  const inputFiles=[];
  const file=async(name,content)=>{const ref=await store.putFile(`${base}/${name}`,content);inputFiles.push(ref);return ref;};
  const jsonFile=(name,value)=>file(name,JSON.stringify(value,null,2));
  const environment=url=>({schema_version:'1.0',environment_id:'test',deployment_version:'fixture-v1',base_url:url,role:'tester',
    identity:{selector:'h1',text:'Names'},initial_state:{selector:'button',text:'Save'},auth:{kind:'none'},isolation:'context',timeout_ms:5000});
  const requirement='R1: In a fresh non-persistent browser context with empty localStorage and no imported state, enter an independently generated Name, Save, then reload. The Saved names list contains exactly one item equal to the original submitted Name, without normalization. Only valid generated Names and this persistence feature are in scope. Closing the owned context cleans its localStorage.';
  await writeFile(join(root,'requirements.md'),requirement);
  const s=scope();s.id='live-scope';s.data.base_url=fixture.url;s.data.goal=requirement;s.data.budget.max_tool_calls=80;
  s.data.sources=[{source_id:'R1',oracle_type:'requirement',ref:{path:'requirements.md',sha256:sha256(requirement)},statement:requirement}];
  const scopeRef=await store.put(s),positive=await jsonFile('positive.json',environment(fixture.url)),negative=await jsonFile('negative.json',environment(broken.url));
  const config=await file('base.config.mjs',"import {readFileSync} from 'node:fs';const env=JSON.parse(readFileSync(new URL('./positive.json',import.meta.url),'utf8'));export default {timeout:15000,expect:{timeout:500},use:{baseURL:env.base_url}};");
  const negativeConfig=await file('negative.config.mjs',"import {readFileSync} from 'node:fs';const env=JSON.parse(readFileSync(new URL('./negative.json',import.meta.url),'utf8'));export default {timeout:15000,expect:{timeout:500},use:{baseURL:env.base_url}};");
  const initial=await jsonFile('initial.json',{state:'fresh context; empty localStorage; Names heading and Save button',cleanup:'close owned context'});
  const dataRules=await jsonFile('data-rules.json',{input:'independent qa-${uuid}',recording_id:'live-recording',isolation:'browser context',cleanup:'close owned context'});
  for(const [name,envRef,url] of [['positive',positive,fixture.url],['negative',negative,broken.url]]){
    const response=await fetch(url),body=await response.text(),source=await file(`${name}-source.html`,body);
    await jsonFile(`${name}-http.json`,{environment_ref:envRef,source_ref:source,request:{method:'GET',url},
      response:{status:response.status,body_sha256:sha256(body)},acquired_at:new Date().toISOString(),isolation:'separate local controlled target'});
  }
  // 仅准备环境、归属 seed 和输入资料；不预写 case、脚本、inventory、批准或结果。
  await writeFile(join(root,'playwright.config.mjs'),`export default {testDir:'./tests',timeout:15000,workers:1,use:{headless:true,baseURL:${JSON.stringify(fixture.url)}},projects:[{name:'chromium',use:{browserName:'chromium'}}]};`);
  const fixtureImport=pathToFileURL(join(repoRoot,'packages/ui-testing/dist/fixtures.js')).href;
  await writeFile(join(root,'tests/seed.spec.ts'),`import {test} from ${JSON.stringify(fixtureImport)};
test.use(${JSON.stringify({uiEnvironment:environment(fixture.url),uiOwner:{task_id:'live-new',kind:'recording',id:'live-recording'},uiProjectRoot:root})});
test('seed',async({uiData,page})=>{await uiData.prepare({creation_method:'owned-context-key',fixture_version:'1',ttl_ms:600000,cleanup_method:'owned-key-then-close-context',create:async key=>key,cleanup:async key=>{await page.evaluate(key=>{const rows=JSON.parse(localStorage.getItem('names')||'[]');localStorage.setItem('names',JSON.stringify(rows.filter(value=>value!==key)));},key);}});});`);
  const seedRef={path:'tests/seed.spec.ts',sha256:sha256(await readFile(join(root,'tests/seed.spec.ts')))};
  const inputs={scope_ref:scopeRef,initial_state_ref:initial,data_rules_ref:dataRules,seed_ref:seedRef,recording_id:'live-recording',
    output_file:'tests/live-recorded.spec.ts',project:'chromium',environment_ref:positive,config_ref:config,
    negative_environment_ref:negative,negative_config_ref:negativeConfig,files:inputFiles};
  await writeFile(join(root,'live-inputs.json'),JSON.stringify(inputs,null,2));
  await writeFile(join(fixture.agentDir,'SYSTEM.md'),
    'You are a test engineer completing an authorized isolated UI workflow. Use installed production Skills and their actual tools. Read the current stage Skill and schemas as needed. All business browser actions go through the recording or native runner tool. Never forge reviews, runtime receipts, evidence, or completed stages. Keep failures and unknown root causes. Work only in this test project; do not read authentication/configuration files or change the application/package code. Stop with saved artifacts when blocked; do not evade budgets.');
  const authority=join(fixture.agentDir,'sessions/ui-review-authority'),workflow=new UiWorkflowService(root,authority,{tools:[],skills:[]});
  const phase=async(name,prompt)=>{
    const output=join(evidence,`${name}.json`),started=Date.now();await writeFile(join(evidence,`${name}-prompt.md`),prompt);
    const item={name,started_at:new Date().toISOString()};summary.phases.push(item);
    try{
      await promisify(execFile)(process.execPath,[join(repoRoot,'tests/support/ui-workflow-process.mjs'),fixture.agentDir,root,output,prompt],
        {cwd:repoRoot,timeout:660000,maxBuffer:1024*1024,env:{...process.env,PI_UI_WORKFLOW_DEADLINE_MS:'600000',PI_UI_WORKFLOW_MAX_TOOLS:'100'}});
      const saved=JSON.parse(await readFile(output,'utf8'));item.session_id=saved.session_id;item.pid=saved.pid;item.calls=saved.calls;
      assert.equal(saved.timed_out,false);assert.equal(saved.tool_limit_reached,false);assert.notEqual(saved.stop_reason,'error');
      assert.throws(()=>process.kill(saved.pid,0),error=>error.code==='ESRCH','previous Agent process must have fully exited');
      item.all_exited=true;return saved;
    }catch(error){item.failure=error.message;throw error;}
    finally{
      try{
        const saved=JSON.parse(await readFile(output,'utf8'));
        Object.assign(item,{session_id:saved.session_id,pid:saved.pid,calls:saved.calls,stop_reason:saved.stop_reason,
          error_status:saved.error_status,quota_or_balance:saved.quota_or_balance});
      }catch{/* 子进程未写出结果时保留原失败，不能补造完成状态。 */}
      item.elapsed_ms=Date.now()-started;await writeFile(join(evidence,'summary.json'),JSON.stringify(summary,null,2));
    }
  };
  const checkExecution=async(taskId,shouldFail)=>{
    const {task}=await workflow.find(taskId);assert.equal(task.data.state,'completed');
    assert.equal(task.data.run_ids.length,1,'one requested execution must not silently create additional formal batches');
    const outputs=await Promise.all(task.data.output_refs.filter(r=>r.path.endsWith('/manifest.json')).map(async ref=>({ref,artifact:await store.load(ref)})));
    const run=outputs.find(o=>o.artifact.kind==='run'),report=outputs.findLast(o=>o.artifact.kind==='report'),review=outputs.findLast(o=>o.artifact.kind==='result-review');
    assert.ok(run&&report&&review,'complete execution requires original run, report and independent review');
    assert.equal(run.artifact.data.exit_code,shouldFail?1:0);assert.ok(run.artifact.data.plan.length>0);
    await new ResultReviewService(root,authority).gate(report.ref,review.ref);
    const results=await store.load(report.artifact.data.results_ref);assert.ok(results.data.counts[shouldFail?'failed':'passed']>0);
    const delivery=task.data.output_refs.find(r=>r.path.endsWith('.md'));assert.ok(delivery);
    return {run_ref:run.ref,report_ref:report.ref,review_ref:review.ref,delivery_ref:delivery,counts:results.data.counts};
  };
  try{
    const selection=process.env.PI_UI_PROVIDER||process.env.PI_UI_MODEL?{provider:process.env.PI_UI_PROVIDER,modelId:process.env.PI_UI_MODEL}:undefined;
    summary.model=await copyLiveModel(fixture.agentDir,process.env.PI_UI_MODEL_DIR??join(homedir(),'.pi/agent'),selection);
    await new PluginManager(fixture.agentDir,root).install(join(repoRoot,'packages/ui-testing'),'package');
    assert.equal((await store.reindex()).records.some(r=>r.kind==='asset'||r.kind==='cases'||r.kind==='recording'),false);
    const preparation=await phase('prepare',`Read live-inputs.json and requirements.md. Complete a NEW browser-discovery workflow task live-new for the supplied scope, ending after real recording, your own sourced cases/assertions and replay script, independent design approval and trusted runtime diagnosis. Use recording id live-recording to match the configured seed owner. Use the provided isolated negative target to build a diagnostic spec covering your actual assertion IDs; include all referenced input configuration/provenance and the diagnostic spec in the candidate before review. Parameterize the recorded input. Do not start formal execution yet. Preserve unselected gaps. This task has no existing assets; author the inventory/cases/assertions yourself using the real observations and R1, not any external fixture templates.`);
    for(const name of ['ui_test_workflow','ui_discover_record','ui_case_design','ui_design_review','ui_design_diagnose'])assert.ok(preparation.calls.includes(name),`production path missing ${name}`);
    const recordedActions=preparation.tool_calls.filter(c=>c.name==='ui_discover_record'&&c.arguments?.request?.operation==='action').map(c=>c.arguments.request.tool);
    for(const name of ['generator_setup_page','browser_type','browser_click','generator_read_log','generator_write_test'])assert.ok(recordedActions.includes(name),`recorded native action missing ${name}`);
    const prepared=await workflow.find('live-new');assert.equal(prepared.task.data.state,'completed');
    const preparedArtifacts=await Promise.all(prepared.task.data.output_refs.filter(r=>r.path.endsWith('/manifest.json')).map(r=>store.load(r)));
    const preparedReview=preparedArtifacts.findLast(a=>a.kind==='design-review');assert.ok(preparedReview);
    const catalog=await workflow.catalog(),asset=catalog.assets.find(a=>a.runtime_ready&&a.asset_ref.sha256===preparedReview.data.subject_ref.sha256);
    assert.ok(asset,'the selected workflow asset requires independent approval and actual positive/negative diagnostics');
    await new DesignReviewService(root,authority).gate(asset.asset_ref,asset.review_refs[0]);
    summary.asset_ref=asset.asset_ref;assert.equal((await store.reindex()).records.some(r=>r.kind==='run'),false);
    const assetBytes=await readFile(join(root,asset.asset_ref.path));
    const executePrompt=id=>`Read live-inputs.json. Using catalog, execute the existing approved runtime-ready asset in workflow task ${id}. Complete formal execution, canonical statistics, your evidence-grounded analysis, independent result review and final workflow delivery. Use a new batch and retain actual failures. Do not record, generate, change tests or expectations, or repeat finished tasks. Report unknown internal causes as unknown.`;
    const first=await phase('healthy',executePrompt('live-healthy'));summary.healthy=await checkExecution('live-healthy',false);
    const restart=await phase('restart',executePrompt('live-restart'));summary.restart=await checkExecution('live-restart',false);
    assert.notEqual(first.session_id,restart.session_id);assert.notEqual(summary.healthy.run_ref.path,summary.restart.run_ref.path);
    for(const output of [first,restart]){
      assert.ok(output.calls.every(name=>!['ui_discover_record','ui_case_design','ui_design_review','ui_design_diagnose'].includes(name)));
      for(const name of ['ui_test_workflow','ui_test_run','ui_result_analysis','ui_result_review'])assert.ok(output.calls.includes(name),`production execution missing ${name}`);
    }
    fixture.state.discardPersistence=true;
    const failed=await phase('failure',executePrompt('live-failure'));summary.failure=await checkExecution('live-failure',true);
    for(const name of ['ui_test_workflow','ui_test_run','ui_result_analysis','ui_result_review'])assert.ok(failed.calls.includes(name));
    assert.ok(failed.calls.every(name=>!['ui_discover_record','ui_case_design','ui_design_review','ui_design_diagnose'].includes(name)));
    assert.equal(sha256(await readFile(join(root,asset.asset_ref.path))),sha256(assetBytes));
    assert.equal(fixture.state.requests,0,'external model workflow must never be served by the protocol fixture');
    summary.passed=true;summary.limitations=['Fresh child process restart is covered here; actual desktop restart is separately required.',
      'Controlled target is not evidence of coverage for any real business deployment.','Full M3 also requires repeated calibration and the remaining acceptance matrix.'];
  }catch(error){summary.error=error.message;throw error;}
  finally{
    await writeFile(join(evidence,'summary.json'),JSON.stringify(summary,null,2));
    await cp(join(root,'qa/ui'),join(evidence,'qa/ui'),{recursive:true});
    await cp(join(root,'requirements.md'),join(evidence,'requirements.md'));await cp(join(root,'live-inputs.json'),join(evidence,'live-inputs.json'));
    t.diagnostic(`UI-10 full external-model evidence: ${evidence}`);
  }
});
