# Claude 账号自动切换工具 - 实现计划

## Context

Claude Pro 账号有 token 限制，用户持有多个账号需要快速切换。目标是构建一个半自动化工具：浏览器操作全自动，Claude Code 中的 /login 手动执行。

## 技术栈

- Node.js + Playwright（唯一依赖）
- 通过 CDP 连接用户已有的 Chrome 实例

## 项目结构

```
claude-account-switch/
├── package.json
├── config.json          # 账号列表（gitignore）
├── config.example.json  # 配置示例
├── .gitignore
└── src/
    ├── index.js         # CLI 入口，主流程编排
    ├── browser.js       # Playwright 浏览器连接管理
    ├── claude.js        # claude.ai 登出/登录/authorize 自动化
    ├── mail.js          # 171mail 接码获取验证链接
    └── accounts.js      # 账号列表轮换管理
```

## 配置格式 (config.json)

```json
{
  "cdpUrl": "http://localhost:9222",
  "accounts": [
    {
      "email": "account1@example.com",
      "token": "171mail-token",
      "lastUsed": null,
      "exhausted": false
    }
  ]
}
```

## 主流程（`npm run switch`）

1. 读取 config.json，选取下一个可用账号（按 lastUsed 排序，跳过 exhausted）
2. 通过 CDP 连接 Chrome（需用户先以 `--remote-debugging-port=9222` 启动）
3. 在 claude.ai 登出当前账号
4. 在 claude.ai 登录页输入新邮箱，触发验证邮件
5. 在 171mail 页面输入接码令牌，点击"获取验证码"，轮询等待验证链接（约20s，超时则重新触发，最多重试3次）
6. 浏览器点击验证链接，完成 claude.ai 登录
7. 更新 config.json 中的 lastUsed
8. **终端提示**：请在 Claude Code 中执行 /login
9. 监听浏览器等待 authorize 页面出现（最多2分钟）
10. 自动点击 Authorize 按钮
11. 提示用户回到 Claude Code 确认完成

## 实现步骤

### Step 1: 项目初始化
- 创建 `package.json`（依赖仅 playwright）
- 创建 `.gitignore`（忽略 node_modules、config.json、chrome-data）
- 创建 `config.example.json`

### Step 2: `src/browser.js` - 浏览器连接
- `connectChrome(cdpUrl)` - 通过 CDP 连接已有 Chrome
- 连接失败时打印启动命令提示并退出

### Step 3: `src/accounts.js` - 账号管理
- `getNextAccount()` - 轮换选取下一个可用账号
- `markAccountUsed(email)` - 记录使用时间
- `markAccountExhausted(email)` - 标记耗尽

### Step 4: `src/mail.js` - 接码自动化
- 在 171mail 页面输入接码令牌，点击"获取验证码"按钮
- 轮询等待验证链接出现，每隔 3s 检查一次，最长等待 60s
- 正常情况约 20s 左右链接出现
- 若超时（页面提示超时或 60s 未出现链接），自动重新点击"获取验证码"，最多重试 3 次
- `extractVerifyLink(text)` - 正则提取验证链接
- 注意：页面选择器需实际调试确认

### Step 5: `src/claude.js` - claude.ai 自动化
- `logout(page)` - 登出当前账号
- `inputEmail(page, email)` - 输入邮箱触发验证
- `autoAuthorize(page)` - 监听并点击 Authorize 按钮
- 注意：页面选择器需实际调试确认，这是工作量最大的部分

### Step 6: `src/index.js` - 主流程串联
- 解析 CLI 参数（`--next` 自动下一个，`--pick` 手动选择）
- 按上述主流程顺序调用各模块
- 统一错误处理：重试 + 降级 + 中断提示

## 使用方式

```bash
# 首次：切换 Node 版本并安装依赖
nvm use stable
npm install

# 启动 Chrome 调试模式（一次性）
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# 切换账号
npm run switch
```

## 验证方式

1. 确认能通过 CDP 连接 Chrome
2. 确认能在 claude.ai 完成登出和邮箱输入
3. 确认能从 171mail 获取验证链接
4. 端到端跑通完整切换流程
5. 验证 config.json 中的 lastUsed 正确更新

## 关键信息

- 登录方式：邮箱验证码登录（无密码）
- 接码网站：https://b.171mail.com/?type=claude（需填入接码令牌获取验证链接）
- 账号存储：邮箱 + 接码令牌
- 浏览器连接：CDP 模式（需先以 --remote-debugging-port=9222 启动 Chrome）
- CLI 交互：半自动（浏览器自动化 + /login 手动执行）
- 运行前先 `nvm use stable`
