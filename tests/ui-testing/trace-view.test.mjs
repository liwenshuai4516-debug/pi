import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { ready } from '../support/ui-run-fixture.mjs';
import { repoRoot } from '../support/ui-fixture.mjs';
import { until } from '../support/fixture.mjs';
import { sha256 } from '../../packages/ui-testing/dist/index.js';

test('UI-10 A09: native trace viewer opens historical failure without reaching the business server or changing its run', {timeout:60000},async t=>{
  const {f,service,request}=await ready(t,{targetFault:true}),execution=await service.start(request);
  assert.equal(execution.run.data.exit_code,1);
  const trace=execution.run.data.output_refs.find(r=>r.path.endsWith('/trace.zip'));assert.ok(trace);
  const tracePath=join(f.root,trace.path),original=await readFile(tracePath),before=f.fixture.state.browserRequests;
  const evidence=join(repoRoot,'evidence/ui-testing/ui-10/trace-view',String(Date.now()));await mkdir(evidence,{recursive:true});
  let output='',browser,page,viewer,unexpected=[];
  const record={run_ref:execution.run_ref,trace_ref:trace,business_requests_before:before};
  try{
    // 复用公开 show-trace CLI；上游测试开关仅禁止弹出系统默认浏览器，不替换 viewer。
    viewer=spawn(process.execPath,[join(repoRoot,'node_modules/playwright/cli.js'),'show-trace',tracePath,'--host','127.0.0.1','--port','0'],
      {cwd:f.root,env:{...process.env,PWTEST_UNDER_TEST:'1'},stdio:['ignore','pipe','pipe']});
    viewer.stdout.on('data',chunk=>{output+=chunk;});viewer.stderr.on('data',chunk=>{output+=chunk;});
    let spawnError;viewer.on('error',error=>{spawnError=error;});
    await until(()=>{if(spawnError)throw spawnError;return /Listening on (http:\/\/[^\s]+)/.test(output);},10000);
    const url=output.match(/Listening on (http:\/\/[^\s]+)/)[1];record.viewer_url=url;
    browser=await chromium.launch({headless:true});const context=await browser.newContext();
    // 历史快照只可访问本地 viewer；发现任何业务网络请求即阻断并使验收失败。
    await context.route('**/*',route=>{
      const target=route.request().url();
      if(target.startsWith(url)||target.startsWith('data:')||target.startsWith('blob:'))return route.continue();
      unexpected.push(target);return route.abort();
    });
    page=await context.newPage();await page.goto(url);
    const failed=page.getByText('toHaveText',{exact:false}).first();await failed.waitFor({timeout:15000});await failed.click();
    const body=await page.locator('body').innerText();assert.match(body,/toHaveText/);assert.match(body,/Name|listitem/);
    record.visible_text=body;record.blocked_requests=unexpected;
    assert.deepEqual(unexpected,[],'native snapshots must not issue new business or external requests');
    assert.equal(f.fixture.state.browserRequests,before);
    assert.equal(sha256(await readFile(tracePath)),sha256(original));
    assert.deepEqual((await service.status(request.task_id,request.request_id)).run_ref,execution.run_ref);
    record.passed=true;
  }catch(error){record.failure=error.message;throw error;}
  finally{
    if(page)await page.screenshot({path:join(evidence,'native-trace-viewer.png'),fullPage:true}).catch(()=>{});
    if(browser)await browser.close();
    if(viewer&&viewer.exitCode===null&&viewer.signalCode===null){const exited=once(viewer,'exit');viewer.kill('SIGTERM');await exited;}
    record.viewer_exit_code=viewer?.exitCode;record.viewer_exit_signal=viewer?.signalCode;
    record.business_requests_after=f.fixture.state.browserRequests;
    await writeFile(join(evidence,'result.json'),JSON.stringify(record,null,2));await writeFile(join(evidence,'viewer-output.txt'),output);
    await cp(join(f.root,'qa/ui'),join(evidence,'qa/ui'),{recursive:true});await cp(join(f.root,'requirements.md'),join(evidence,'requirements.md'));
    t.diagnostic(`Native trace viewer evidence: ${evidence}`);
  }
});
