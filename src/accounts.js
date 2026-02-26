'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ 未找到 config.json，请复制 config.example.json 并填写账号信息');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error('❌ config.json 格式错误：', err.message);
    process.exit(1);
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * 选取下一个可用账号：按 lastUsed 升序，跳过 exhausted 和当前使用中的账号
 * @param {string|null} currentEmail - 当前正在使用的账号邮箱，会被排除
 */
function getNextAccount(currentEmail = null) {
  const config = loadConfig();
  const available = config.accounts.filter(a => {
    if (a.exhausted) return false;
    if (currentEmail && a.email.toLowerCase() === currentEmail.toLowerCase()) return false;
    return true;
  });
  if (available.length === 0) {
    console.error('❌ 没有其他可用账号，请添加更多账号或重置 exhausted 字段');
    process.exit(1);
  }
  available.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  return available[0];
}

/**
 * 按邮箱查找指定账号（不跳过 exhausted）
 * @param {string} email
 */
function getAccountByEmail(email) {
  const config = loadConfig();
  const account = config.accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
  if (!account) {
    console.error(`❌ 未找到账号：${email}`);
    process.exit(1);
  }
  return account;
}

function markAccountUsed(email) {
  const config = loadConfig();
  const account = config.accounts.find(a => a.email === email);
  if (account) {
    account.lastUsed = Date.now();
    saveConfig(config);
  }
}

function markAccountExhausted(email) {
  const config = loadConfig();
  const account = config.accounts.find(a => a.email === email);
  if (account) {
    account.exhausted = true;
    account.exhaustedAt = Date.now();
    saveConfig(config);
  }
}

function getConfig() {
  return loadConfig();
}

function saveAccountUsage(email, session, weekly, weeklyResetsAt = null) {
  const config = loadConfig();
  const account = config.accounts.find(a => a.email === email);
  if (!account) return;

  account.usageSession = session;
  account.usageWeekly = weekly;
  account.usageCheckedAt = Date.now();
  if (weeklyResetsAt !== null) account.weeklyResetsAt = weeklyResetsAt;

  // 追加历史记录（最多保留 200 条 ≈ 33 小时）
  if (!account.usageHistory) account.usageHistory = [];
  account.usageHistory.push({ session, weekly, at: Date.now() });
  if (account.usageHistory.length > 200) {
    account.usageHistory = account.usageHistory.slice(-200);
  }

  saveConfig(config);
}

module.exports = { getNextAccount, getAccountByEmail, markAccountUsed, markAccountExhausted, getConfig, saveAccountUsage };
