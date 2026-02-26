'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./accounts');

const PORT = parseInt(process.env.DASHBOARD_PORT, 10) || 3399;
const TRIGGER_FILE = path.join(__dirname, '..', '.trigger');

// ---- API handlers ----

function apiStatus() {
  const config = getConfig();
  const accounts = config.accounts.map(a => ({
    email: a.email,
    user: a.user || null,
    exhausted: !!a.exhausted,
    lastUsed: a.lastUsed || null,
    usageSession: a.usageSession ?? null,
    usageWeekly: a.usageWeekly ?? null,
    usageCheckedAt: a.usageCheckedAt || null,
    weeklyResetsAt: a.weeklyResetsAt || null,
  }));
  return { accounts };
}

function apiHistory(email) {
  const config = getConfig();
  const account = config.accounts.find(a => a.email === email);
  if (!account) return null;
  return { email, history: account.usageHistory || [] };
}

function apiCheck() {
  // 写 .trigger 文件，scraper 轮询到后立即执行一次检查
  try {
    fs.writeFileSync(TRIGGER_FILE, Date.now().toString());
  } catch (_) {}
  return { ok: true };
}

// ---- HTML Dashboard ----

function renderDashboard() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Usage Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 24px; }
  h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 4px; }
  .subtitle { font-size: 0.85rem; color: #94a3b8; margin-bottom: 24px; }
  .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .btn { background: #3b82f6; color: #fff; border: none; border-radius: 8px; padding: 8px 16px; font-size: 0.875rem; cursor: pointer; transition: background 0.2s; }
  .btn:hover { background: #2563eb; }
  .btn:disabled { background: #475569; cursor: not-allowed; }
  #status { font-size: 0.8rem; color: #64748b; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .card { background: #1e293b; border-radius: 12px; padding: 20px; position: relative; cursor: pointer; transition: opacity 0.2s, border-color 0.2s; border: 2px solid transparent; }
  .card:hover { border-color: #475569; }
  .card.exhausted { opacity: 0.45; }
  .card.current { border-color: #3b82f6; }
  .badge { position: absolute; top: 12px; right: 12px; background: #3b82f6; color: #fff; font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
  .badge.exhausted-badge { background: #475569; }
  .email { font-size: 0.95rem; font-weight: 600; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .username { font-size: 0.8rem; color: #94a3b8; margin-bottom: 12px; }
  .metric { margin-bottom: 10px; }
  .metric-label { font-size: 0.75rem; color: #94a3b8; margin-bottom: 4px; display: flex; justify-content: space-between; }
  .bar-bg { background: #334155; border-radius: 999px; height: 8px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; transition: width 0.4s; }
  .green { background: #22c55e; }
  .yellow { background: #eab308; }
  .red { background: #ef4444; }
  .resets-at { font-size: 0.75rem; color: #64748b; margin-top: 8px; }
  .checked-at { font-size: 0.72rem; color: #475569; margin-top: 4px; }

  /* 历史面板 */
  #history-panel { display: none; position: fixed; top: 0; right: 0; bottom: 0; width: 420px; background: #1e293b; padding: 24px; overflow-y: auto; z-index: 100; box-shadow: -4px 0 24px rgba(0,0,0,0.5); }
  #history-panel.open { display: block; }
  #history-close { float: right; background: none; border: none; color: #94a3b8; font-size: 1.2rem; cursor: pointer; }
  #history-title { font-size: 1rem; font-weight: 600; margin-bottom: 16px; word-break: break-all; }
  canvas { width: 100%; border-radius: 8px; margin-bottom: 16px; }
</style>
</head>
<body>
<h1>Claude Usage Dashboard</h1>
<p class="subtitle">每 10 分钟 Playwright 全自动检查 · 点击账号卡片查看历史折线图</p>
<div class="toolbar">
  <button class="btn" id="refreshBtn" onclick="triggerCheck()">立即刷新</button>
  <span id="status">—</span>
</div>
<div class="grid" id="grid">加载中...</div>

<div id="history-panel">
  <button id="history-close" onclick="closeHistory()">✕</button>
  <div id="history-title"></div>
  <canvas id="history-chart" height="200"></canvas>
  <div id="history-table"></div>
</div>

<script>
function barColor(pct) {
  if (pct === null) return 'green';
  if (pct < 50) return 'green';
  if (pct < 80) return 'yellow';
  return 'red';
}

function translateResetTime(s) {
  if (!s) return null;
  const days = { Mon:'周一', Tue:'周二', Wed:'周三', Thu:'周四', Fri:'周五', Sat:'周六', Sun:'周日' };
  return s.replace(/^Resets\s+(\w+)\s+(\d+:\d+)\s*(AM|PM)?/i, (_, day, time, ampm) => {
    const d = days[day] || day;
    const period = ampm ? (ampm.toUpperCase() === 'AM' ? '上午' : '下午') : '';
    return \`下次重置：\${d} \${period}\${time}\`;
  });
}

function relTime(ts) {
  if (!ts) return '从未检查';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return diff + ' 秒前';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  return Math.floor(diff / 3600) + ' 小时前';
}

function renderBar(label, pct) {
  const color = barColor(pct);
  const width = pct !== null ? pct : 0;
  const text = pct !== null ? pct + '%' : '—';
  return \`<div class="metric">
    <div class="metric-label"><span>\${label}</span><span>\${text}</span></div>
    <div class="bar-bg"><div class="bar-fill \${color}" style="width:\${width}%"></div></div>
  </div>\`;
}

function renderCards(accounts) {
  if (!accounts || accounts.length === 0) {
    document.getElementById('grid').innerHTML = '<p style="color:#64748b">暂无账号数据</p>';
    return;
  }
  const active = accounts.filter(a => !a.exhausted && a.lastUsed);
  active.sort((a, b) => b.lastUsed - a.lastUsed);
  const currentEmail = active.length > 0 ? active[0].email : null;

  const html = accounts.map(a => {
    const isCurrent = a.email === currentEmail;
    const classes = ['card', isCurrent ? 'current' : '', a.exhausted ? 'exhausted' : ''].filter(Boolean).join(' ');
    const badge = isCurrent ? '<span class="badge">当前</span>' : (a.exhausted ? '<span class="badge exhausted-badge">耗尽</span>' : '');
    return \`<div class="\${classes}" onclick="showHistory('\${a.email}')">
      \${badge}
      <div class="email" title="\${a.email}">\${a.email}</div>
      \${a.user ? \`<div class="username">\${a.user}</div>\` : ''}
      \${renderBar('Current Session', a.usageSession)}
      \${renderBar('Weekly Limit', a.usageWeekly)}
      \${a.weeklyResetsAt ? \`<div class="resets-at">🔄 \${translateResetTime(a.weeklyResetsAt)}</div>\` : ''}
      <div class="checked-at">上次检查：\${relTime(a.usageCheckedAt)}</div>
    </div>\`;
  }).join('');

  document.getElementById('grid').innerHTML = html;
}

async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    renderCards(d.accounts);
    document.getElementById('status').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
  } catch (e) {
    document.getElementById('status').textContent = '获取失败：' + e.message;
  }
}

async function triggerCheck() {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  btn.textContent = '检查中...';
  document.getElementById('status').textContent = '已触发，等待 scraper 完成（约几分钟）...';
  try {
    await fetch('/api/check');
  } catch (_) {}
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '立即刷新';
    fetchStatus();
  }, 10000);
}

// ---- 历史折线图 ----

async function showHistory(email) {
  const panel = document.getElementById('history-panel');
  document.getElementById('history-title').textContent = email;
  panel.classList.add('open');

  try {
    const r = await fetch('/api/history/' + encodeURIComponent(email));
    const d = await r.json();
    drawChart(d.history || []);
    renderHistoryTable(d.history || []);
  } catch (e) {
    document.getElementById('history-table').textContent = '加载失败：' + e.message;
  }
}

function closeHistory() {
  document.getElementById('history-panel').classList.remove('open');
}

function drawChart(history) {
  const canvas = document.getElementById('history-chart');
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 360;
  const H = 200;
  canvas.width = W;
  canvas.height = H;

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, W, H);

  if (history.length < 2) {
    ctx.fillStyle = '#475569';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('数据不足（至少需要 2 条记录）', W / 2, H / 2);
    return;
  }

  const pad = { t: 16, r: 16, b: 32, l: 36 };
  const gW = W - pad.l - pad.r;
  const gH = H - pad.t - pad.b;

  function xPos(i) { return pad.l + (i / (history.length - 1)) * gW; }
  function yPos(v) { return pad.t + (1 - v / 100) * gH; }

  // 网格线
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  [0, 25, 50, 75, 100].forEach(v => {
    const y = yPos(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#475569';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(v + '%', pad.l - 4, y + 4);
  });

  function drawLine(key, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    history.forEach((d, i) => {
      if (d[key] === null || d[key] === undefined) return;
      const x = xPos(i), y = yPos(d[key]);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  drawLine('session', '#3b82f6');
  drawLine('weekly', '#f59e0b');

  // 图例
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#3b82f6'; ctx.fillRect(pad.l, H - 18, 12, 4);
  ctx.fillStyle = '#94a3b8'; ctx.fillText('Session', pad.l + 16, H - 14);
  ctx.fillStyle = '#f59e0b'; ctx.fillRect(pad.l + 80, H - 18, 12, 4);
  ctx.fillStyle = '#94a3b8'; ctx.fillText('Weekly', pad.l + 96, H - 14);
}

function renderHistoryTable(history) {
  if (history.length === 0) {
    document.getElementById('history-table').innerHTML = '<p style="color:#64748b;font-size:0.8rem">暂无历史记录</p>';
    return;
  }
  const rows = [...history].reverse().slice(0, 20).map(d => {
    const t = new Date(d.at).toLocaleString('zh-CN', { hour12: false });
    return \`<tr>
      <td>\${t}</td>
      <td>\${d.session ?? '—'}%</td>
      <td>\${d.weekly ?? '—'}%</td>
    </tr>\`;
  }).join('');
  document.getElementById('history-table').innerHTML = \`
    <table style="width:100%;border-collapse:collapse;font-size:0.78rem;color:#94a3b8">
      <tr style="color:#64748b"><th style="text-align:left;padding:4px 0">时间</th><th>Session</th><th>Weekly</th></tr>
      \${rows}
    </table>\`;
}

fetchStatus();
setInterval(fetchStatus, 10 * 60 * 1000);
</script>
</body>
</html>`;
}

// ---- HTTP Server ----

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboard());
    return;
  }

  if (url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(apiStatus()));
    return;
  }

  // /api/history/:email
  if (url.startsWith('/api/history/')) {
    const email = decodeURIComponent(url.slice('/api/history/'.length));
    const data = apiHistory(email);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (url === '/api/check') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(apiCheck()));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`🖥  Claude Usage Dashboard 启动`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   GET /           → HTML Dashboard（含历史折线图）`);
  console.log(`   GET /api/status → JSON 所有账号最新 usage`);
  console.log(`   GET /api/history/:email → JSON 历史记录`);
  console.log(`   GET /api/check  → 写 .trigger 触发 scraper 立即检查`);
});
