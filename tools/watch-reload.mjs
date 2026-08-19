#!/usr/bin/env node
// JobCopilot 自动热重载：监听扩展代码变化 → 通过 Chrome DevTools Protocol 触发 chrome.runtime.reload()
// 用法:
//   node watch-reload.mjs              # 监听 + 自动重载（需 Chrome 已开调试端口）
//   node watch-reload.mjs --once       # 只重载一次，不监听
// 前提: Chrome 需以 --remote-debugging-port=9222 启动（见 start-chrome-debug.sh）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9222;
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCH_PATHS = [path.join(EXT_DIR, 'src'), path.join(EXT_DIR, 'manifest.json')];
const DEBOUNCE_MS = 600;

// 通过 CDP 找到 JobCopilot 扩展的 Service Worker 并执行 chrome.runtime.reload()
async function reloadExtension() {
  let targets;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    targets = await res.json();
  } catch (e) {
    console.error(`[reload] 连不上 Chrome 调试端口 ${PORT}：${e.message}`);
    console.error('[reload] 请用 tools/start-chrome-debug.sh 启动 Chrome（需先完全退出现有 Chrome）');
    return false;
  }
  const extTargets = (targets || []).filter(t =>
    (t.type === 'service_worker' || t.type === 'page') &&
    t.url && t.url.startsWith('chrome-extension://'));
  if (!extTargets.length) { console.error('[reload] 未找到扩展的 Service Worker/页面，扩展是否已加载？'); return false; }

  function evalIn(ws, expression) {
    return new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1e9);
      const timer = setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('evaluate timeout')); }, 8000);
      function onMsg(ev) {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id === id) { clearTimeout(timer); ws.removeEventListener('message', onMsg); resolve(m.result && m.result.result && m.result.result.value); }
      }
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  }

  for (const sw of extTargets) {
    const ws = new WebSocket(sw.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    try {
      const name = await evalIn(ws, 'chrome.runtime.getManifest().name');
      if (name && String(name).includes('JobCopilot')) {
        await evalIn(ws, 'chrome.runtime.reload()');
        console.log(`[reload] 已触发重载: ${name} (${new Date().toLocaleTimeString()})`);
        ws.close();
        return true;
      }
    } catch (e) {}
    ws.close();
  }
  console.error('[reload] 找到的扩展 SW 里没有 JobCopilot，确认扩展已加载');
  return false;
}

if (process.argv.includes('--once')) {
  reloadExtension().then(ok => process.exit(ok ? 0 : 1));
} else {
  // 监听模式
  let timer = null;
  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => reloadExtension(), DEBOUNCE_MS);
  };
  console.log(`[watch] 监听 ${WATCH_PATHS.join(' , ')} ... (Ctrl+C 退出)`);
  WATCH_PATHS.forEach(p => {
    if (fs.existsSync(p)) fs.watch(p, { recursive: true }, onChange);
    else console.warn('[watch] 路径不存在:', p);
  });
  setInterval(() => {}, 1 << 30); // 保持进程存活
}
