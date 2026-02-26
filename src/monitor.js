'use strict';

const { openChrome } = require('./browser');
const { getCurrentEmail, checkUsage, logout, inputEmail, claudeCodeLogin } = require('./claude');
const { getNextAccount, markAccountUsed } = require('./accounts');
const { fetchVerifyLink } = require('./mail');

const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const SESSION_THRESHOLD = parseInt(process.env.SESSION_THRESHOLD, 10) || 50;
const WEEKLY_THRESHOLD = parseInt(process.env.WEEKLY_THRESHOLD, 10) || 80;

async function runSwitch(context) {
  const page = await context.newPage();
  const currentEmail = await getCurrentEmail(page);
  if (currentEmail) console.log(`\n👤 当前账号：${currentEmail}`);
  const account = getNextAccount(currentEmail);
  console.log(`🔄 切换到账号：${account.email}`);
  try {
    await logout(page);
    await inputEmail(page, account.email);

    const mailPage = await context.newPage();
    const verifyLink = await fetchVerifyLink(mailPage, account.token);
    await mailPage.close();

    console.log('🔗 点击验证链接...');
    await page.goto(verifyLink, { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    console.log('✅ Claude 账号登录成功');

    markAccountUsed(account.email);

    await claudeCodeLogin();

    console.log('\n🎉 账号切换完成！');
    console.log('🔁 继续监控新账号的 usage...\n');
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  console.log('👀 Usage 监控模式启动');
  console.log(`   阈值：Current session >= ${SESSION_THRESHOLD}% 或 Weekly limit >= ${WEEKLY_THRESHOLD}% 时自动切换`);
  console.log(`   检查间隔：${CHECK_INTERVAL_MS / 60000} 分钟`);
  console.log(`   环境变量：SESSION_THRESHOLD=${SESSION_THRESHOLD}, WEEKLY_THRESHOLD=${WEEKLY_THRESHOLD}`);
  console.log('────────────────────────');

  const { context } = await openChrome();
  console.log('🌐 已连接 Chrome\n');

  await check(context);
  setInterval(() => check(context), CHECK_INTERVAL_MS);
}

let switching = false;

async function check(context) {
  if (switching) return;
  try {
    const { session, weekly } = await checkUsage();
    if (session === -1 && weekly === -1) {
      console.log(`[${ts()}] ⚠️  无法读取 usage，跳过`);
      return;
    }
    console.log(`[${ts()}] 📊 Current session: ${session}% | Weekly limit: ${weekly}%`);

    let reason = null;
    if (session >= SESSION_THRESHOLD) reason = `Current session ${session}% >= ${SESSION_THRESHOLD}%`;
    else if (weekly >= 0 && weekly >= WEEKLY_THRESHOLD) reason = `Weekly limit ${weekly}% >= ${WEEKLY_THRESHOLD}%`;

    if (reason) {
      switching = true;
      console.log(`\n🚨 ${reason}，开始切换...`);
      try { await runSwitch(context); } finally { switching = false; }
    }
  } catch (err) {
    console.error(`[${ts()}] ❌ 检查出错：`, err.message);
  }
}

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

main().catch(err => {
  console.error('❌ 启动失败：', err.message);
  process.exit(1);
});
