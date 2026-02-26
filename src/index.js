'use strict';

const { openChrome } = require('./browser');
const { getNextAccount, markAccountUsed } = require('./accounts');
const { getCurrentEmail, checkUsage, logout, inputEmail, claudeCodeLogin } = require('./claude');
const { fetchVerifyLink } = require('./mail');

const THRESHOLD = 50;

async function main() {
  console.log('🔄 Claude 账号切换工具');
  console.log('────────────────────────');

  // 1. 静默检查当前 usage（复用已有 Claude 标签，不抢焦点）
  const pct = await checkUsage();
  if (pct !== -1) {
    console.log(`📊 Current session: ${pct}%`);
    if (pct < THRESHOLD) {
      console.log(`✋ 尚未达到 ${THRESHOLD}% 阈值，无需切换`);
      return;
    }
    console.log(`🚨 已达到 ${THRESHOLD}%，继续切换...`);
  }

  // 2. 连接已有 Chrome
  const { context } = await openChrome();
  console.log('🌐 已连接 Chrome');

  const page = await context.newPage();

  // 2. 获取当前登录邮箱，排除自身后选取下一个账号
  const currentEmail = await getCurrentEmail(page);
  if (currentEmail) console.log(`👤 当前账号：${currentEmail}`);
  const account = getNextAccount(currentEmail);
  console.log(`📋 切换到账号：${account.email}`);

  try {
    // 3. 登出当前账号
    await logout(page);

    // 4. 输入新邮箱，触发验证邮件
    await inputEmail(page, account.email);

    // 5. 在接码页面获取验证链接
    const mailPage = await context.newPage();
    const verifyLink = await fetchVerifyLink(mailPage, account.token);
    await mailPage.close();

    // 6. 点击验证链接完成登录
    console.log('🔗 点击验证链接...');
    await page.goto(verifyLink, { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    console.log('✅ Claude 账号登录成功');

    // 7. 记录使用时间
    markAccountUsed(account.email);

    // 8. 自动完成 Claude Code OAuth 登录
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
