'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'docker-compose.generated.yml');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('❌ 未找到 config.json，请复制 config.example.json 并填写账号信息');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const accounts = config.accounts || [];

if (accounts.length === 0) {
  console.error('❌ config.json 中 accounts 为空');
  process.exit(1);
}

const scraperServices = accounts.map((account) => {
  // 服务名用 emailSafe：@ → _at_，. → _
  const serviceName = account.email.toLowerCase().replace('@', '_at_').replace(/\./g, '_');

  const envLines = [
    `      - ACCOUNT_EMAIL=${account.email}`,
    `      - ACCOUNT_TOKEN=${account.token || ''}`,
  ];
  if (account.sessionKey) {
    envLines.push(`      - ACCOUNT_SESSION_KEY=${account.sessionKey}`);
  }
  if (account.user) {
    envLines.push(`      - ACCOUNT_USER=${account.user}`);
  }
  envLines.push(`      - CHECK_INTERVAL_MS=60000`);
  envLines.push(`      - DATA_DIR=/data`);

  return `  ${serviceName}:
    build: .
    command: python3 src/scraper-single.py
    volumes:
      - ./data:/data
    environment:
${envLines.join('\n')}
    restart: unless-stopped`;
}).join('\n\n');

const yaml = `services:
  dashboard:
    build:
      context: .
      dockerfile: Dockerfile.dashboard
    ports:
      - "3399:3399"
    volumes:
      - ./data:/data
    restart: unless-stopped

${scraperServices}
`;

fs.writeFileSync(OUTPUT_PATH, yaml);
console.log(`✅ 已生成 docker-compose.generated.yml（${accounts.length} 个 scraper 容器）`);
console.log(`\n启动命令：`);
console.log(`  docker compose -f docker-compose.generated.yml up --build`);
