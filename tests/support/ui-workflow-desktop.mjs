import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { until } from './fixture.mjs';
import { repoRoot } from './ui-fixture.mjs';

/** 复用实际桌面/preload/IPC；第一次只查目录，完全退出后新会话执行同一资产。 */
export async function liveDesktopReuse(fixture, evidence, executePrompt) {
  const report={phases:[],processes:[]};let app;
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
  try {
    for(const phase of ['catalog','execute']) {
      const started=Date.now(),item={phase};report.phases.push(item);
      app=await electron.launch({args:['.'],cwd:repoRoot,env:{...process.env,
        PI_CODING_AGENT_DIR:fixture.agentDir,PI_AGENT_TEST_USER_DATA:join(fixture.root,'live-desktop')},timeout:60000});
      const page=await app.firstWindow();
      await page.locator('#global-status').filter({hasText:'本地工作空间'}).waitFor({timeout:30000});
      await app.evaluate(({dialog},root)=>{
        dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]});dialog.showMessageBox=async()=>({response:1});
      },fixture.project);
      assert.equal(await page.evaluate(()=>window.agentClient.selectProject()),fixture.project);
      const view=await page.evaluate(root=>window.agentClient.createSession(root),fixture.project);item.session_id=view.id;
      const prompt=phase==='catalog'?'Use ui_test_workflow catalog to find existing runtime-ready assets. Report their references, then stop. Do not execute or modify anything.':executePrompt;
      await writeFile(join(evidence,`desktop-${phase}-prompt.md`),prompt);
      // 超时只停止原会话，不重新发送可能含业务写入的任务。
      const timer=setTimeout(()=>{void page.evaluate(id=>window.agentClient.stop(id),view.id).catch(()=>{});},600000);
      try{await page.evaluate(({id,prompt})=>window.agentClient.send(id,`/skill:ui-test-workflow ${prompt}`,[],[]),{id:view.id,prompt});}
      finally{clearTimeout(timer);}
      const directory=join(fixture.agentDir,'sessions');
      const file=(await readdir(directory,{recursive:true})).find(name=>name.endsWith(`_${view.id}.jsonl`));assert.ok(file);
      const messages=(await readFile(join(directory,file),'utf8')).trim().split('\n').map(line=>JSON.parse(line).message).filter(Boolean);
      item.calls=messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(c=>c.type==='toolCall').map(c=>c.name));
      const final=messages.findLast(m=>m.role==='assistant');assert.equal(final?.stopReason,'stop');
      item.final=final.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
      assert.ok(item.calls.includes('ui_test_workflow'));
      assert.ok(item.calls.every(name=>!['ui_discover_record','ui_case_design','ui_design_review','ui_design_diagnose'].includes(name)));
      if(phase==='catalog')assert.ok(!item.calls.includes('ui_test_run'));
      else for(const name of ['ui_test_run','ui_result_analysis','ui_result_review'])assert.ok(item.calls.includes(name));
      const child=app.process(),{stdout}=await promisify(execFile)('ps',['-axo','pid=,ppid=']);
      const rows=stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)),ids=new Set([child.pid]);
      let changed=true;while(changed){changed=false;for(const [pid,parent] of rows)if(ids.has(parent)&&!ids.has(pid)){ids.add(pid);changed=true;}}
      await app.close();app=undefined;await until(()=>[...ids].every(pid=>!alive(pid)),20000);
      report.processes.push({pid:child.pid,descendants:[...ids],all_exited:true,exit_code:child.exitCode});
      item.elapsed_ms=Date.now()-started;
    }
    assert.notEqual(report.phases[0].session_id,report.phases[1].session_id);report.passed=true;return report;
  }catch(error){report.error=error.message;throw error;}
  finally{if(app)await app.close().catch(()=>{});await writeFile(join(evidence,'desktop-reuse.json'),JSON.stringify(report,null,2));}
}
