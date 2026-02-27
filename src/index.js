'use strict';

const { openChrome } = require('./browser');
const { getNextAccount, getAccountByEmail, markAccountUsed } = require('./accounts');
const { getCurrentEmail, checkUsage, logout, inputEmail, claudeCodeLogin, injectSessionKeyViaJS } = require('./claude');
const { fetchVerifyLink } = require('./mail');

const THRESHOLD = 50;

async function main() {
  const targetEmail = process.argv[2] || null;

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
      // 优先：sessionKey 直注入（无需登出，秒级完成）
      console.log('🔑 sessionKey 直注入...');
      await injectSessionKeyViaJS(page, account.sessionKey);
      await page.goto('https://claude.ai/settings/usage', { waitUntil: 'load' });
      await page.waitForTimeout(2000);
      loggedIn = !page.url().includes('/login');
      if (loggedIn) {
        console.log('✅ sessionKey 登录成功');
      } else {
        console.log('⚠️  sessionKey 无效，回退邮件流程...');
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

  } catch (err) {
    console.error('❌ 出错：', err.message);
    process.exit(1);
  } finally {
    await page.close().catch(() => {});
  }
}

main();
