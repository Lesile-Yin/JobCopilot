// ===== 搜索页 content script：收集岗位 + 建立联系（立即沟通→继续沟通跳聊天页）=====
(function () {
  if (window.__bossToudiSearch) return;
  window.__bossToudiSearch = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function getCards() { return Array.from(document.querySelectorAll(SELECTORS.jobs.jobCard)); }

  function parseCard(card) {
    const nameEl = card.querySelector(SELECTORS.jobs.jobName);
    // 薪资：全力挖掘
    let salary = '';
    // 1) DOM 选择器
    const salEl = card.querySelector('.salary, .job-salary, [class*="salary"]');
    if (salEl) {
      salary = salEl.getAttribute('data-salary') || salEl.getAttribute('data-range') || salEl.getAttribute('title') || '';
    }
    if (!salary && salEl) salary = salEl.textContent;
    // 2) 扫所有 data-* 属性
    if (!salary || !/\d/.test(salary)) {
      const all = card.querySelectorAll('[data-salary],[data-range],[data-min],[data-max]');
      for (const el of all) {
        const v = el.getAttribute('data-salary') || el.getAttribute('data-range');
        if (v && /\d/.test(v)) { salary = v; break; }
      }
    }
    // 3) 扫所有元素 innerText（BOSS可能把薪水藏在不同层级）
    if (!salary || !/\d/.test(salary)) {
      const kids = card.querySelectorAll('*');
      for (const k of kids) {
        if (k.children.length === 0) {  // 叶子节点
          const t = k.textContent.replace(/\s+/g, '');
          if (/\d+[kK]/.test(t) && t.length <= 30) { salary = t; break; }
        }
      }
    }
    // 4) 卡片全文 innerText 最后的兜底
    if (!salary || !/\d/.test(salary)) {
      const full = (card.innerText || '').replace(/\s+/g, '');
      const m = full.match(/\d+[kK]\s*[-~到]\s*\d+[kK]|\d+[-~到]\d+[kK]|\d+[kK]/);
      if (m) salary = m[0];
    }
    // 5) 扫所有元素的 data-* 属性找薪水数字
    if (!salary || !/\d/.test(salary)) {
      const allEls = card.querySelectorAll('*');
      for (const el of allEls) {
        if (el.attributes) {
          for (const attr of el.attributes) {
            if (attr.name.startsWith('data-') && attr.value && /\d/.test(attr.value) && attr.value.length <= 30) {
              salary = attr.value; break;
            }
          }
        }
        if (salary) break;
      }
    }
    // 6) 扫 BOSS 内嵌的 JSON 数据（SSR/CSR 的状态数据里可能有完整薪资）
    if (!salary || !/\d/.test(salary)) {
      const scripts = card.closest('body') ? card.closest('body').querySelectorAll('script[type="application/json"], script[id*="__NEXT"]') : [];
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent || '');
          const str = JSON.stringify(data);
          const sm = str.match(/"salary"\s*:\s*"([^"]*)"/);
          if (sm && /\d/.test(sm[1])) { salary = sm[1]; break; }
        } catch (e) {}
      }
    }
    // 清洗
    salary = (salary || '')
      .replace(/[\u200B-\u200D\uFEFF\u00A0\u2028\u2029\uFFFD\u25A0-\u25FF\u2580-\u259F]/g, '')
      .replace(/\s+/g, '').replace(/&[a-z0-9]+;/gi, '').trim();
    if (!/\d/.test(salary)) { salary = '保密'; }
    else { salary = salary.replace(/[^\u4e00-\u9fff0-9Kk万·\-~薪元天/月]/g, ''); }
    const linkEl = card.querySelector('a[href*="/job_detail/"]') || card.querySelector('a[ka][href]') || card.querySelector('a');
    const link = linkEl ? linkEl.href : '';
    const m = link.match(/job_detail\/([^.?]+)\.html/);
    const id = (m && m[1]) || ((nameEl ? nameEl.textContent.trim() : '') + '|' + salary);
    const tags = Array.from(card.querySelectorAll(SELECTORS.jobs.tagList)).map(t => t.textContent.trim()).filter(Boolean);
    // 公司名：多级兜底，逐个尝试常见结构（排除地名格式）
    let company = '';
    const compSelectors = [
      '.company-name a',
      '.company-name',
      '.company-info .company-name',
      '.boss-info .company-name',
      '.job-card-body .company-name',
      '[class*="company"] a',
      '.company-text',
      'h3.company-name',
      '.job-info .company-name',
      'a[ka*="company"]',
      '[class*="company_name"]',
    ];
    for (const sel of compSelectors) {
      const el = card.querySelector(sel);
      if (el && el.textContent.trim()) {
        var t = el.textContent.trim();
        // 排除地名（含 北京/上海/广州/深圳 等城市名+区名+路名 格式）
        if (/^(北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|重庆|天津|苏州|长沙|东莞|合肥|郑州|厦门|青岛)/.test(t) && /[区路街]/.test(t)) continue;
        company = t; break;
      }
    }
    // 终极兜底：找卡内指向 /company/ 的链接
    if (!company) {
      const a = card.querySelector('a[href*="/company/"]');
      if (a && a.textContent.trim()) company = a.textContent.trim();
    }
    return {
      id: id,
      name: nameEl ? nameEl.textContent.trim() : '未知岗位',
      salary: salary,
      tags: tags,
      company: company,
      link: link
    };
  }

  async function scrape(count) {
    const seen = {};
    const jobs = [];
    let pageNum = 1;
    const MAX_PAGES = 8;

    // 等待卡片渲染：BOSS 是 SPA，CSR 异步出卡片，直接抓会拿到空列表导致后续逻辑错乱
    const waitCards = async (timeoutMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (getCards().length > 0) return true;
        await sleep(400);
      }
      return false;
    };

    if (!await waitCards(15000)) {
      console.warn('[JobCopilot] 等待 15s 仍无岗位卡片，可能页面结构变化或需要登录');
      return jobs.slice(0, count);
    }

    let noNewStreak = 0;
    for (let loop = 0; loop < 150 && jobs.length < count && pageNum <= MAX_PAGES; loop++) {
      const cards = getCards();
      let added = 0;
      for (const c of cards) {
        const j = parseCard(c);
        if (j.id && !seen[j.id]) { seen[j.id] = 1; jobs.push(j); added++; if (jobs.length >= count) break; }
      }
      if (added === 0) noNewStreak++; else noNewStreak = 0;
      if (jobs.length >= count) break;

      // 连续多次无新增 → 尝试翻页。注意：绝不 window.location.href 跳转，
      // 否则 content script 上下文被销毁、sendResponse 丢失，侧边栏会永久卡在“收集中”。
      if (noNewStreak >= 4) {
        noNewStreak = 0;
        pageNum++;
        try {
          const url = new URL(location.href);
          url.searchParams.set('page', String(pageNum));
          history.pushState(null, '', url.toString());
        } catch (e) {}
        window.scrollTo(0, 0);
        await sleep(1500);
        if (!await waitCards(6000)) break; // 翻页后仍无卡片则收工
        continue;
      }

      // 滚动加载更多（BOSS 搜索结果无限滚动）
      const box = document.querySelector('.search-job-result');
      if (box) { try { box.scrollTop = box.scrollHeight; } catch (e) {} }
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(900);
    }
    return jobs.slice(0, count);
  }

  // 在当前 DOM 里按严格条件找目标卡片：先 id，再 岗位名+薪资+公司 全匹配（宁可找不到，绝不错配）
  function matchInDom(job) {
    const cards = getCards();
    for (const c of cards) { const j = parseCard(c); if (job.id && j.id === job.id) return c; }
    for (const c of cards) {
      const j = parseCard(c);
      if (j.name === job.name && j.salary === job.salary && (!job.company || j.company === job.company)) return c;
    }
    return null;
  }
  // 找不到卡片时滚动加载更多再找（BOSS 无限滚动，首屏可能没有目标岗位）
  async function findCardByJob(job, scrollRounds) {
    let card = matchInDom(job);
    if (card) return card;
    for (let i = 0; i < (scrollRounds || 5); i++) {
      const box = document.querySelector('.search-job-result');
      if (box) { try { box.scrollTop = box.scrollHeight; } catch (e) {} }
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(900);
      card = matchInDom(job);
      if (card) return card;
    }
    return null;
  }

  function waitFor(sel, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { clearInterval(iv); resolve(el); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  // 等待出现文字完全匹配的可见元素（用于弹窗"继续沟通"按钮）
  function waitForText(texts, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const els = document.querySelectorAll('a, button, span, div');
        for (const el of els) {
          const tx = (el.textContent || '').trim();
          if (texts.indexOf(tx) >= 0 && el.offsetParent !== null) { clearInterval(iv); resolve(el); return; }
        }
        if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  // 点开卡片 → 抓取右侧详情面板的完整JD + 薪资
  async function openJD(job) {
    const card = await findCardByJob(job, 6);
    if (!card) return { success: false, error: '未找到岗位卡片(已滚动加载6轮)' };
    // 可视化：蓝色高亮卡片
    if (card.style) { const orig = card.style.outline; card.style.outline = '3px solid #00a0e9'; card.style.transition = 'outline 0.2s'; setTimeout(() => { card.style.outline = orig; }, 3000); }
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(500);
    card.click();
    await sleep(1600);
    let jd = '', salary = '';
    const det = document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
    if (det) jd = (det.innerText || '').trim();
    if (!jd) {
      const secs = document.querySelectorAll('.job-sec-text, [class*="job-sec"], [class*="job-desc"]');
      jd = Array.from(secs).map(s => (s.innerText || '').trim()).filter(Boolean).join('\n');
    }
    // 从详情面板提取薪资（详情页一定有完整薪资）
    const salEl = document.querySelector('.job-detail-box .salary, .job-detail .salary, .detail-content .salary, [class*="job-detail"] [class*="salary"]');
    if (salEl) salary = salEl.textContent.replace(/\s+/g, '').trim();
    if (!salary || !/\d/.test(salary)) {
      const all = document.querySelectorAll('.job-detail-box *, .detail-content *');
      for (const el of all) {
        const t = el.textContent.replace(/\s+/g, '');
        if (/\d+[kK]/.test(t) && t.length <= 20) { salary = t; break; }
      }
    }
    // 如果搜到数字，清洗
    if (salary && /\d/.test(salary)) {
      salary = salary.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').replace(/[^\u4e00-\u9fff0-9Kk万·\-~薪元天\/月]/g, '');
    }
    return { success: true, jd: jd.slice(0, 1800), salary: salary || '' };
  }

  // 读取详情面板的岗位名（用于校验当前面板是否就是目标岗位）
  function readDetailName() {
    const det = document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
    if (!det) return '';
    const h = det.querySelector('.job-name, .name, h1, h2, [class*="title"]');
    if (h && h.textContent.trim()) return h.textContent.trim();
    const first = (det.innerText || '').trim().split('\n')[0] || '';
    return first;
  }

  // 卡片已打开 → 点目标卡片自己的"立即沟通"（绝不用全局第一个按钮，防止投错岗位）→ 弹窗点"继续沟通"跳聊天页
  async function goChat(job) {
    // 1) 确保目标卡片存在并已打开（找不到则滚动加载再找）
    const card = await findCardByJob(job, 6);
    if (!card) return { success: false, error: '未找到目标岗位卡片(已滚动加载6轮)，跳过防错投' };
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.click();
    await sleep(1200);
    // 2) 校验详情面板显示的确实是目标岗位（防错投的关键：面板不对就绝不动手）
    const panelName = readDetailName();
    if (panelName && job.name) {
      const a = panelName.replace(/\s+/g, '');
      const b = job.name.replace(/\s+/g, '');
      if (a && b && a.indexOf(b) < 0 && b.indexOf(a) < 0) {
        return { success: false, error: '详情面板岗位「' + panelName + '」与目标「' + job.name + '」不符，跳过' };
      }
    }
    // 3) 找按钮：优先目标卡片内的按钮；其次详情面板内的按钮。绝不用全局第一个！
    let btn = null;
    const inCard = card.querySelector(SELECTORS.jobs.immediateChatBtn);
    if (inCard) btn = inCard;
    if (!btn) {
      const els = card.querySelectorAll('a, button, span');
      for (const el of els) { const tx = (el.textContent || '').trim(); if (tx === '立即沟通' || tx === '继续沟通') { btn = el; break; } }
    }
    if (!btn) {
      const det = document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
      if (det) {
        const db = det.querySelector(SELECTORS.jobs.immediateChatBtn);
        if (db) btn = db;
        if (!btn) {
          const els = det.querySelectorAll('a, button, span');
          for (const el of els) { const tx = (el.textContent || '').trim(); if (tx === '立即沟通' || tx === '继续沟通') { btn = el; break; } }
        }
      }
    }
    if (!btn) return { success: false, error: '未找到立即沟通按钮，跳过' };
    // 可视化：橘色高亮按钮
    if (btn.style) { const orig = btn.style.outline; btn.style.outline = '3px solid #e8830c'; btn.style.transition = 'outline 0.2s'; btn.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => { btn.style.outline = orig; }, 3000); }
    await sleep(300);
    btn.click();
    await sleep(1500);
    const go = await waitForText(['继续沟通'], 4000);
    if (go) { go.click(); return { success: true, navigated: true }; }
    return { success: true, navigated: false };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SCRAPE') {
      scrape(msg.count || 20).then(jobs => sendResponse({ success: true, jobs: jobs })).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'OPEN_JD') {
      openJD(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'GO_CHAT' || msg.type === 'INITIATE' || msg.type === 'CREATE_CONV') {
      goChat(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });
})();
