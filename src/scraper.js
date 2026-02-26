'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { getConfig, saveAccountUsage } = require('./accounts');
const { logout, inputEmail } = require('./claude');
const { fetchVerifyLink } = require('./mail');

const TRIGGER_FILE = path.join(__dirname, '..', '.trigger');

/**
 * 对单个账号：登出 → 登入 → 读 usage → 登出
 */
async function checkAccount(browser, account) {
  const page = await browser.newPage();
  try {
    // 1. 登出上一个账号
    await logout(page);

    // 2. 填邮箱，触发验证邮件
    await inputEmail(page, account.email);

    // 3. 171mail 接码
    const mailPage = await browser.newPage();
    let verifyLink;
    try {
      verifyLink = await fetchVerifyLink(mailPage, account.token);
    } finally {
      await mailPage.close();
    }

    // 4. 点击验证链接完成登录
    console.log(`[${account.email}] 🔗 点击验证链接...`);
    await page.goto(verifyLink, { waitUntil: 'load' });
    await page.waitForTimeout(2000);

    // 5. 访问 usage 页
    await page.goto('https://claude.ai/settings/usage', { waitUntil: 'load' });
    await page.waitForTimeout(3000);

    // 6. DOM 解析
    const usage = await page.evaluate(() => {
      const result = { session: null, weekly: null };
      let mode = null;
      for (const p of document.querySelectorAll('p')) {
        const text = p.innerText.trim();
        if (text === 'Current session') { mode = 'session'; continue; }
        if (text.includes('Weekly') || text === 'All models') { mode = 'weekly'; continue; }
        const m = text.match(/^(\d{1,3})%\s*used$/);
        if (m && mode) { result[mode] = parseInt(m[1], 10); mode = null; }
      }
      return result;
    });

    console.log(`[${account.email}] ✅ session=${usage.session ?? '?'}% weekly=${usage.weekly ?? '?'}%`);

    // 7. 写 config.json（含历史记录）
    saveAccountUsage(account.email, usage.session, usage.weekly);

    // 8. 登出，准备下一个账号
    await logout(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function checkAll() {
  const { accounts } = getConfig();
  console.log(`\n[${ts()}] 🔍 开始全量 usage 检查（${accounts.length} 个账号）...`);

  // headless: false + Xvfb 可过 CF 检测
  const browser = await chromium.launch({ headless: false });
  try {
    for (const account of accounts) {
      try {
        await checkAccount(browser, account);
      } catch (e) {
        console.error(`[${account.email}] ❌ 检查失败：${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`[${ts()}] ✔ 全量检查完成`);
}

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

// 轮询 .trigger 文件，实现 dashboard 的"立即刷新"
function watchTrigger(callback) {
  setInterval(() => {
    if (fs.existsSync(TRIGGER_FILE)) {
      try { fs.unlinkSync(TRIGGER_FILE); } catch (_) {}
      callback();
    }
  }, 5000);
}

// ---- 主循环 ----

const INTERVAL_MS = parseInt(process.env.SCRAPER_INTERVAL_MS, 10) || 600000; // 10 分钟

let running = false;

async function run() {
  if (running) return;
  running = true;
  try {
    await checkAll();
  } finally {
    running = false;
  }
}

// 启动时立即跑一次
run();

// 定时跑
setInterval(run, INTERVAL_MS);

// 监听触发文件
watchTrigger(() => {
  console.log(`[${ts()}] ⚡ 收到立即触发信号`);
  run();
});
