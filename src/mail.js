'use strict';

const MAIL_URL = 'https://b.171mail.com/?type=claude';
const POLL_INTERVAL = 3000;
const POLL_TIMEOUT = 70000;
const MAX_RETRIES = 3;

function extractVerifyLink(text) {
  const match = text.match(/https:\/\/claude\.ai\/[^\s"'<>\n]+/);
  return match ? match[0].trim() : null;
}

/**
 * 在 171mail 页面获取 Claude 验证链接
 * @param {import('./browser').ChromePage} page
 * @param {string} token - 接码令牌
 */
async function fetchVerifyLink(page, token) {
  console.log('📬 打开接码页面...');
  await page.goto(MAIL_URL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) console.log(`🔄 第 ${attempt} 次尝试...`);

    // 填入接码令牌（React 兼容方式）
    await page.evaluate((tok) => {
      const input = document.querySelector('input');
      if (!input) throw new Error('未找到令牌输入框');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(input, tok);
      else input.value = tok;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, token);

    await page.waitForTimeout(300);

    // 点击获取验证码按钮
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => /获取|查询|get/i.test(b.innerText));
      if (!btn) throw new Error('未找到获取验证码按钮');
      btn.click();
    });

    console.log('⏳ 等待验证链接出现（约20s）...');
    const link = await pollForLink(page);
    if (link) {
      console.log('✅ 获取到验证链接');
      return link;
    }

    if (attempt < MAX_RETRIES) console.log('⚠️  未找到链接，重新触发...');
  }

  throw new Error(`重试 ${MAX_RETRIES} 次后仍未获取到验证链接`);
}

async function pollForLink(page) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    const link = await page.evaluate(() => {
      const text = document.body.innerText;
      const m = text.match(/https:\/\/claude\.ai\/[^\s"'<>\n]+/);
      if (m) return m[0].trim();
      // 也从 href 里找
      for (const a of document.querySelectorAll('a[href*="claude.ai"]')) {
        if (a.href.includes('claude.ai')) return a.href;
      }
      return null;
    });

    if (link) return link;

    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r⏳ 等待中... ${elapsed}s`);
  }
  process.stdout.write('\n');
  return null;
}

module.exports = { fetchVerifyLink };
