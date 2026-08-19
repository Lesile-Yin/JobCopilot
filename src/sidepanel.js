// ===== JobCopilot 侧边栏：所有流程在此编排（收集→筛选→审核→投递），绕开 Service Worker 生命周期问题 =====
const $ = (id) => document.getElementById(id);
const CFG_FIELDS = ['zhipuKey', 'resumeText', 'keyword', 'city', 'count', 'blockKeywords', 'minSalary'];

// ── 全局流程状态（侧边栏是持久页面，不会像 Service Worker 那样被杀）──
let flow = { aborted: false, paused: false, phase: 'idle', jobs: [], screened: [], processed: {} };
chrome.storage.local.get('processed').then(r => { if (r.processed) flow.processed = r.processed; });

// ── 工具 ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => sleep(a + Math.random() * (b - a));
const AI_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
let AI_KEY = ''; // 由用户在侧边栏「配置」中填写（智谱开放平台 API Key），不内置任何 Key

// ── 折叠 ──
document.querySelectorAll('.card-h[data-toggle]').forEach(h => {
  h.addEventListener('click', () => {
    const body = $(h.dataset.toggle);
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  });
});

// ── 载入配置 ──
chrome.storage.local.get(CFG_FIELDS, (d) => {
  CFG_FIELDS.forEach(f => { if (d[f] !== undefined && $(f)) $(f).value = d[f]; });
});

$('saveCfg').addEventListener('click', () => {
  const obj = {};
  CFG_FIELDS.forEach(f => { obj[f] = $(f).value.trim ? $(f).value.trim() : $(f).value; });
  chrome.storage.local.set(obj, () => { const s = $('saved'); s.style.display = 'inline'; setTimeout(() => s.style.display = 'none', 1500); });
});

function saveCfgSync() {
  return new Promise(res => {
    const obj = {};
    CFG_FIELDS.forEach(f => { obj[f] = $(f).value.trim ? $(f).value.trim() : $(f).value; });
    chrome.storage.local.set(obj, res);
  });
}

// ── 运行控制（全部本地，不再经过 Service Worker）──
$('btnCollect').addEventListener('click', async () => {
  await saveCfgSync();
  const cfg = await getCfg();
  AI_KEY = (cfg.zhipuKey || '').trim();
  if (!AI_KEY) return addLog('请先填智谱 API Key（open.bigmodel.cn 申请）', 'error');
  if (!cfg.keyword) return addLog('请先填岗位关键词', 'error');
  if (!(cfg.resumeText || '').trim()) return addLog('请先填简历文字（AI筛选和招呼语都需要）', 'error');
  $('reviewCard').style.display = 'none';
  setRunning(true);
  doCollect(cfg).catch(e => { addLog('收集异常: ' + e.message, 'error'); setRunning(false); });
});

$('btnDeliver').addEventListener('click', () => {
  const ids = Array.from(document.querySelectorAll('.job-item input:checked')).map(c => c.dataset.id);
  if (!ids.length) return addLog('请至少勾选一个岗位', 'error');
  setRunning(true);
  addLog('开始投递 ' + ids.length + ' 个岗位', 'info');
  doDeliver(ids).catch(e => { addLog('投递异常: ' + e.message, 'error'); setRunning(false); });
});

$('btnPause').addEventListener('click', () => {
  if (flow.paused) { flow.paused = false; $('btnPause').textContent = '暂停'; addLog('继续', 'info'); }
  else { flow.paused = true; $('btnPause').textContent = '继续'; addLog('已暂停', 'warn'); }
});
$('btnStop').addEventListener('click', () => { flow.aborted = true; flow.paused = false; setRunning(false); setPhase('idle'); addLog('已停止', 'warn'); });
$('btnReset').addEventListener('click', () => {
  flow.processed = {}; chrome.storage.local.set({ processed: {} });
  flow.jobs = []; flow.screened = [];
  $('reviewCard').style.display = 'none'; setRunning(false); setPhase('idle');
  addLog('已重置（清空已投记录）', 'warn');
});
$('clearLog').addEventListener('click', () => { $('log').innerHTML = ''; });

// ── 重新加载扩展（代码更新后免去 chrome://extensions 重新导入）──
$('btnReload').addEventListener('click', () => {
  addLog('正在重新加载扩展...', 'warn');
  setTimeout(() => { chrome.runtime.reload(); }, 300);
});

$('selAll').addEventListener('change', (e) => {
  document.querySelectorAll('.job-item:not(.skip) input').forEach(c => c.checked = e.target.checked);
});

function setRunning(running) {
  $('btnCollect').disabled = running;
  $('btnPause').disabled = !running;
  $('btnStop').disabled = !running;
  if (!running) $('btnPause').textContent = '暂停';
}
function setPhase(p) {
  flow.phase = p;
  const map = { idle: '未开始', collecting: '收集中', screening: 'AI筛选中', review: '待审核', delivering: '投递中', done: '已完成' };
  $('phaseText').textContent = map[p] || p;
}

// ── 配置读取 ──
function getCfg() { return chrome.storage.local.get(CFG_FIELDS); }

// ── 渲染审核列表 ──
function renderReview(screened) {
  flow.screened = screened;
  const matched = screened.filter(j => j.match);
  const skipped = screened.filter(j => !j.match);
  $('reviewCount').textContent = '匹配 ' + matched.length + ' / ' + screened.length;
  let html = '';
  matched.forEach(j => {
    const out = j.outsource ? ' <span class="outsource-badge">⚠外包</span>' : '';
    const link = j.link ? ' href="' + escUrl(j.link) + '" target="_blank"' : '';
    const sub = j.company ? (esc(j.company) + ' · ' + esc(j.salary)) : (j.salary || '');
    html += '<div class="job-item"><input type="checkbox" checked data-id="' + esc(j.id) + '">'
      + '<div class="job-main">'
      + '<div class="job-title"><a class="job-link"' + link + '>' + esc(j.name) + '</a>' + out + '</div>'
      + '<div class="job-sub">' + sub + '</div>'
      + '<div class="job-reason m">✓ ' + esc(j.reason) + '</div></div></div>';
  });
  skipped.forEach(j => {
    const out = j.outsource ? ' <span class="outsource-badge">⚠外包</span>' : '';
    const link = j.link ? ' href="' + escUrl(j.link) + '" target="_blank"' : '';
    const sub = j.company ? (esc(j.company) + ' · ' + esc(j.salary)) : (j.salary || '');
    html += '<div class="job-item skip"><input type="checkbox" disabled data-id="' + esc(j.id) + '">'
      + '<div class="job-main">'
      + '<div class="job-title"><a class="job-link"' + link + '>' + esc(j.name) + '</a>' + out + '</div>'
      + '<div class="job-sub">' + sub + '</div>'
      + '<div class="job-reason s">✗ ' + esc(j.reason) + '</div></div></div>';
  });
  $('reviewList').innerHTML = html || '<div class="job-sub">无岗位</div>';
  $('reviewCard').style.display = 'block';
}
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escUrl(s) { return (s || '').replace(/"/g, '&quot;'); }

// ── 日志 ──
function addLog(text, level) {
  level = level || 'info';
  const now = new Date();
  const t = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  const el = document.createElement('div');
  el.className = 'log-item ' + level;
  el.innerHTML = '<span class="log-time">[' + t + ']</span>' + esc(text);
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}
function setProg(text) { $('progText').textContent = text || ''; }

// ── Tab 操作（侧边栏直接用 chrome.tabs/chrome.scripting，绕开 SW）──
async function ensureTab(url) {
  let tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  let tab = tabs[0];
  if (!tab) tab = await chrome.tabs.create({ url: url });
  else await chrome.tabs.update(tab.id, { url: url, active: true });
  await waitComplete(tab.id);
  await sleep(800);
  return tab;
}
async function inject(tabId, file) {
  try { await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['src/selectors.js', file] }); } catch (e) {}
}
function sendToTab(tabId, msg, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const t = (timeout || 60000);
    const timer = setTimeout(() => {
      if (done) return; done = true;
      resolve({ success: false, error: '操作超时(' + Math.round(t / 1000) + '秒)，可能页面未响应' });
    }, t);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (done) return; done = true; clearTimeout(timer);
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { success: false, error: 'no response' });
    });
  });
}
function waitComplete(tabId) {
  return new Promise((resolve) => {
    function lis(id, info) { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(lis); setTimeout(resolve, 1200); } }
    chrome.tabs.onUpdated.addListener(lis);
    chrome.tabs.get(tabId, (t) => { if (t && t.status === 'complete') { chrome.tabs.onUpdated.removeListener(lis); setTimeout(resolve, 1200); } });
  });
}
function curUrl(tabId) { return new Promise(res => chrome.tabs.get(tabId, t => res((t && t.url) || ''))); }
async function waitIfPaused() { while (flow.paused && !flow.aborted) await sleep(400); }

// ── 城市/搜索 URL ──
function resolveCity(cfg) {
  const firstCity = (cfg.city || '').split(/[\/、,，\s]+/)[0].replace(/[市省]$/, '') || '';
  const code = (typeof CITY_MAP !== 'undefined' && CITY_MAP[firstCity]) || '100010000';
  return { name: firstCity, code: code, found: code !== '100010000' || firstCity === '全国' };
}
function buildSearchUrl(cfg) {
  const c = resolveCity(cfg);
  const params = { query: cfg.keyword || '', city: c.code, sortType: '1' };
  return 'https://www.zhipin.com/web/geek/jobs?' + new URLSearchParams(params).toString();
}

// ── AI 调用 ──
function callGLM(messages) {
  return fetch(AI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_KEY },
    body: JSON.stringify({ model: 'glm-4-flash', messages: messages, max_tokens: 800, temperature: 0.5 })
  }).then(r => {
    if (!r.ok) return r.text().then(t => { throw new Error('AI ' + r.status + ': ' + t.slice(0, 120)); });
    return r.json();
  }).then(d => (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '');
}

// ── 收集流程 ──
async function doCollect(cfg) {
  flow.aborted = false; flow.paused = false;
  flow.jobs = []; flow.screened = [];
  setPhase('collecting');

  const c = resolveCity(cfg);
  addLog('打开搜索页：' + cfg.keyword + ' | 城市：' + (c.found ? c.name : '全国'));
  if (cfg.city && !c.found) addLog('城市"' + cfg.city + '"未识别，已按全国搜索', 'warn');
  const count = parseInt(cfg.count) || 20;

  const tab = await ensureTab(buildSearchUrl(cfg));
  addLog('收集岗位中（目标 ' + count + ' 个）...');
  await inject(tab.id, 'src/content-search.js');
  const r = await sendToTab(tab.id, { type: 'SCRAPE', count: count }, 90000);
  if (!r || !r.success) { addLog('收集失败：' + (r && r.error), 'error'); setPhase('idle'); setRunning(false); return; }
  flow.jobs = r.jobs || [];
  addLog('收集到 ' + flow.jobs.length + ' 个岗位', 'success');
  if (!flow.jobs.length) { setPhase('idle'); setRunning(false); return; }

  await doScreen(flow.jobs, cfg);
}

// ── 筛选引擎 ──
async function doScreen(jobs, cfg) {
  setPhase('screening');
  var screened = [];
  if (!jobs || !jobs.length) { addLog('无岗位可筛选', 'error'); setRunning(false); return; }
  var blocked = (cfg.blockKeywords || '').split(/[,，、丨|\s]+/).filter(Boolean);
  var minSal = parseFloat(cfg.minSalary || '0');
  var done = 0, total = jobs.length;
  addLog('开始 AI 筛选 ' + total + ' 个岗位...', 'info');
  setProg('0/' + total);

  // 修正"保密"薪资（直接打开详情页抓真实薪资）
  var secretJobs = jobs.filter(function(j) { return !j.salary || j.salary === '保密'; });
  if (secretJobs.length > 0) {
    addLog('修正 ' + secretJobs.length + ' 个保密薪资...', 'info');
    for (var si = 0; si < secretJobs.length; si++) {
      if (flow.aborted) break;
      var oldSal = secretJobs[si].salary || '保密';
      var fixed = await fixSalary(secretJobs[si]);
      if (fixed && fixed !== oldSal) {
        secretJobs[si].salary = fixed;
        if ((si + 1) % 5 === 0) addLog('  已修正 ' + (si + 1) + '/' + secretJobs.length + ' 个', 'info');
      }
    }
    addLog('薪资修正完成', 'success');
    // 修正完回到搜索页，供后续投递使用
  }

  for (var i = 0; i < jobs.length; i++) {
    if (flow.aborted) break; await waitIfPaused();
    var job = jobs[i];
    var res;
    // 硬过滤：屏蔽词
    if (blocked.length > 0) {
      var txt = ((job.name || '') + ' ' + (job.company || '')).toLowerCase();
      var hit = false;
      for (var b = 0; b < blocked.length; b++) { if (txt.indexOf(blocked[b].toLowerCase()) >= 0) { hit = true; break; } }
      if (hit) { res = { match: false, outsource: false, reason: '命中屏蔽词' }; screened.push(Object.assign({}, job, res)); done++; setProg(done + '/' + total); continue; }
    }
    // 硬过滤：薪资门槛（保密的不卡）
    if (minSal > 0) {
      var sal = job.salary || '';
      if (sal !== '保密' && sal !== '面议' && /\d/.test(sal)) {
        var s = sal.replace(/[kK]/g, '').replace(/[^0-9.\-~到]/g, '');
        var mm = s.match(/(\d+)/);
        if (mm && parseFloat(mm[1]) < minSal) { res = { match: false, outsource: false, reason: '薪资低于' + minSal + 'K' }; screened.push(Object.assign({}, job, res)); done++; setProg(done + '/' + total); continue; }
      }
    }
    // AI 筛选
    res = await screenOne(cfg, job);
    screened.push(Object.assign({}, job, res));
    done++;
    setProg(done + '/' + total);
    if (done % 10 === 0) addLog('已处理 ' + done + '/' + total, 'info');
  }
  var matched = screened.filter(j => j.match).length;
  addLog('筛选完成：匹配 ' + matched + ' / ' + total, 'success');
  flow.screened = screened;
  chrome.storage.local.set({ sw_jobs: flow.jobs, sw_screened: screened });
  renderReview(screened);
  setPhase('review');
  setRunning(false);
  setProg('');
}

async function screenOne(cfg, job) {
  var txt = '岗位：' + (job.name || '') + '\n标签：' + ((job.tags || []).join('、')) + '\n薪资：' + (job.salary || '') + '\n公司：' + (job.company || '');
  var sys = '你是资深求职助手。分析岗位信息，输出JSON。\n判断：match=true/false, outsource=true/false, reason=一句话理由\n只输出JSON，不要markdown。';
  var user = '简历：\n' + (cfg.resumeText || '') + '\n\n岗位信息：\n' + txt;
  try {
    var raw = await callGLM([{ role: 'system', content: sys }, { role: 'user', content: user }]);
    var p = null;
    try { p = JSON.parse(raw); } catch (e) { var m = raw.match(/\{[\s\S]*\}/); if (m) { try { p = JSON.parse(m[0]); } catch (e2) {} } }
    if (!p) return { match: false, outsource: false, reason: 'AI解析失败' };
    return { match: p.match === true, outsource: p.outsource === true, reason: p.reason || '' };
  } catch (e) {
    return { match: false, outsource: false, reason: '请求失败:' + e.message };
  }
}

// 直接打开详情页抓真实薪资
async function fixSalary(job) {
  try {
    var link = job.link || ('https://www.zhipin.com/job_detail/' + job.id + '.html');
    var tab = await ensureTab(link);
    var result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function() {
        var sal = '';
        var els = document.querySelectorAll('[class*="salary"], [class*="Salary"], .job-salary');
        for (var i = 0; i < els.length; i++) { sal = els[i].textContent.replace(/\s+/g, ''); if (/\d/.test(sal)) break; }
        if (!/\d/.test(sal)) { var t = document.body.innerText || ''; var m = t.match(/\d+[-~到]\d+[Kk]/); if (m) sal = m[0]; }
        return sal || '';
      }
    }).catch(function() { return [{ result: '' }]; });
    return (result && result[0] && result[0].result) || '';
  } catch (e) { return ''; }
}

// ── 投递流程 ──
async function doDeliver(jobIds) {
  flow.aborted = false; flow.paused = false;
  setPhase('delivering');
  const cfg = await getCfg();
  // 确保 jobs 在（若页面刷新过，从 screened 恢复）
  if (!flow.jobs.length && flow.screened.length) flow.jobs = flow.screened;

  const ids = (jobIds || []).filter(id => !flow.processed[id]);
  if (!ids.length) { addLog('没有可投递的岗位（可能已投过，可点重置）', 'warn'); setPhase('done'); setRunning(false); return; }

  addLog('本次投递 ' + ids.length + ' 个岗位：');
  for (var di = 0; di < ids.length; di++) { var dj = findJob(ids[di]); if (dj) addLog('  ' + (di + 1) + '. ' + dj.name + ' - ' + (dj.company || '')); }
  const searchUrl = buildSearchUrl(cfg);

  let ok = 0, fail = 0;
  for (let k = 0; k < ids.length; k++) {
    if (flow.aborted) break; await waitIfPaused();
    const job = findJob(ids[k]);
    if (!job) { addLog('[' + (k + 1) + '/' + ids.length + '] 找不到岗位数据，跳过', 'warn'); fail++; continue; }
    addLog('[' + (k + 1) + '/' + ids.length + '] ' + job.name + ' - ' + (job.company || ''));

    // 1. 回搜索页，点开卡片读取完整 JD
    const tab = await ensureTab(searchUrl);
    await inject(tab.id, 'src/content-search.js');
    addLog('  读取岗位JD...');
    const jdr = await sendToTab(tab.id, { type: 'OPEN_JD', job: job }, 30000);
    if ((!job.salary || job.salary === '保密') && jdr && jdr.salary) job.salary = jdr.salary;

    // 2. 默认招呼语（不再调 AI，稳定不重样）
    addLog('  使用默认招呼语');
    const greeting = '您好，我对贵司在招的「' + (job.name || '') + '」岗位很感兴趣，方便详细沟通一下吗？';

    // 3. 点立即沟通 → 继续沟通（跳聊天页）
    addLog('  建立联系（立即沟通 → 继续沟通）...');
    await sendToTab(tab.id, { type: 'GO_CHAT', job: job }, 30000);
    await waitComplete(tab.id); await sleep(1200);

    // 4. 聊天页发送招呼语
    const u = await curUrl(tab.id);
    if (u.indexOf('/web/geek/chat') < 0) { addLog('  未进入聊天页，跳过', 'error'); fail++; setProg((k + 1) + '/' + ids.length); continue; }
    await inject(tab.id, 'src/content-chat.js');
    addLog('  发送招呼语...');
    const r = await sendToTab(tab.id, { type: 'SEND_ACTIVE', image: '', greeting: greeting }, 30000);
    if (r && r.success) { ok++; flow.processed[job.id] = 1; chrome.storage.local.set({ processed: flow.processed }); addLog('  ✓ 投递成功', 'success'); }
    else { fail++; addLog('  失败：' + (r && r.error), 'error'); }
    setProg((k + 1) + '/' + ids.length);
    await rand(1000, 1800);
  }
  addLog('投递完成：成功 ' + ok + ' | 失败 ' + fail, 'success');
  setPhase('done');
  setRunning(false);
  setProg('');
}
function findJob(id) { for (var i = 0; i < flow.jobs.length; i++) if (flow.jobs[i].id === id) return flow.jobs[i]; return null; }
