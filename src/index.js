'use strict';

const readline = require('readline');
const { openChrome } = require('./browser');
const { getNextAccount, getAccountByEmail, markAccountUsed, getConfig } = require('./accounts');
const { getCurrentEmail, checkUsage, logout, inputEmail, claudeCodeLogin, injectSessionKeyViaExtension } = require('./claude');
const { fetchVerifyLink } = require('./mail');

const THRESHOLD = 50;

function fetchDashboardUsage() {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get('http://localhost:3399/api/status', { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).accounts || []); } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

function formatUsage(pct) {
  if (pct === null || pct === undefined) return '—';
  return `${pct}%`;
}

function usageBar(pct) {
  if (pct === null || pct === undefined) return '';
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

async function promptEmail() {
  const config = getConfig();
  const accounts = config.accounts || [];

  const dashboardAccounts = await fetchDashboardUsage();
  const usageMap = {};
  dashboardAccounts.forEach(a => { usageMap[a.email.toLowerCase()] = a; });

  console.log('');
  console.log('📋 可用账号：');
  accounts.forEach((a, i) => {
    const typeTag = a.exhausted ? '❌' : (a.sessionKey ? '🔑' : '📧');
    const u = usageMap[a.email.toLowerCase()];
    let usageInfo = '';
    if (u) {
      const s = formatUsage(u.usageSession);
      const w = formatUsage(u.usageWeekly);
      usageInfo = `  session ${usageBar(u.usageSession)} ${s}  weekly ${w}`;
    }
    const userName = u ? ` (${u.user})` : '';
    console.log(`  [${i + 1}] ${typeTag} ${a.email}${userName}${usageInfo}`);
  });
  console.log('');

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('🎯 输入邮箱或序号（回车自动选择）：', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) { resolve(null); return; }

      // 序号
      const idx = parseInt(trimmed, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= accounts.length) {
        resolve(accounts[idx - 1].email);
        return;
      }

      // 邮箱
      resolve(trimmed);
    });
  });
}

async function main() {
  const targetEmail = await promptEmail();

  console.log('🔄 Claude 账号切换工具');
  console.log('────────────────────────');

  // 1. 连接已有 Chrome
  const { context } = await openChrome();
  console.log('🌐 已连接 Chrome');

  const page = await context.newPage();

  // 2. 选取目标账号
  let account;
  if (targetEmail) {
    account = getAccountByEmail(targetEmail);
    console.log(`🎯 指定切换到：${account.email}`);
  } else {
    // 静默检查当前 usage
    const { session } = await checkUsage();
    if (session !== -1) {
      console.log(`📊 Current session: ${session}%`);
      if (session < THRESHOLD) {
        console.log(`✋ 尚未达到 ${THRESHOLD}% 阈值，无需切换`);
        await page.close().catch(() => {});
        return;
      }
      console.log(`🚨 已达到 ${THRESHOLD}%，继续切换...`);
    }
    const currentEmail = await getCurrentEmail(page);
    if (currentEmail) console.log(`👤 当前账号：${currentEmail}`);
    account = getNextAccount(currentEmail);
    console.log(`📋 切换到账号：${account.email}`);
  }

  try {
    // 3. 登录目标账号
    let loggedIn = false;

    if (account.sessionKey) {
      // 优先：通过 Chrome 扩展注入 sessionKey（需安装 extension/ 目录的扩展）
      console.log('🔑 sessionKey 注入...');
      const injected = await injectSessionKeyViaExtension(account.sessionKey);
      if (!injected) {
        console.log('⚠️  扩展注入失败，请确认已安装 extension/ 目录的 Chrome 扩展');
      } else {
        await page.goto('https://claude.ai', { waitUntil: 'load' });
        await page.waitForTimeout(2000);
        loggedIn = !page.url().includes('/login');
        if (loggedIn) {
          console.log('✅ sessionKey 登录成功');
        } else {
          console.log('⚠️  sessionKey 已过期，回退邮件流程...');
        }
      }
    }

    if (!loggedIn) {
      // 回退：邮件验证流程
      await logout(page);
      await inputEmail(page, account.email);
      const mailPage = await context.newPage();
      const verifyLink = await fetchVerifyLink(mailPage, account.token);
      await mailPage.close();
      console.log('🔗 点击验证链接...');
      await page.goto(verifyLink, { waitUntil: 'load' });
      await page.waitForTimeout(2000);
      console.log('✅ Claude 账号登录成功');
    }

    // 4. 记录使用时间
    markAccountUsed(account.email);

    // 5. 自动完成 Claude Code OAuth 登录
    await claudeCodeLogin();

    // 9. 完成
    console.log('');
    console.log('🎉 账号切换完成！');
    process.exit(0);

  } catch (err) {
    console.error('❌ 出错：', err.message);
    process.exit(1);
  } finally {
    await page.close().catch(() => {});
  }
}

main();
