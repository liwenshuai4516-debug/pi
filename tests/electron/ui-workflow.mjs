import assert from 'node:assert/strict';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { DesignReviewService, RuntimeAdmissionService } from '../../packages/ui-testing/dist/index.js';
import { prepareDiagnostic, response } from '../support/ui-design-fixture.mjs';
import { PluginManager } from '../../dist/main/plugins/manager.js';
import { repoRoot, textContent } from '../support/ui-fixture.mjs';
import { until } from '../support/fixture.mjs';

const cleanup=[],evidence=join(repoRoot,'evidence/ui-testing/ui-09',String(Date.now()));
await mkdir(evidence,{recursive:true});
const report={scope:'Actual Electron exit/relaunch and fresh UI IPC session; controlled protocol with real native runner',checks:[],runs:[],processes:[]};
let app,projectRoot;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function descendants(pid){
  const {stdout}=await promisify(execFile)('ps',['-axo','pid=,ppid=']);
  const rows=stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
  const ids=new Set([pid]);let changed=true;
  while(changed){changed=false;for(const [child,parent] of rows)if(ids.has(parent)&&!ids.has(child)){ids.add(child);changed=true;}}
  return [...ids];
}
async function close(){
  const child=app.process(),ids=await descendants(child.pid);await app.close();app=undefined;
  await until(()=>ids.every(pid=>!alive(pid)),20000);
  report.processes.push({pid:child.pid,descendants:ids,exit_code:child.exitCode,all_exited:true});
}
try{
  const d=await prepareDiagnostic({after:fn=>cleanup.push(fn)}),{f,assetRef,specRef,spec,config}=d;
  projectRoot=f.root;
  const authority=join(f.fixture.agentDir,'sessions/ui-review-authority');
  const review=await new DesignReviewService(f.root,authority).assess(f.taskRef,assetRef,'desktop-design',response);
  const diagnostic=await new RuntimeAdmissionService(f.root,authority).diagnose(assetRef,review.review_ref,specRef,'desktop-ready');
  assert.equal(diagnostic.runtime_ready,true);
  await new PluginManager(f.fixture.agentDir,f.root).install(join(repoRoot,'dist/packages/ui-testing'),'package');
  let phase=1,count=0,runRef,taskRef,calls=[];
  const call=(tool,args)=>{calls.push(tool);return {tool,args};};
  f.fixture.state.respond=body=>{
    if(count++===0)return call('ui_test_workflow',{request:{operation:'catalog'}});
    if(count===4){
      assert.match(textContent(body.messages.filter(m=>m.role==='tool').at(-1)?.content),/ui-test-run/);
      return call('ui_test_run',{request:{operation:'start',input:{task_id:`desktop-${phase}`,request_id:'formal',asset_ref:assetRef,
        review_ref:review.review_ref,environment_ref:spec.environment_ref,config_ref:config,timeout_ms:15000}}});
    }
    const last=JSON.parse(textContent(body.messages.filter(m=>m.role==='tool').at(-1)?.content));
    assert.equal(last.status,'completed',JSON.stringify(last));
    if(count===2){assert.ok(last.output.assets.some(a=>a.runtime_ready&&a.asset_ref.path===assetRef.path));
      return call('ui_test_workflow',{request:{operation:'start',input:{task_id:`desktop-${phase}`,mode:'execute',asset_ref:assetRef}}});}
    if(count===3){taskRef=last.output.task_ref;return call('read',{path:last.output.directory[0].path});}
    if(count===5){runRef=last.output.run_ref;assert.equal(last.output.run.data.exit_code,0);assert.equal(last.output.replayed,false);
      return call('ui_test_workflow',{request:{operation:'status',task_id:`desktop-${phase}`}});}
    if(count===6){taskRef=last.output.task_ref;return call('ui_test_workflow',{request:{operation:'checkpoint',task_ref:taskRef,stage:'execute',output_refs:[runRef]}});}
    assert.equal(last.output.next_stage,'analyze');return {text:'A new native run is saved; report analysis remains pending.'};
  };
  const sessions=[];
  for(phase=1;phase<=2;phase++){
    count=0;calls=[];
    app=await electron.launch({args:['.'],cwd:repoRoot,env:{...process.env,PI_CODING_AGENT_DIR:f.fixture.agentDir,
      PI_AGENT_TEST_USER_DATA:join(f.fixture.root,'desktop-workflow')},timeout:60000});
    const page=await app.firstWindow();await page.locator('#global-status').filter({hasText:'本地工作空间'}).waitFor({timeout:30000});
    assert.ok(page.url().startsWith('file://'));
    await app.evaluate(({dialog},root)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]});
      dialog.showMessageBox=async()=>({response:1});
    },f.root);
    const selected=await page.evaluate(()=>window.agentClient.selectProject());assert.equal(selected,f.root);
    const view=await page.evaluate(root=>window.agentClient.createSession(root),f.root);sessions.push(view.id);
    assert.ok(view.skills.some(s=>s.name==='ui-test-workflow'));
    const before=f.fixture.state.browserRequests;
    await page.evaluate(({id,phase})=>window.agentClient.send(id,`/skill:ui-test-workflow DESKTOP_PHASE_${phase} Execute an existing approved asset in a fresh batch.`,[],[]),{id:view.id,phase});
    if(f.fixture.state.responseError)throw f.fixture.state.responseError;
    assert.ok(f.fixture.state.browserRequests>before);
    assert.deepEqual(calls,['ui_test_workflow','ui_test_workflow','read','ui_test_run','ui_test_workflow','ui_test_workflow']);
    report.runs.push({phase,run_ref:runRef,session_id:view.id,calls:[...calls],browser_requests_before:before,browser_requests_after:f.fixture.state.browserRequests});
    await close();report.checks.push(`desktop phase ${phase}: new session and run without recording/redesign; all client descendants exited`);
  }
  assert.notEqual(sessions[0],sessions[1]);assert.notDeepEqual(report.runs[0].run_ref,report.runs[1].run_ref);
  const second=f.fixture.state.payloads.filter(body=>JSON.stringify(body.messages).includes('DESKTOP_PHASE_2'));
  assert.ok(second.length);assert.ok(second.every(body=>!JSON.stringify(body.messages).includes('DESKTOP_PHASE_1')));
  report.checks.push('persisted built package, asset and trusted approval reused after full Electron restart; no old chat history');
}catch(error){report.failure=error.stack;console.error(error);process.exitCode=1;}
finally{
  if(app)await app.close().catch(()=>{});
  if(projectRoot)try{
    await cp(join(projectRoot,'qa/ui'),join(evidence,'qa/ui'),{recursive:true});
    await cp(join(projectRoot,'requirements.md'),join(evidence,'requirements.md'));
  }catch(error){report.evidence_failure=error.message;process.exitCode=1;}
  for(const fn of cleanup.reverse())await fn();
  await writeFile(join(evidence,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({evidence,passed:!report.failure&&!report.evidence_failure,checks:report.checks}));
}
