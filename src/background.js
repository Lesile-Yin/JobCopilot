// ===== JobCopilot Service Worker（极简）=====
// 所有流程运行在侧边栏（sidepanel.js），此处只负责：点图标打开侧边栏 + 快捷键热重载。
// 注意：Service Worker 里没有 window 对象，不要 importScripts selectors.js（那边用了 window.*），否则 SW 直接崩溃、点图标无法打开侧边栏。

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch (e) {}

// 热重载：按下快捷键（见 manifest commands，mac 默认 Cmd+Shift+9）立即重载扩展，
// 改完代码无需手动去 chrome://extensions 点“重新加载”。
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'reload-extension') chrome.runtime.reload();
});
