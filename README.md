# claude-account-switch

多账号 Claude Pro 用量监控看板。通过 Docker 容器并行运行多个 Playwright 实例，定时抓取每个账号的 session/weekly 用量并聚合展示在 Web 看板上。

## 功能

- 多账号并行监控，每账号独立容器
- Web 看板实时展示各账号用量百分比与 weekly 重置时间
- 支持 **sessionKey 直注入**登录（跳过邮件验证，秒级完成）
- 回退支持 [171mail](https://b.171mail.com/?type=claude) 邮件验证登录

## 快速开始

### 1. 配置账号

```bash
cp config.example.json config.json
```

编辑 `config.json`：

```json
{
  "accounts": [
    {
      "email": "account1@example.com",
      "token": "your-171mail-token",
      "user": "张三",
      "sessionKey": "sk-ant-sid01-xxxxxxxx"
    },
    {
      "email": "account2@example.com",
      "token": "your-171mail-token",
      "user": "李四"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `email` | ✅ | Claude 账号邮箱 |
| `token` | 二选一 | [171mail](https://b.171mail.com/?type=claude) 接码令牌 |
| `sessionKey` | 二选一 | 从浏览器 Cookie 复制的 sessionKey（推荐） |
| `user` | ❌ | 显示在看板上的昵称 |

`token` 和 `sessionKey` 至少配置一个；两者都配置时优先使用 sessionKey。

### 2. 生成 Docker Compose 文件

```bash
node scripts/gen-compose.js
```

### 3. 启动

```bash
docker compose -f docker-compose.generated.yml up --build -d
```

看板地址：<http://localhost:3399>

## 如何获取 sessionKey

1. 浏览器打开 `claude.ai` 并登录
2. 打开开发者工具（F12）→ Application → Cookies → `https://claude.ai`
3. 找到 `sessionKey` 条目，复制其 Value（格式：`sk-ant-sid01-...`）
4. 填入 `config.json` 对应账号的 `sessionKey` 字段

sessionKey 有效期约数周至数月，过期后自动回退邮件验证流程。

## 登录逻辑

```
有 cookie 文件 → 直接恢复 session
     ↓ (session 失效)
有 sessionKey → 直接注入 cookie 登录（秒级）
     ↓ (sessionKey 也过期)
171mail 邮件验证登录（约 20-30 秒）
     ↓
保存 cookie 文件供下次恢复
```

## 目录结构

```
claude-account-switch/
├── src/
│   ├── scraper-single.js  # 单账号 scraper，每容器独立运行
│   ├── dashboard.js       # Web 看板服务（port 3399）
│   ├── claude.js          # claude.ai 登录 / 注入 / usage 查询
│   ├── mail.js            # 171mail 接码，获取验证链接
│   └── accounts.js        # config.json 读取
├── scripts/
│   └── gen-compose.js     # 根据 config.json 生成 docker-compose
├── data/                  # 运行时数据（挂载到容器）
│   ├── *.json             # 各账号 usage 数据
│   └── cookies/           # Playwright storageState 缓存
├── config.json            # 账号配置（本地，不提交）
├── config.example.json
├── docker-compose.generated.yml  # gen-compose.js 生成，不提交
└── Dockerfile
```

## 注意事项

- `config.json` 和 `docker-compose.generated.yml` 已在 `.gitignore` 中，不会提交到 Git
- 修改账号配置后需重新运行 `gen-compose.js` 并 `up --build`
- 单个账号登录连续失败 10 次后容器会自动退出（防止无限重试）
