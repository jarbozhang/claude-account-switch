# claude-account-switch

Claude Pro 账号自动切换工具。当当前账号的 Current session 用量达到阈值时，自动切换到下一个账号，完成浏览器登录和 Claude Code 授权。

## 原理

通过 **AppleScript** 控制已有的 Chrome 浏览器，结合 [171mail](https://b.171mail.com/?type=claude) 接码服务完成邮箱验证码登录，全程无需单独安装浏览器驱动。

## 环境要求

- macOS
- Google Chrome（已打开并登录 Claude）
- Node.js（推荐通过 `nvm use stable` 切换）
- Chrome 已启用 **Allow JavaScript from Apple Events**
  > Chrome 菜单栏 → View → Developer → Allow JavaScript from Apple Events

## 安装

```bash
nvm use stable
npm install
cp config.example.json config.json
```

然后编辑 `config.json`，填入账号信息（见下方说明）。

## 配置

`config.json`（从 `config.example.json` 复制，**不会被 Git 提交**）：

```json
{
  "cdpUrl": "http://localhost:9222",
  "accounts": [
    {
      "email": "account1@example.com",
      "token": "your-171mail-token-here",
      "lastUsed": null,
      "exhausted": false
    },
    {
      "email": "account2@example.com",
      "token": "your-171mail-token-here",
      "lastUsed": null,
      "exhausted": false
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `email` | Claude 账号邮箱 |
| `token` | 171mail 接码令牌，在 [b.171mail.com](https://b.171mail.com/?type=claude) 获取 |
| `lastUsed` | 上次切换到该账号的时间戳，自动维护，初始填 `null` |
| `exhausted` | 是否已手动标记为用尽，填 `false` |

## 使用

### 手动切换

```bash
npm run switch
```

执行前会先检查当前 usage。若未达到 50% 阈值，直接退出并提示当前用量；达到阈值后自动执行完整切换流程。

切换流程：
1. 检查当前 usage 百分比
2. 在 Chrome 中登出当前账号（访问 `/logout`）
3. 输入新账号邮箱，触发验证邮件
4. 在 171mail 自动获取验证链接（等待约 20 秒）
5. 点击验证链接完成 Claude 网页登录
6. 提示在 Claude Code 执行 `/login`
7. 自动检测并点击浏览器中的 Authorize 按钮
8. 回到 Claude Code 按回车确认

### 监控模式

```bash
npm run monitor
```

每 **2 分钟**自动检查一次 Current session 用量，达到 50% 时自动触发切换。

监控时静默在后台运行，Chrome 不会获得焦点——通过 `set URL` 复用已有 Claude 标签页，读完数据后导回原页面。

## 账号轮换策略

- 按 `lastUsed` 时间升序排列，优先选最久未使用的账号
- 始终排除当前登录中的账号（避免切换到自己）
- 跳过 `exhausted: true` 的账号
- 切换成功后自动更新 `lastUsed` 时间戳

## 目录结构

```
claude-account-switch/
├── src/
│   ├── index.js       # npm run switch 入口，单次切换流程
│   ├── monitor.js     # npm run monitor 入口，定时监控
│   ├── browser.js     # AppleScript Chrome 控制（ChromePage 类）
│   ├── claude.js      # claude.ai 登出 / 登录 / 授权 / usage 查询
│   ├── mail.js        # 171mail 接码，获取验证链接
│   └── accounts.js    # config.json 读写，账号轮换逻辑
├── config.json        # 账号配置（本地，不提交）
├── config.example.json
└── package.json
```

## 注意事项

- 运行 `monitor` 模式时，Chrome 中需保持至少一个 `claude.ai` 标签页处于打开状态
- 切换流程需要手动在 Claude Code 执行 `/login`，属于半自动流程
- 171mail 验证链接通常在点击获取后约 20 秒到达，最多重试 3 次
- 所有账号用尽时脚本会提示错误并退出，需手动重置 `exhausted` 字段或添加新账号
