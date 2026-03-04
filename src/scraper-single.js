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

// 通过页面上下文中的 fetch 调用 API 获取 usage（绕过 CF 重新验证）
async function fetchUsageViaAPI(page) {
  return await page.evaluate(async () => {
    try {
      // 1. 获取 orgId
      const orgsRes = await fetch('/api/organizations');
      if (orgsRes.status === 401 || orgsRes.status === 403) return null;
      const orgs = await orgsRes.json();
      if (!orgs || !orgs.length) return null;
      const orgId = orgs[0].uuid;

      // 2. 获取 usage
      const usageRes = await fetch(`/api/organizations/${orgId}/usage`);
      if (!usageRes.ok) return { _error: `usage API ${usageRes.status}`, _orgId: orgId };
      const usage = await usageRes.json();
      return { _raw: usage, _orgId: orgId };
    } catch (e) {
      return { _error: e.message };
    }
  });
}

async function main() {
  ensureDirs();

  // 错开启动，避免多容器同时触发 CF
  const STARTUP_DELAY_MS = parseInt(process.env.STARTUP_DELAY_MS, 10) || 0;
  const delay = STARTUP_DELAY_MS || Math.floor(Math.random() * 60000);
  console.log(`[${ts()}][${email}] ⏳ 启动延迟 ${Math.round(delay / 1000)}s...`);
  await new Promise(r => setTimeout(r, delay));

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
    ],
  });

  let contextOptions = {};
  if (fs.existsSync(cookieFile)) {
    console.log(`[${ts()}][${email}] 🍪 从 cookie 恢复 session`);
    contextOptions.storageState = cookieFile;
  } else {
    console.log(`[${ts()}][${email}] 🆕 无 cookie，准备登录`);
  }

  const context = await browser.newContext(contextOptions);
  // 隐藏 Playwright 自动化特征，避免 CF 检测
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // 删除 Playwright 注入的属性
    delete window.__playwright;
    delete window.__pw_manual;
  });
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

  // 等待 SPA 渲染完成
  for (let i = 0; i < 5; i++) {
    const hasContent = await page.evaluate(() =>
      [...document.querySelectorAll('p')].some(p => p.innerText.includes('% used'))
    );
    if (hasContent) break;
    await page.waitForTimeout(3000);
  }

  // DEBUG
  const dbgTitle = await page.title();
  const dbgPTags = await page.evaluate(() =>
    [...document.querySelectorAll('p')].map(p => p.innerText.trim()).filter(t => t && t.length < 200)
  );
  console.log(`[${ts()}][${email}] [DEBUG] after CF: url=${page.url()}, title=${dbgTitle}, pTags=${JSON.stringify(dbgPTags.slice(0, 15))}`);

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
      // DEBUG: 先用 API 探测看返回什么
      const apiResult = await fetchUsageViaAPI(page);
      console.log(`[${ts()}][${email}] [DEBUG API] ${JSON.stringify(apiResult)}`);

    } catch (e) {
      console.error(`[${ts()}][${email}] ❌ 检查失败：${e.message}`);
    } finally {
      running = false;
    }
  }

  // 启动时立即跑一次（页面已在 usage 页，跳过导航避免重新触发 CF）
  await runCheck(true);

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
