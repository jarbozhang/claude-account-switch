'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { logout, inputEmail, injectSessionKey } = require('./claude');
const { fetchVerifyLink } = require('./mail');

const email = process.env.ACCOUNT_EMAIL;
const token = process.env.ACCOUNT_TOKEN;
const sessionKey = process.env.ACCOUNT_SESSION_KEY || null;
const user = process.env.ACCOUNT_USER || null;
const DATA_DIR = process.env.DATA_DIR || '/data';
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS, 10) || 60000;

if (!email || (!token && !sessionKey)) {
  console.error('❌ 缺少必要环境变量：ACCOUNT_EMAIL，以及 ACCOUNT_TOKEN 或 ACCOUNT_SESSION_KEY 之一');
  process.exit(1);
}

const emailSafe = email.replace('@', '_at_').replace(/\./g, '_');
const dataFile = path.join(DATA_DIR, emailSafe + '.json');
const cookieFile = path.join(DATA_DIR, 'cookies', emailSafe + '.json');
const triggerFile = path.join(DATA_DIR, 'triggers', emailSafe + '.trigger');

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function ensureDirs() {
  [DATA_DIR, path.join(DATA_DIR, 'cookies'), path.join(DATA_DIR, 'triggers')].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function readData() {
  if (!fs.existsSync(dataFile)) return { email, user, usageHistory: [] };
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  } catch {
    return { email, user, usageHistory: [] };
  }
}

function writeData(usageSession, usageWeekly, weeklyResetsAt, sessionResetsAt) {
  const current = readData();
  const now = Date.now();

  if (!current.usageHistory) current.usageHistory = [];
  current.usageHistory.push({ session: usageSession, weekly: usageWeekly, at: now });
  if (current.usageHistory.length > 200) {
    current.usageHistory = current.usageHistory.slice(-200);
  }

  const updated = {
    ...current,
    email,
    user,
    usageSession,
    usageWeekly,
    usageCheckedAt: now,
    weeklyResetsAt,
    sessionResetsAt,
  };

  fs.writeFileSync(dataFile, JSON.stringify(updated, null, 2));
}

const attemptsFile = path.join(DATA_DIR, 'cookies', emailSafe + '.attempts');

function readAttempts() {
  if (!fs.existsSync(attemptsFile)) return 0;
  return parseInt(fs.readFileSync(attemptsFile, 'utf-8'), 10) || 0;
}

function incAttempts() {
  fs.writeFileSync(attemptsFile, String(readAttempts() + 1));
}

function clearAttempts() {
  if (fs.existsSync(attemptsFile)) fs.unlinkSync(attemptsFile);
}

async function doLogin(browser, page) {
  const attempts = readAttempts();
  if (attempts >= 3) {
    console.error(`[${ts()}][${email}] ⛔ 已连续登录失败 3 次，等待手动触发重试...`);
    // 轮询等待 retry 触发文件
    const retryFile = path.join(DATA_DIR, 'triggers', emailSafe + '.retry');
    while (true) {
      await new Promise(r => setTimeout(r, 5000));
      if (fs.existsSync(retryFile)) {
        try { fs.unlinkSync(retryFile); } catch (_) {}
        clearAttempts();
        console.log(`[${ts()}][${email}] 🔄 收到重试信号，重新登录...`);
        break;
      }
    }
  }
  console.log(`[${ts()}][${email}] 🔐 执行登录流程（第 ${attempts + 1} 次尝试）...`);
  try {
    await logout(page);
    await inputEmail(page, email);
    const mailPage = await browser.newPage();
    let verifyLink;
    try {
      verifyLink = await fetchVerifyLink(mailPage, token);
    } finally {
      await mailPage.close();
    }
    console.log(`[${ts()}][${email}] 🔗 点击验证链接...`);
    await page.goto(verifyLink, { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    clearAttempts();
    console.log(`[${ts()}][${email}] ✅ 登录成功`);
  } catch (e) {
    incAttempts();
    throw e;
  }
}

// 返回 usage 对象，若被重定向到 /login 返回 null
async function fetchUsage(page) {
  await page.goto('https://claude.ai/settings/usage', { waitUntil: 'load' });
  // 等待 Cloudflare challenge 完成
  for (let i = 0; i < 10; i++) {
    const title = await page.title();
    if (!title.includes('Just a moment')) break;
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(3000);

  if (page.url().includes('/login')) return null;

  // 直接复用 scraper.js:43-58 的 evaluate 代码
  return await page.evaluate(() => {
    const result = { session: null, weekly: null, weeklyResetsAt: null, sessionResetsAt: null };
    let mode = null;
    for (const p of document.querySelectorAll('p')) {
      const text = p.innerText.trim();
      if (text === 'Current session') { mode = 'session'; continue; }
      if (text.includes('Weekly') || text === 'All models') { mode = 'weekly'; continue; }
      if (mode && text.startsWith('Resets ')) {
        if (mode === 'session') result.sessionResetsAt = text;
        if (mode === 'weekly') result.weeklyResetsAt = text;
        continue;
      }
      const m = text.match(/^(\d{1,3})%\s*used$/);
      if (m && mode) { result[mode] = parseInt(m[1], 10); mode = null; }
    }
    return result;
  });
}

async function main() {
  ensureDirs();

  const browser = await chromium.launch({ headless: false });

  let contextOptions = {};
  if (fs.existsSync(cookieFile)) {
    console.log(`[${ts()}][${email}] 🍪 从 cookie 恢复 session`);
    contextOptions.storageState = cookieFile;
  } else {
    console.log(`[${ts()}][${email}] 🆕 无 cookie，准备登录`);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // 初始检测：是否需要登录
  // 优先尝试 sessionKey 注入（无 cookie 文件时直接注入再导航，跳过先访问再判断）
  if (sessionKey && !fs.existsSync(cookieFile)) {
    console.log(`[${ts()}][${email}] 🔑 注入 sessionKey...`);
    await injectSessionKey(context, sessionKey);
  }

  await page.goto('https://claude.ai/settings/usage', { waitUntil: 'load' });
  // 等待 Cloudflare challenge 完成（检测 title，最多 30 秒）
  for (let i = 0; i < 10; i++) {
    const title = await page.title();
    if (!title.includes('Just a moment')) break;
    console.log(`[${ts()}][${email}] ⏳ Cloudflare challenge...`);
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(2000);

  if (page.url().includes('/login')) {
    // sessionKey 无效或未配置，回退邮件流程
    await doLogin(browser, page);

    await context.storageState({ path: cookieFile });
    console.log(`[${ts()}][${email}] 💾 Cookie 已保存`);
  } else {
    if (sessionKey && !fs.existsSync(cookieFile)) {
      console.log(`[${ts()}][${email}] ✅ sessionKey 登录成功`);
    }
    await context.storageState({ path: cookieFile });
    console.log(`[${ts()}][${email}] 💾 Cookie 已保存`);
  }

  let running = false;

  async function runCheck() {
    if (running) return;
    running = true;
    try {
      let usage = await fetchUsage(page);

      if (usage === null) {
        // session 过期，优先尝试 sessionKey 重注入
        console.log(`[${ts()}][${email}] 🔄 Session 过期，重新登录...`);
        if (sessionKey) {
          console.log(`[${ts()}][${email}] 🔑 重新注入 sessionKey...`);
          await injectSessionKey(context, sessionKey);
          usage = await fetchUsage(page);
        }
        if (usage === null) {
          await doLogin(browser, page);
          usage = await fetchUsage(page);
        }
        await context.storageState({ path: cookieFile });
      }

      if (usage === null) {
        console.error(`[${ts()}][${email}] ❌ 登录后仍无法访问 usage 页`);
        return;
      }

      writeData(usage.session, usage.weekly, usage.weeklyResetsAt, usage.sessionResetsAt);
      console.log(`[${ts()}][${email}] ✅ session=${usage.session ?? '?'}% (${usage.sessionResetsAt ?? '?'}) weekly=${usage.weekly ?? '?'}% (${usage.weeklyResetsAt ?? '?'})`);
    } catch (e) {
      console.error(`[${ts()}][${email}] ❌ 检查失败：${e.message}`);
    } finally {
      running = false;
    }
  }

  // 启动时立即跑一次
  await runCheck();

  // 定时检查
  setInterval(runCheck, CHECK_INTERVAL_MS);

  // Trigger 文件监听（复用 scraper.js:98-105 的模式）
  setInterval(() => {
    if (fs.existsSync(triggerFile)) {
      try { fs.unlinkSync(triggerFile); } catch (_) {}
      console.log(`[${ts()}][${email}] ⚡ 收到触发信号，立即检查`);
      runCheck();
    }
  }, 5000);
}

main().catch(e => {
  console.error('❌ 致命错误：', e.message);
  process.exit(1);
});
