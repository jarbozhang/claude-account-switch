'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 把 JS 字符串转义为可嵌入 AppleScript 双引号字符串的格式 */
function escJS(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/** 通过临时 .scpt 文件执行 AppleScript，避免 shell 转义问题 */
function runAS(script) {
  const f = path.join(os.tmpdir(), `as_${process.pid}_${Date.now()}.scpt`);
  fs.writeFileSync(f, script);
  try {
    return execFileSync('osascript', [f], { timeout: 30000 }).toString().trim();
  } finally {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

function getTabCount() {
  return parseInt(runAS(
    'tell application "Google Chrome"\n  return count tabs of front window\nend tell'
  ));
}

class ChromePage {
  /**
   * @param {number} tabIndex  Chrome 1-based tab index
   * @param {number} [winIndex]  Chrome 1-based window index，省略则用 front window
   */
  constructor(tabIndex, winIndex) {
    this._idx = tabIndex;
    this._win = winIndex; // undefined = front window
  }

  _winRef() {
    return this._win ? `window ${this._win}` : 'front window';
  }

  async goto(url, { waitUntil = 'load', silent = false } = {}) {
    let prevApp = null;
    if (silent) {
      try {
        prevApp = runAS('tell application "System Events"\n  return name of first application process whose frontmost is true\nend tell');
      } catch (_) {}
    }

    runAS(`tell application "Google Chrome"\n  set URL of tab ${this._idx} of ${this._winRef()} to "${escJS(url)}"\nend tell`);

    if (silent && prevApp && !/chrome/i.test(prevApp)) {
      try {
        runAS(`tell application "System Events"\n  set frontmost of process "${prevApp.replace(/"/g, '\\"')}" to true\nend tell`);
      } catch (_) {}
    }

    await sleep(waitUntil === 'domcontentloaded' ? 1500 : 2500);
  }

  /**
   * 在标签页中执行 JS，fn 可以是函数或字符串表达式
   * 返回值自动通过 JSON 序列化传回 Node.js
   */
  async evaluate(fn, ...args) {
    let jsCode;
    if (typeof fn === 'function') {
      jsCode = `(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`;
    } else {
      jsCode = String(fn);
    }
    const wrapped = `(function(){try{return JSON.stringify(${jsCode});}catch(e){return JSON.stringify({__err:e.message});}})()`;
    const raw = runAS(
      `tell application "Google Chrome"\n  set r to execute tab ${this._idx} of ${this._winRef()} javascript "${escJS(wrapped)}"\n  return r\nend tell`
    );
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return raw; }
    if (parsed && typeof parsed === 'object' && parsed.__err) throw new Error(parsed.__err);
    return parsed;
  }

  async waitForTimeout(ms) { await sleep(ms); }

  async waitForFunction(fn, { timeout = 30000 } = {}) {
    const start = Date.now();
    const expr = typeof fn === 'function' ? `(${fn.toString()})()` : fn;
    while (Date.now() - start < timeout) {
      try { if (await this.evaluate(expr)) return; } catch (_) {}
      await sleep(2000);
    }
    throw new Error('waitForFunction timed out');
  }

  url() {
    return runAS(
      `tell application "Google Chrome"\n  return URL of tab ${this._idx} of ${this._winRef()}\nend tell`
    );
  }

  async close() {
    try {
      runAS(`tell application "Google Chrome"\n  close tab ${this._idx} of ${this._winRef()}\nend tell`);
    } catch (_) {}
  }
}

/**
 * 检查 Chrome 是否运行，返回 context 对象（包含 newPage 方法）
 */
async function openChrome() {
  try {
    runAS('tell application "Google Chrome" to get name');
  } catch (_) {
    console.error('❌ 请先打开 Google Chrome 并登录 Claude');
    process.exit(1);
  }

  const context = {
    async newPage() {
      // 记录当前激活的 App，开完标签立即还回焦点
      let prevApp = null;
      try {
        prevApp = runAS(
          'tell application "System Events"\n  return name of first application process whose frontmost is true\nend tell'
        );
      } catch (_) {}

      runAS('tell application "Google Chrome"\n  tell front window\n    make new tab\n  end tell\nend tell');
      await sleep(400);

      // 立刻把焦点还给之前的 App（Terminal / iTerm 等）
      if (prevApp && !/chrome/i.test(prevApp)) {
        try {
          runAS(`tell application "System Events"\n  set frontmost of process "${prevApp.replace(/"/g, '\\"')}" to true\nend tell`);
        } catch (_) {}
      }

      return new ChromePage(getTabCount());
    }
  };

  return { browser: null, context };
}

/**
 * 轮询 Chrome 所有标签页，等待含 Authorize 按钮的页面出现
 * 用于 Claude Code /login 流程
 */
async function waitForAuthorizeTab(timeout = 120000) {
  const start = Date.now();
  const initCount = getTabCount();

  while (Date.now() - start < timeout) {
    await sleep(2000);
    const count = getTabCount();
    for (let i = 1; i <= count; i++) {
      try {
        const url = runAS(
          `tell application "Google Chrome"\n  return URL of tab ${i} of front window\nend tell`
        );
        // 只检查 claude.ai 相关页面，或比初始多出的新标签页
        const isClaudeAuth = url.includes('claude.ai') && (url.includes('auth') || url.includes('oauth'));
        const isNewTab = i > initCount;
        if (!isClaudeAuth && !isNewTab) continue;

        const page = new ChromePage(i);
        const hasBtn = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('button'))
            .some(b => /authorize|allow/i.test(b.innerText));
        });
        if (hasBtn) return page;
      } catch (_) {}
    }
  }
  throw new Error('等待 Authorize 页面超时（2分钟），请手动操作');
}

/**
 * 在 Chrome 所有窗口中查找任意 claude.ai 页面，不抢焦点
 * 找不到则在后台新建一个 claude.ai 标签页
 * @returns {ChromePage}
 */
function findClaudeTab() {
  try {
    const result = runAS(`
tell application "Google Chrome"
  set winCount to count windows
  repeat with w from 1 to winCount
    set tabCount to count tabs of window w
    repeat with i from 1 to tabCount
      set tabURL to URL of tab i of window w
      if tabURL contains "claude.ai" then
        return (w as string) & "," & (i as string)
      end if
    end repeat
  end repeat
  return "0,0"
end tell`);
    const [winIdx, tabIdx] = result.split(',').map(Number);
    if (tabIdx > 0) return new ChromePage(tabIdx, winIdx);
  } catch (_) {}

  // 没找到，后台新建一个 claude.ai 标签页
  try {
    runAS(`tell application "Google Chrome"
  tell front window
    make new tab with properties {URL:"https://claude.ai"}
  end tell
end tell`);
    const count = getTabCount();
    return new ChromePage(count);
  } catch (_) {
    return null;
  }
}

/** 获取当前前台 App 名称 */
function saveFrontApp() {
  try {
    return runAS('tell application "System Events"\n  return name of first application process whose frontmost is true\nend tell');
  } catch (_) { return null; }
}

/** 恢复前台 App（跳过 Chrome） */
function restoreFrontApp(appName) {
  if (!appName || /chrome/i.test(appName)) return;
  try {
    runAS(`tell application "System Events"\n  set frontmost of process "${appName.replace(/"/g, '\\"')}" to true\nend tell`);
  } catch (_) {}
}

module.exports = { openChrome, waitForAuthorizeTab, findClaudeTab, saveFrontApp, restoreFrontApp };
