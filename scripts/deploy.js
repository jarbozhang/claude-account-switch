'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const OUTPUT_PATH = path.join(ROOT, 'docker-compose.generated.yml');
const DATA_DIR = path.join(ROOT, 'data');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('❌ 未找到 config.json');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const accounts = config.accounts || [];

if (accounts.length === 0) {
  console.error('❌ config.json 中 accounts 为空');
  process.exit(1);
}

// 1. 重新生成 docker-compose.generated.yml
execSync(`node ${path.join(__dirname, 'gen-compose.js')}`, { stdio: 'inherit' });

const COMPOSE = `docker compose -f ${OUTPUT_PATH}`;

// 2. dashboard 始终更新
execSync(`${COMPOSE} up -d dashboard`, { stdio: 'inherit' });

// 3. 对每个 scraper 智能部署
let skipped = 0;
let restarted = 0;

for (const account of accounts) {
  const emailSafe = account.email.toLowerCase().replace('@', '_at_').replace(/\./g, '_');
  const serviceName = emailSafe;
  const cookieFile = path.join(DATA_DIR, 'cookies', emailSafe + '.json');

  const hasSession = fs.existsSync(cookieFile);

  if (hasSession) {
    console.log(`✅ ${emailSafe}  → 已有 session，跳过重启`);
    execSync(`${COMPOSE} up -d --no-recreate ${serviceName}`, { stdio: 'inherit' });
    skipped++;
  } else {
    console.log(`⚡ ${emailSafe} → 无 session，重新启动`);
    execSync(`${COMPOSE} up -d ${serviceName}`, { stdio: 'inherit' });
    restarted++;
  }
}

console.log(`\n完成：跳过 ${skipped} 个，重启 ${restarted} 个`);
