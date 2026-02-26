'use strict';

const { execFileSync, spawn } = require('child_process');
const { waitForAuthorizeTab, findClaudeTab, saveFrontApp, restoreFrontApp } = require('./browser');

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
 * 检测 claude CLI 是否可用
 */
function hasClaudeCLI() {
  try {
    execFileSync('which', ['claude'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 自动完成 Claude Code OAuth 登录
 * 有 claude CLI 时全自动，否则回退手动模式
 */
async function claudeCodeLogin() {
  if (!hasClaudeCLI()) {
    console.log('');
    console.log('────────────────────────');
    console.log('⚠️  未检测到 claude CLI，回退手动模式');
    console.log('🎯 请现在在 Claude Code 终端中执行：/login');
    console.log('   脚本将自动检测并点击 Authorize 按钮');
    console.log('────────────────────────');

    const authPage = await waitForAuthorizeTab(120000);
    await authPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => /authorize|allow/i.test(b.innerText));
      if (btn) btn.click();
    });
    console.log('✅ 已点击 Authorize');
    return;
  }

  console.log('');
  console.log('────────────────────────');
  console.log('🤖 检测到 claude CLI，自动执行 OAuth 登录...');

  // 1. 清除旧认证
  try {
    execFileSync('claude', ['auth', 'logout'], { stdio: 'pipe' });
    console.log('🚪 已清除旧 Claude Code 认证');
  } catch {
    // logout 失败说明本来就没认证，忽略
  }

  // 2. 启动 OAuth 流程
  const loginProc = spawn('claude', ['auth', 'login'], { stdio: 'pipe' });

  const loginDone = new Promise((resolve, reject) => {
    loginProc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`claude auth login 退出码: ${code}`));
    });
    loginProc.on('error', reject);
  });

  // 3. 并行等待 authorize 页面出现并点击
  console.log('   等待 Authorize 页面...');
  const authPage = await waitForAuthorizeTab(120000);
  await authPage.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => /authorize|allow/i.test(b.innerText));
    if (btn) btn.click();
  });
  console.log('✅ 已点击 Authorize');

  // 4. 等待 login 进程完成
  await loginDone;

  // 5. 验证认证状态
  try {
    const status = execFileSync('claude', ['auth', 'status'], { stdio: 'pipe', encoding: 'utf-8' });
    console.log(`✅ Claude Code 认证完成：${status.trim()}`);
  } catch {
    console.log('✅ Claude Code 登录流程已完成');
  }
  console.log('────────────────────────');
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
  // 整体只做一次焦点保存/恢复，避免两次失焦
  const prevApp = saveFrontApp();

  try {
    await claudePage.goto('https://claude.ai/settings/usage', { waitUntil: 'load' });
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
      await claudePage.goto(originalUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    // 只恢复一次焦点
    restoreFrontApp(prevApp);
  }
}

module.exports = { getCurrentEmail, logout, inputEmail, claudeCodeLogin, checkUsage };
