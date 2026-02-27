'use strict';

const { runAS, ChromePage, saveFrontApp, restoreFrontApp } = require('./browser');

const POLL_INTERVAL = 3000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 遍历 Chrome 所有窗口所有标签页，查找含 Authorize/Allow 按钮的 claude.ai 页面
 * @returns {{ winIndex: number, tabIndex: number } | null}
 */
function findAuthorizeTab() {
  try {
    const result = runAS(`
tell application "Google Chrome"
  set winCount to count windows
  repeat with w from 1 to winCount
    set tabCount to count tabs of window w
    repeat with i from 1 to tabCount
      set tabURL to URL of tab i of window w
      if tabURL contains "claude.ai" and (tabURL contains "oauth" or tabURL contains "auth") then
        return (w as string) & "," & (i as string)
      end if
    end repeat
  end repeat
  return ""
end tell`);
    if (!result) return null;
    const [winIdx, tabIdx] = result.split(',').map(Number);
    if (tabIdx > 0) return { winIndex: winIdx, tabIndex: tabIdx };
  } catch (_) {}
  return null;
}

async function main() {
  console.log('👀 auth-watch: 监听 Chrome 中的 Authorize 页面...');
  console.log('   按 Ctrl+C 停止');
  console.log('');

  // 持续记录最后一个非 Chrome 前台 App，确保 Chrome 抢焦点后仍能恢复
  let lastNonChromeApp = null;

  while (true) {
    try {
      const currentApp = saveFrontApp();
      if (currentApp && !/chrome/i.test(currentApp)) {
        lastNonChromeApp = currentApp;
      }

      const found = findAuthorizeTab();
      if (found) {
        const page = new ChromePage(found.tabIndex, found.winIndex);

        // 检查是否有 Authorize/Allow 按钮
        const hasBtn = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('button'))
            .some(b => /authorize|allow/i.test(b.innerText));
        });

        if (hasBtn) {
          // 点击按钮
          await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button'))
              .find(b => /authorize|allow/i.test(b.innerText));
            if (btn) btn.click();
          });
          console.log(`[${new Date().toLocaleTimeString()}] 🖱️  已点击 Authorize 按钮`);

          await sleep(1500);

          // 关闭标签
          await page.close();

          // 恢复焦点到最后记录的非 Chrome App
          if (lastNonChromeApp) {
            restoreFrontApp(lastNonChromeApp);
          }
          console.log(`[${new Date().toLocaleTimeString()}] ✅ 已自动点击 Authorize 并恢复焦点到 ${lastNonChromeApp || '前台'}`);
        }
      }
    } catch (err) {
      // Chrome 未运行等情况，静默忽略
    }

    await sleep(POLL_INTERVAL);
  }
}

main();
