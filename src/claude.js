'use strict';

const { waitForAuthorizeTab } = require('./browser');

const CLAUDE_URL = 'https://claude.ai';
const LOGIN_URL = 'https://claude.ai/login';

/**
 * 获取当前 Chrome 中 claude.ai 登录的邮箱
 * @returns {Promise<string|null>}
 */
async function getCurrentEmail(page) {
  await page.goto(CLAUDE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const email = await page.evaluate(() => {
    // 从页面 meta 或用户信息区域提取邮箱
    const text = document.body.innerText;
    const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    return m ? m[0] : null;
  });
  return email;
}

/**
 * 登出当前 claude.ai 账号
 */
async function logout(page) {
  console.log('🚪 登出当前账号...');
  await page.goto(CLAUDE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // 方案A：通过 JS 找到菜单触发按钮并点击
  const opened = await page.evaluate(() => {
    // 尝试常见的用户菜单触发器
    const selectors = [
      '[data-testid="user-menu-trigger"]',
      '[aria-label*="menu" i]',
      '[aria-label*="account" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { el.click(); return true; }
    }
    return false;
  });

  if (!opened) {
    // 方案B：直接访问登出端点
    await page.goto(`${CLAUDE_URL}/logout`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  // 等菜单展开后找 Log out 条目
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('button, a, [role="menuitem"]'));
    const logoutEl = items.find(el => /log out/i.test(el.innerText));
    if (logoutEl) logoutEl.click();
  });

  await page.waitForTimeout(2000);
  console.log('✅ 已登出');
}

/**
 * 在 claude.ai 登录页输入邮箱，触发验证邮件
 */
async function inputEmail(page, email) {
  console.log(`📧 输入邮箱：${email}`);
  await page.goto(LOGIN_URL, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // 填入邮箱（React 兼容方式）
  await page.evaluate((emailVal) => {
    const input = document.querySelector('input[type="email"], input[name="email"]')
      || document.querySelector('input[type="text"]')
      || Array.from(document.querySelectorAll('input'))
           .find(el => el.type !== 'file' && el.type !== 'hidden' && el.type !== 'checkbox');
    if (!input) throw new Error('未找到邮箱输入框');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (setter && setter.set) setter.set.call(input, emailVal);
    else input.value = emailVal;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, email);

  await page.waitForTimeout(500);

  // 点击提交按钮
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]')
      || Array.from(document.querySelectorAll('button'))
          .find(b => /continue|send|submit/i.test(b.innerText));
    if (!btn) throw new Error('未找到提交按钮');
    btn.click();
  });

  await page.waitForTimeout(2000);
  console.log('✅ 邮箱已提交，等待验证邮件...');
}

/**
 * 等待并自动点击 Authorize 按钮
 * 在用户执行 /login 后，Claude Code 会在浏览器打开 authorize 页面
 */
async function autoAuthorize() {
  console.log('');
  console.log('────────────────────────');
  console.log('🎯 请现在在 Claude Code 终端中执行：/login');
  console.log('   脚本将自动检测并点击 Authorize 按钮');
  console.log('────────────────────────');

  const authPage = await waitForAuthorizeTab(120000);

  // 点击 Authorize 按钮
  await authPage.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => /authorize|allow/i.test(b.innerText));
    if (btn) btn.click();
  });

  console.log('✅ 已点击 Authorize');
}

/**
 * 检查当前账号的 Current session 使用百分比
 * 页面结构：<section> 包含 "Current session" 文字和 "XX% used" 文字
 * @param {import('./browser').ChromePage} page
 * @returns {Promise<number>} 0-100 的整数，获取失败返回 -1
 */
async function checkUsage(page) {
  await page.goto('https://claude.ai/settings/usage', { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  const pct = await page.evaluate(() => {
    for (const section of document.querySelectorAll('section')) {
      if (!section.innerText.includes('Current session')) continue;
      for (const p of section.querySelectorAll('p')) {
        const m = p.innerText.match(/^(\d{1,3})%\s*used$/);
        if (m) return parseInt(m[1], 10);
      }
    }
    return null;
  });

  if (pct !== null) return pct;

  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 800));
  console.warn('⚠️  无法读取 usage，页面文本：\n' + pageText);
  return -1;
}

module.exports = { getCurrentEmail, logout, inputEmail, autoAuthorize, checkUsage };
