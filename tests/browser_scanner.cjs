/* Real unpacked-extension tests. See tests/browser/README.md. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || process.argv[2] || './browser/node_modules/playwright-core');
const root = path.resolve(__dirname, '..');
const python = process.env.PYTHON || path.join(root, '.venv/bin/python');
const executable = process.env.BROWSER_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const apiPort = Number(process.env.TEST_API_PORT || 5002);
const demoPort = Number(process.env.TEST_DEMO_PORT || 8766);
const api = `http://127.0.0.1:${apiPort}`;
const demo = `http://127.0.0.1:${demoPort}/demo.html`;
const artifacts = path.join(__dirname, 'browser/artifacts');
fs.mkdirSync(artifacts, {recursive: true});
const report = {date: new Date().toISOString(), steps: [], limitations: [
  'Headless Brave, isolated temporary profile; no existing browser profile was accessed.',
  'Temporary extension copy changes API port and grants only the demo origin for programmatic popup access (normal toolbar clicks grant activeTab).',
  'Temporary instrumentation counts full discovery and delays real API responses; model outputs are not mocked.',
  'Closed Shadow DOM is inspected through Chrome DevTools Protocol.'
]};
const processes = [];
let apiProcess, context, cdp, worker, page, popup, tabId;
let log = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, message, timeout = 10000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try {const result = await check(); if (result) return result;} catch (e) {error = e;}
    await sleep(40);
  }
  throw new Error(`${message}${error ? ': ' + error.message : ''}`);
}
function server(args) {
  const child = spawn(python, args, {cwd: root, env: {...process.env, PYTHONUNBUFFERED: '1'}});
  child.stdout.on('data', data => {log += data;});
  child.stderr.on('data', data => {log += data;});
  processes.push(child);
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {child.once('exit', resolve); child.kill('SIGTERM');});
}
async function startAPI() {
  apiProcess = server(['-m', 'flask', '--app', 'backend.app', 'run', '--host', '127.0.0.1', '--port', String(apiPort)]);
  await waitFor(async () => (await fetch(api + '/health')).ok, 'API did not start');
  assert.equal(apiProcess.exitCode, null, 'Test API must own its port');
}
async function status() {
  return worker.evaluate(id => chrome.tabs.sendMessage(id, {type: 'scanner-status'}), tabId);
}
async function complete() {
  return waitFor(async () => {const s = await status(); return s.phase === 'complete' && s;}, 'Scanner did not complete');
}
async function requests() {return worker.evaluate(() => self.__requests);}
async function fullScans() {
  return worker.evaluate(async id => (await chrome.scripting.executeScript({target: {tabId: id},
    func: () => window.__testFullScans || 0}))[0].result, tabId);
}
async function warnings() {
  return page.locator('[data-cybershield-warning]').evaluateAll(nodes => nodes.map(n => n.previousElementSibling.id));
}
async function expectWarnings(ids) {
  await waitFor(async () => JSON.stringify((await warnings()).sort()) === JSON.stringify([...ids].sort()), `Expected warnings ${ids}`);
}
// Attach to the actual toolbar popup, which Playwright does not expose as a page.
async function openPopup() {
  const existing = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url.endsWith('/popup.html'));
  if (!existing) await worker.evaluate(() => chrome.action.openPopup());
  const target = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url.endsWith('/popup.html')), 'No toolbar popup');
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
  let serial = 0;
  const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const data = JSON.parse(event.message);
    const item = pending.get(data.id);
    if (item) {pending.delete(data.id); data.error ? item.reject(new Error(data.error.message)) : item.resolve(data.result);}
  });
  async function send(method, params = {}) {
    const id = ++serial;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      setTimeout(() => {if (pending.has(id)) {pending.delete(id); reject(new Error('Popup CDP timeout'));}}, 5000).unref();
    });
    await cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})});
    return promise;
  }
  popup = {
    send,
    async eval(expression) {
      const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
  };
  await waitFor(() => popup.eval("!document.getElementById('enabled').disabled"), 'Popup did not initialize');
}
async function popupPhase(phase) {
  return waitFor(async () => {
    const s = await popup.eval("({phase:document.getElementById('status').dataset.phase,text:document.getElementById('status').textContent})");
    return s.phase === phase && s;
  }, `Popup never showed ${phase}`);
}
async function setSensitivity(level) {
  await popup.eval(`(() => {const select=document.getElementById('sensitivity'); select.value=${JSON.stringify(level)}; select.dispatchEvent(new Event('change'));})()`);
  await waitFor(async () => (await worker.evaluate(() => chrome.storage.local.get('sensitivity'))).sensitivity === level, 'Sensitivity not saved');
  await complete();
  await popupPhase('complete');
}
async function toggleProtection(enabled) {
  await popup.eval(`(() => {const input=document.getElementById('enabled'); if (input.checked !== ${enabled}) input.click();})()`);
  await popupPhase(enabled ? 'complete' : 'disabled');
}
async function shadowInfo(id, clickWhy = false) {
  const tree = (await cdp.send('DOM.getDocument', {depth: -1, pierce: true})).root;
  let host;
  function visit(node) {
    const attrs = node.attributes || [];
    const map = Object.fromEntries(Array.from({length: attrs.length / 2}, (_, i) => [attrs[i * 2], attrs[i * 2 + 1]]));
    if (map['data-cybershield-warning']) {
      const parent = (node.__siblings || []).filter(n => n.nodeType === 1);
      const index = parent.indexOf(node);
      const previous = parent[index - 1];
      if (previous) {
        const a = previous.attributes || [];
        if (a[a.indexOf('id') + 1] === id) host = node;
      }
    }
    for (const child of node.children || []) {child.__siblings = node.children; visit(child);}
  }
  visit(tree);
  assert.ok(host?.shadowRoots?.length, `Closed shadow root missing for ${id}`);
  assert.equal(host.shadowRoots[0].shadowRootType, 'closed');
  const object = (await cdp.send('DOM.resolveNode', {backendNodeId: host.shadowRoots[0].backendNodeId})).object;
  const result = await cdp.send('Runtime.callFunctionOn', {objectId: object.objectId, returnByValue: true,
    functionDeclaration: `function() {
      if (${clickWhy}) this.querySelector('button').click();
      const warning=this.querySelector('.warning'),details=this.querySelector('.details');
      return {title:warning.firstElementChild.textContent, details:details.textContent,
        hidden:details.hidden, display:getComputedStyle(details).display,
        color:getComputedStyle(warning).color, fontSize:getComputedStyle(warning).fontSize};
    }`});
  await cdp.send('Runtime.releaseObject', {objectId: object.objectId});
  return result.result.value;
}
async function step(name, test) {
  await test(); report.steps.push({name, result: 'passed'}); console.log('PASS', name);
}
async function runRecordChecks() {
  const site=new URL(demo).origin;
  async function op(action,kind,extra={}) {
    const response=await worker.evaluate(message=>CyberShieldRecords.dispatch(message),{action,kind,site,...extra});
    return response;
  }
  async function view(kind,all=false) {
    await popup.eval(`(() => { document.querySelector('[data-view="${kind}"]').click(); const select=document.getElementById('scope');select.value=${JSON.stringify(all?'all':'site')};select.dispatchEvent(new Event('change')); })()`);
    await waitFor(()=>popup.eval(`document.querySelector('[data-view="${kind}"]').getAttribute('aria-pressed') === 'true' && document.getElementById('counts').textContent.startsWith('${kind[0].toUpperCase()+kind.slice(1)}:') && document.getElementById('clear').textContent === 'Clear ${kind} (${all?'all sites':'this site'})'`),'Record view did not load');
  }
  let base, second, secondId;
  await step('Detection records deduplicate across rescans and retain full prediction snapshots',async()=>{
    let rows=(await op('list','detections')).records;
    assert.ok(rows.length>=3); base=rows.find(r=>r.prediction.toxic);
    assert.ok(base?.prediction.sensitivity);assert.equal(typeof base.prediction.margin,'number');
    const before=rows.length;
    await popup.eval("document.getElementById('scan').click()");await complete();
    await waitFor(async()=> (await op('list','detections')).records.length === before,'Rescan created duplicate records');
    assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);
  });
  await step('Two tabs save concurrent unique reports without loss and repeated saves produce one record',async()=>{
    second=await context.newPage();await second.goto(demo+'#second-tab');
    secondId=await worker.evaluate(async()=> (await chrome.tabs.query({active:true,currentWindow:true}))[0].id);
    // Opening a new tab closes the real toolbar popup; reopen on the original tab.
    await page.bringToFront();await openPopup();
    const before=(await op('list','reports')).records.length;
    const batches=[0,1].map(tab=>Array.from({length:25},(_,i)=>({...base,text:`Concurrent storage fixture ${tab}-${i}`})));
    const responses=await Promise.all([tabId,secondId].map((id,index)=>worker.evaluate(async({id,records})=>
      (await chrome.scripting.executeScript({target:{tabId:id},func:async(records)=>Promise.all(records.map(record=>chrome.runtime.sendMessage({type:'records',action:'add',kind:'reports',record}))),args:[records]}))[0].result,
      {id,records:batches[index]})));
    assert.equal(responses.flat().filter(r=>r.created).length,50);
    assert.equal((await op('list','reports')).records.length,before+50);
    const duplicates=await Promise.all([tabId,secondId].map(id=>worker.evaluate(async({id,record})=>
      (await chrome.scripting.executeScript({target:{tabId:id},func:async(record)=>Promise.all(Array.from({length:10},()=>chrome.runtime.sendMessage({type:'records',action:'add',kind:'reports',record}))),args:[record]}))[0].result,
      {id,record:base})));
    assert.equal(duplicates.flat().filter(r=>r.created).length,1);
    assert.equal(new Set(duplicates.flat().map(r=>r.record.id)).size,1);
    report.concurrentSaves={uniqueSaved:50,duplicateAttempts:20,duplicateRecordsCreated:1};
  });
  let feedback;
  await step('Popup report and incorrect actions deduplicate; incorrect feedback has no inferred replacement label',async()=>{
    await view('detections');
    await waitFor(()=>popup.eval(`!!document.querySelector('[data-record-id="${base.id}"]')`),'Detection missing');
    await popup.eval(`document.querySelector('[data-record-id="${base.id}"] button').click()`);
    await waitFor(()=>popup.eval("document.getElementById('record-status').textContent.includes('website has not been notified')"),'Report disclaimer missing');
    const addFeedback=`[...document.querySelector('[data-record-id="${base.id}"]').querySelectorAll('button')].find(b=>b.textContent==='Mark prediction incorrect').click()`;
    await popup.eval(addFeedback);await popup.eval(addFeedback);
    feedback=(await waitFor(async()=> (await op('list','feedback')).records.find(r=>r.id===base.id),'Feedback missing'));
    assert.equal(feedback.review.status,'unreviewed');assert.equal(feedback.review.toxicityLabel,null);assert.equal(feedback.review.profanityLabel,null);
    assert.equal(feedback.prediction.toxic,base.prediction.toxic);
    assert.equal((await op('list','feedback')).records.filter(r=>r.id===base.id).length,1);
  });
  await step('Human review keeps independent uncertain labels and preserves drafts during other-tab saves',async()=>{
    await view('feedback');
    await waitFor(()=>popup.eval(`!!document.querySelector('[data-record-id="${base.id}"] textarea')`),'Review form missing');
    await popup.eval(`(() => {const row=document.querySelector('[data-record-id="${base.id}"]'); const notes=row.querySelector('textarea');notes.value='Human review: context is missing';notes.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await op('add','reports',{record:{...base,text:'Unrelated save while review is being typed'}});
    await sleep(150);
    assert.equal(await popup.eval(`document.querySelector('[data-record-id="${base.id}"] textarea').value`),'Human review: context is missing');
    await popup.eval(`(() => {const row=document.querySelector('[data-record-id="${base.id}"]');const a=row.querySelector('[data-label="toxicity"]');a.value='uncertain';a.dispatchEvent(new Event('change',{bubbles:true}));const b=row.querySelector('[data-label="profanity"]');b.value='absent';b.dispatchEvent(new Event('change',{bubbles:true}));const checked=row.querySelector('input[type=checkbox]');checked.checked=true;checked.dispatchEvent(new Event('change',{bubbles:true}));row.querySelector('form').requestSubmit();})()`);
    const reviewed=await waitFor(async()=>{const r=(await op('list','feedback')).records.find(r=>r.id===base.id);return r?.review.status==='reviewed'&&r;},'Review not saved');
    assert.equal(reviewed.review.toxicityLabel,'uncertain');assert.equal(reviewed.review.profanityLabel,'absent');
    assert.equal(reviewed.prediction.toxic,true);
    await op('add','feedback',{record:base});
    assert.equal((await op('list','feedback')).records.find(r=>r.id===base.id).review.toxicityLabel,'uncertain');
    await op('add','feedback',{record:{...base,text:'Second unreviewed fixture'}});
    const invalid=await worker.evaluate(async({id})=>{
      try{await CyberShieldRecords.dispatch({action:'review',kind:'feedback',id,review:{reviewed:true,toxicityLabel:'opposite',profanityLabel:null,notes:''}});return false;}catch{return true;}
    },{id:base.id});assert.equal(invalid,true);
  });
  await step('Separate views export actual local JSON downloads; reviewed export excludes unreviewed feedback',async()=>{
    const downloads=fs.mkdtempSync(path.join(os.tmpdir(),'cybershield-downloads-'));
    await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
    for(const kind of ['detections','reports','feedback']) {
      await view(kind);
      assert.ok(await popup.eval('document.querySelectorAll("#items .item").length')>0);
      await popup.eval("document.getElementById('export').click()");
      const filename=`cybershield-${kind}-${new Date().toISOString().slice(0,10)}.json`;
      const exported=await waitFor(()=>{try{return JSON.parse(fs.readFileSync(path.join(downloads,filename),'utf8'));}catch{return false;}},'Local export download missing');
      assert.equal(exported.kind,kind);assert.equal(exported.site,site);assert.ok(exported.records.length>0);assert.equal(exported.reviewedOnly,false);
      fs.writeFileSync(path.join(artifacts,`${kind}-export.json`),JSON.stringify(exported,null,2));
    }
    await popup.eval("document.getElementById('export-reviewed').click()");
    const filename=`cybershield-feedback-reviewed-${new Date().toISOString().slice(0,10)}.json`;
    const reviewed=await waitFor(()=>{try{return JSON.parse(fs.readFileSync(path.join(downloads,filename),'utf8'));}catch{return false;}},'Reviewed export download missing');
    assert.equal(reviewed.reviewedOnly,true);assert.equal(reviewed.records.length,1);
    assert.equal(reviewed.records[0].review.toxicityLabel,'uncertain');
    assert.equal(reviewed.records[0].prediction.toxic,true);
    fs.writeFileSync(path.join(artifacts,'reviewed-feedback-export.json'),JSON.stringify(reviewed,null,2));
    const shot=await popup.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'popup-feedback.png'),Buffer.from(shot.data,'base64'));
  });
  await step('Retention evicts oldest records above 200 per view without changing feedback or detections',async()=>{
    const beforeFeedback=(await op('list','feedback')).records.length;
    const beforeDetections=(await op('list','detections')).records.length;
    const created=await worker.evaluate(async({record})=>(await Promise.all(Array.from({length:215},(_,i)=>CyberShieldRecords.dispatch({action:'add',kind:'reports',record:{...record,text:`Retention fixture ${i}`}})))).map(r=>({id:r.record.id,sequence:r.record.sequence})),{record:base});
    const kept=(await op('list','reports')).records;
    assert.equal(kept.length,200);
    assert.deepEqual(kept.map(r=>r.id),created.sort((a,b)=>b.sequence-a.sequence).slice(0,200).map(r=>r.id));
    assert.equal((await op('list','feedback')).records.length,beforeFeedback);
    assert.equal((await op('list','detections')).records.length,beforeDetections);
  });
  await step('Scope-aware clear affects only the selected view and site; all-site clear is separate',async()=>{
    await op('add','reports',{record:{...base,site:'https://other.example',text:'Other-site local report'}});
    const feedbackCount=(await op('list','feedback')).records.length;
    const detectionsCount=(await op('list','detections')).records.length;
    await view('reports');await popup.eval("document.getElementById('clear').click()");
    await waitFor(async()=> (await op('list','reports')).records.length===0,'Site reports not cleared');
    assert.equal((await op('list','reports',{site:null})).records.length,1);
    assert.equal((await op('list','feedback')).records.length,feedbackCount);
    assert.equal((await op('list','detections')).records.length,detectionsCount);
    await view('reports',true);assert.ok(await popup.eval("document.getElementById('items').textContent.includes('Other-site local report')"));
    await popup.eval("document.getElementById('clear').click()");
    await waitFor(async()=> (await op('list','reports',{site:null})).records.length===0,'Global reports not cleared');
    await view('feedback');await popup.eval("document.getElementById('clear').click()");
    await waitFor(async()=> (await op('list','feedback')).records.length===0,'Feedback not cleared');
    assert.equal((await op('list','detections')).records.length,detectionsCount);
    await view('detections');await popup.eval("document.getElementById('clear').click()");
    await waitFor(async()=> (await op('list','detections')).records.length===0,'Detections not cleared');
  });
  await step('Records demo contains protected labels, safe comments, abuse and separate profanity-only warnings',async()=>{
    await second.goto(`http://127.0.0.1:${demoPort}/records-demo.html`);
    await waitFor(async()=> (await worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'scanner-status'}),secondId)).phase==='complete','Records demo did not finish');
    const snapshot=await second.locator('[data-cybershield-warning]').evaluateAll(nodes=>nodes.map(n=>n.previousElementSibling.textContent));
    assert.ok(snapshot.includes('You idiot'));assert.ok(snapshot.includes('shit'));
    assert.ok(!snapshot.includes('Alice'));assert.ok(!snapshot.includes('Settings'));
    await second.evaluate(()=>document.getElementById('duplicate').click());await sleep(200);
    const rows=(await op('list','detections')).records;
    assert.equal(rows.filter(r=>r.text==='You idiot').length,1);
    await second.close();await page.bringToFront();await openPopup();await view('detections');
  });
}


(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cybershield-scan-'));
  const extension = path.join(tmp, 'extension');
  fs.cpSync(path.join(root, 'extension'), extension, {recursive: true});
  const background = path.join(extension, 'background.js');
  fs.writeFileSync(background, fs.readFileSync(background, 'utf8').replace('http://127.0.0.1:5000', api));
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
  manifest.host_permissions = [api + '/*', `http://127.0.0.1:${demoPort}/*`];
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const content = path.join(extension, 'content.js');
  fs.writeFileSync(content, fs.readFileSync(content, 'utf8').replace('function collect(root) {',
    'function collect(root) { if (root === document.documentElement) window.__testFullScans = (window.__testFullScans || 0) + 1;'));
  try {
    await startAPI();
    server(['-m', 'http.server', String(demoPort), '--bind', '127.0.0.1']);
    await waitFor(async () => (await fetch(demo)).ok, 'Demo did not start');
    context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
      executablePath: executable, headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run']
    });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    report.browser = await worker.evaluate(() => navigator.userAgent);
    await worker.evaluate(() => {
      self.__requests = []; self.__delay = 0;
      const original = self.fetch.bind(self);
      self.fetch = async (...args) => {
        const record = {...JSON.parse(args[1].body), delay: self.__delay};
        self.__requests.push(record);
        const response = await original(...args);
        if (record.delay) await new Promise(resolve => setTimeout(resolve, record.delay));
        return response;
      };
    });
    await step('Legacy arrays migrate once, deduplicate, and preserve unreviewed feedback without guessing labels', async () => {
      const migrated = await worker.evaluate(async () => {
        const sample={id:'old-1',site:'https://legacy.example',text:'Legacy saved snippet',reason:'Profanity term detected',profanity:['shit'],time:'old local timestamp'};
        await chrome.storage.local.set({history:[sample,{...sample,id:'old-2'}],reports:[sample],feedback:[{...sample,correct:false}]});
        const result={};
        for(const kind of ['detections','reports','feedback']) result[kind]=(await CyberShieldRecords.dispatch({action:'list',kind,site:null})).records;
        result.old=await chrome.storage.local.get(['history','reports','feedback']);
        for(const kind of ['detections','reports','feedback']) await CyberShieldRecords.dispatch({action:'clear',kind,site:null});
        result.after=(await CyberShieldRecords.dispatch({action:'list',kind:'detections',site:null})).records;
        return result;
      });
      for(const kind of ['detections','reports','feedback']) assert.equal(migrated[kind].length,1);
      assert.equal(migrated.feedback[0].review.status,'unreviewed');
      assert.equal(migrated.feedback[0].review.toxicityLabel,null);
      assert.equal(migrated.feedback[0].prediction.toxic,null);
      assert.deepEqual(migrated.old,{}); assert.equal(migrated.after.length,0);
    });
    page = await context.newPage();
    page.on('pageerror', error => {report.pageErrors ||= []; report.pageErrors.push(String(error));});
    await page.goto(demo);
    tabId = await worker.evaluate(async () => (await chrome.tabs.query({active: true, currentWindow: true}))[0].id);
    cdp = await context.newCDPSession(page);
    await complete();
    await step('Initial visible blocks, exclusions, nested blocks and matching warning explanations', async () => {
      const sent = (await requests()).flatMap(r => r.texts);
      assert.equal(sent.length, 7);
      assert.ok(!sent.some(t => /navigation|form|editor|extension UI/.test(t)));
      assert.ok(sent.includes('Thank you for your help.'));
      assert.equal(sent.filter(t => t === 'You idiot').length, 1);
      await expectWarnings(['styled', 'profanity', 'nested-comment']);
      const info = await shadowInfo('profanity');
      assert.match(info.title, /Profanity term detected/);
      assert.doesNotMatch(info.title, /Potential abusive|No flag/);
      assert.match(info.details, /No ML toxicity flag/);
      assert.equal(await page.locator('#styled').evaluate(el => el.nextElementSibling.shadowRoot), null);
    });
    await step('Closed Shadow DOM isolates hostile page CSS and toggles Why details', async () => {
      let info = await shadowInfo('styled');
      assert.equal(info.color, 'rgb(37, 48, 64)'); assert.equal(info.fontSize, '13px');
      assert.equal(info.hidden, true); assert.equal(info.display, 'none');
      info = await shadowInfo('styled', true);
      assert.equal(info.hidden, false); assert.notEqual(info.display, 'none');
      assert.match(info.details, /Potential abuse/); assert.doesNotMatch(info.details, /No flag/);
    });
    await page.screenshot({path:path.join(artifacts,'scanner-initial.png'),fullPage:true});
    await openPopup();
    await step('Actual toolbar popup shows completed scan with current warnings', async () => {
      const s = await popupPhase('complete'); assert.match(s.text, /3 warnings/);
    });
    await step('New comments scan incrementally without resubmitting unchanged text or duplicate warnings', async () => {
      const before = (await requests()).length, full = await fullScans();
      await page.evaluate(() => document.getElementById('add').click());
      await waitFor(async () => (await requests()).length > before, 'New comment not requested');
      await complete();
      const added = (await requests()).slice(before);
      assert.equal(added.length, 1); assert.deepEqual(added[0].texts, ['You are a worthless idiot']);
      assert.equal(await page.locator('[data-dynamic] + [data-cybershield-warning]').count(), 1);
      assert.equal(await fullScans(), full);
      await page.evaluate(() => {const span=document.createElement('span'); span.textContent='Unrelated counter'; document.getElementById('controls').append(span);});
      await complete(); await sleep(150);
      assert.equal((await requests()).length, before + 1);
    });
    await step('Edited and removed comments lose stale warnings immediately', async () => {
      await page.evaluate(() => document.getElementById('edit').click());
      await waitFor(async () => await page.locator('[data-dynamic] + [data-cybershield-warning]').count() === 0, 'Edited warning remains');
      await complete();
      await page.evaluate(() => document.getElementById('remove').click()); await complete();
      assert.equal(await page.locator('[data-dynamic]').count(), 0);
      await page.evaluate(() => document.getElementById('add').click()); await sleep(150); await complete();
      await page.evaluate(() => document.getElementById('remove').click());
      await complete(); assert.equal(await page.locator('#comments > [data-cybershield-warning]').count(), 2);
    });
    await step('Character edits and hide/show changes invalidate only affected blocks', async () => {
      const full = await fullScans();
      await page.evaluate(() => document.getElementById('nested-comment').firstChild.nodeValue='Thank you for your help');
      await complete(); assert.ok(!(await warnings()).includes('nested-comment'));
      await page.evaluate(() => document.getElementById('hide').click());
      await waitFor(async () => (await warnings()).includes('hidden-comment'), 'Unhidden comment not scanned'); await complete();
      await page.evaluate(() => document.getElementById('hide').click()); await complete();
      assert.ok(!(await warnings()).includes('hidden-comment'));
      assert.equal(await fullScans(), full);
    });
    await step('Moving a warned block into a form removes its old warning and rescans when moved back', async () => {
      await page.evaluate(() => {
        const el=document.createElement('p'); el.id='moved'; el.textContent='You idiot';
        document.getElementById('comments').append(el);
      });
      await waitFor(async () => (await warnings()).includes('moved'), 'Moved test block not flagged');
      await page.evaluate(() => document.querySelector('form').append(document.getElementById('moved')));
      assert.ok(!(await warnings()).includes('moved'));
      await complete();
      await page.evaluate(() => document.getElementById('comments').append(document.getElementById('moved')));
      await waitFor(async () => (await warnings()).includes('moved'), 'Moved-back block not rescanned');
      await page.evaluate(() => document.getElementById('moved').remove()); await complete();
    });
    await step('Sensitivity changes reevaluate existing text with the actual API decision', async () => {
      const before = (await requests()).length;
      await setSensitivity('relaxed');
      assert.ok(!(await warnings()).includes('borderline'));
      await setSensitivity('strict');
      assert.ok((await warnings()).includes('borderline'));
      const sent = (await requests()).slice(before);
      assert.ok(sent.some(r => r.sensitivity === 'relaxed' && r.texts.includes('Have a wonderful day')));
      assert.ok(sent.some(r => r.sensitivity === 'strict' && r.texts.includes('Have a wonderful day')));
      const result = await fetch(api + '/predict', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({texts:['Have a wonderful day'],sensitivity:'strict'})}).then(r=>r.json());
      const info = await shadowInfo('borderline'); assert.ok(info.title.includes(result.results[0].reason));
    });
    await step('Popup shows loading, and disabling during a pending response prevents warnings returning', async () => {
      await worker.evaluate(() => {self.__delay=1000;});
      const before=(await requests()).length;
      await popup.eval("document.getElementById('scan').click()");
      await popupPhase('loading');
      const loadingShot=await popup.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(artifacts,'popup-loading.png'),Buffer.from(loadingShot.data,'base64'));
      await waitFor(async () => (await requests()).length > before, 'Delayed request never started');
      await toggleProtection(false);
      assert.equal((await warnings()).length, 0);
      await sleep(1200);
      assert.equal((await warnings()).length, 0); assert.equal((await status()).phase, 'disabled');
      await worker.evaluate(() => {self.__delay=0;});
      await toggleProtection(true); await complete();
      assert.ok((await warnings()).includes('styled'));
    });
    await step('Inline outline values and !important priorities restore; page changes survive cleanup', async () => {
      await toggleProtection(false);
      const computed = await page.locator('#styled').evaluate(el => ({outline:getComputedStyle(el).outline,offset:getComputedStyle(el).outlineOffset,inline:el.style.outline}));
      assert.match(computed.outline, /dashed/); assert.match(computed.outline, /1px/); assert.equal(computed.offset,'5px'); assert.equal(computed.inline,'');
      await page.evaluate(() => {const el=document.getElementById('styled');el.style.setProperty('outline','4px dotted blue','important');el.style.setProperty('outline-offset','9px','important');});
      await toggleProtection(true); await toggleProtection(false);
      let styles=await page.locator('#styled').evaluate(el=>[el.style.outline,el.style.getPropertyPriority('outline'),el.style.outlineOffset,el.style.getPropertyPriority('outline-offset')]);
      assert.deepEqual(styles,['blue dotted 4px','important','9px','important']);
      await toggleProtection(true);
      await page.evaluate(() => document.getElementById('styled').style.setProperty('outline','6px double green','important'));
      // Mutation cleanup must not restore the old blue outline over the page's green update.
      await toggleProtection(false);
      styles=await page.locator('#styled').evaluate(el=>el.style.outline);
      assert.equal(styles,'green double 6px');
      await toggleProtection(true);
    });
    await step('Edits, removals, and sensitivity changes reject stale in-flight results', async () => {
      await worker.evaluate(() => {self.__delay=800;});
      let before=(await requests()).length;
      await page.evaluate(() => document.getElementById('add').click());
      await waitFor(async () => (await requests()).length > before, 'No delayed add request');
      await page.evaluate(() => document.getElementById('edit').click());
      await complete();
      assert.equal(await page.locator('[data-dynamic] + [data-cybershield-warning]').count(),0);
      before=(await requests()).length;
      await page.evaluate(() => document.querySelector('[data-dynamic]').textContent='You idiot');
      await waitFor(async () => (await requests()).length > before, 'No delayed edit request');
      await page.evaluate(() => document.getElementById('remove').click());
      await complete(); assert.equal(await page.locator('[data-dynamic]').count(),0);
      before=(await requests()).length;
      await popup.eval("document.getElementById('scan').click()");
      await waitFor(async () => (await requests()).length > before, 'No delayed rescan');
      await setSensitivity('relaxed');
      await sleep(900);
      assert.ok(!(await warnings()).includes('borderline'));
      await worker.evaluate(() => {self.__delay=0;});
    });
    await step('No-detections completion and popup reopen show current state, not history totals', async () => {
      await page.evaluate(() => document.querySelectorAll('#comments p').forEach(el => {el.textContent='Thank you for your help';}));
      await complete(); const s=await popupPhase('complete');
      assert.match(s.text,/no detections/); assert.equal((await warnings()).length,0);
      const noDetectionsShot=await popup.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(artifacts,'popup-no-detections.png'),Buffer.from(noDetectionsShot.data,'base64'));
      await popup.eval('window.close()');
      await waitFor(async () => !(await cdp.send('Target.getTargets')).targetInfos.some(t => t.url.endsWith('/popup.html')), 'Popup did not close');
      await openPopup();
      assert.match((await popupPhase('complete')).text,/no detections/);
    });
    await step('Real API-offline state and retry recover without misleading completion', async () => {
      await stop(apiProcess);
      await popup.eval("document.getElementById('scan').click()");
      const s=await popupPhase('offline'); assert.match(s.text,/service unavailable/);
      const offlineShot=await popup.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(artifacts,'popup-offline.png'),Buffer.from(offlineShot.data,'base64'));
      assert.equal(await popup.eval("document.getElementById('scan').textContent"),'Retry scan');
      await startAPI();
      await popup.eval("document.getElementById('scan').click()");
      await complete(); assert.match((await popupPhase('complete')).text,/no detections/);
    });
    await runRecordChecks();
    // Produce reviewable browser artifacts using the real API and final code.
    await page.evaluate(() => document.getElementById('add').click()); await sleep(150); await complete();
    await page.screenshot({path:path.join(artifacts,'scanner-demo.png'),fullPage:true});
    await popupPhase('complete');
    const screenshot=await popup.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(artifacts,'popup-complete.png'),Buffer.from(screenshot.data,'base64'));
    report.finalStatus=await complete(); report.requestCount=(await requests()).length;
    assert.ok(!report.pageErrors?.length, 'Unexpected page errors');
    report.result='passed';
  } catch (error) {
    report.result='failed'; report.error=String(error.stack || error); console.error(error);
    process.exitCode=1;
    if(page) await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});
  } finally {
    if(context) await context.close();
    for(const child of processes) await stop(child);
    fs.writeFileSync(path.join(artifacts,'results.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(artifacts,'server.log'),log);
    console.log(`Results: ${path.join(artifacts,'results.json')}`);
  }
})().catch(error=>{console.error(error);process.exitCode=1});
