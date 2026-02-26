'use strict';

const { waitForAuthorizeTab, findClaudeTab } = require('./browser');

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
  await page.goto(`${CLAUDE_URL}/logout`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
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
 * 复用已有 claude.ai 标签页：用 set URL 导航（不触发 Chrome 激活），读完导回原 URL
 * @returns {Promise<number>} 0-100 的整数，获取失败返回 -1
 */
async function checkUsage() {
  const claudePage = findClaudeTab();
  if (!claudePage) {
    console.warn('⚠️  未找到 claude.ai 标签页，请保持 Claude 在 Chrome 中打开');
    return -1;
  }

  const originalUrl = claudePage.url();

  try {
    await claudePage.goto('https://claude.ai/settings/usage', { waitUntil: 'load', silent: true });
    await claudePage.waitForTimeout(2000);

    const pct = await claudePage.evaluate(() => {
      for (const section of document.querySelectorAll('section')) {
        if (!section.innerText.includes('Current session')) continue;
        for (const p of section.querySelectorAll('p')) {
          const m = p.innerText.match(/^(\d{1,3})%\s*used$/);
          if (m) return parseInt(m[1], 10);
        }
      }
      return null;
    });

    return pct ?? -1;
  } finally {
    // 导回原页面
    if (originalUrl && !originalUrl.includes('/settings/usage')) {
      await claudePage.goto(originalUrl, { waitUntil: 'domcontentloaded', silent: true }).catch(() => {});
    }
  }
}

module.exports = { getCurrentEmail, logout, inputEmail, autoAuthorize, checkUsage };
