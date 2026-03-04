#!/usr/bin/env python3
"""
用 curl_cffi 替代 Playwright 抓取 claude.ai usage 数据。
无需浏览器，直接调用 API。
"""

import os
import sys
import json
import time
import hashlib
from datetime import datetime, timezone
from pathlib import Path

from curl_cffi import requests

# ── 环境变量 ──────────────────────────────────────────────
email = os.environ.get('ACCOUNT_EMAIL')
session_key = os.environ.get('ACCOUNT_SESSION_KEY')
user = os.environ.get('ACCOUNT_USER')
DATA_DIR = os.environ.get('DATA_DIR', '/data')
CHECK_INTERVAL_MS = int(os.environ.get('CHECK_INTERVAL_MS', '60000'))
STARTUP_DELAY_MS = int(os.environ.get('STARTUP_DELAY_MS', '0'))

if not email or not session_key:
    print('❌ 缺少必要环境变量：ACCOUNT_EMAIL 和 ACCOUNT_SESSION_KEY', file=sys.stderr)
    sys.exit(1)

email_safe = email.replace('@', '_at_').replace('.', '_')
data_file = Path(DATA_DIR) / f'{email_safe}.json'
trigger_file = Path(DATA_DIR) / 'triggers' / f'{email_safe}.trigger'

BASE_URL = 'https://claude.ai'

# ── 工具函数 ──────────────────────────────────────────────

def ts():
    return datetime.now().strftime('%H:%M:%S')


def ensure_dirs():
    for d in [DATA_DIR, f'{DATA_DIR}/cookies', f'{DATA_DIR}/triggers']:
        Path(d).mkdir(parents=True, exist_ok=True)


def read_data():
    if not data_file.exists():
        return {'email': email, 'user': user, 'usageHistory': []}
    try:
        return json.loads(data_file.read_text())
    except Exception:
        return {'email': email, 'user': user, 'usageHistory': []}


def write_data(usage_session, usage_weekly, weekly_resets_at, session_resets_at):
    current = read_data()
    now = int(time.time() * 1000)

    if 'usageHistory' not in current:
        current['usageHistory'] = []
    current['usageHistory'].append({'session': usage_session, 'weekly': usage_weekly, 'at': now})
    if len(current['usageHistory']) > 200:
        current['usageHistory'] = current['usageHistory'][-200:]

    current.update({
        'email': email,
        'user': user,
        'usageSession': usage_session,
        'usageWeekly': usage_weekly,
        'usageCheckedAt': now,
        'weeklyResetsAt': weekly_resets_at,
        'sessionResetsAt': session_resets_at,
    })

    data_file.write_text(json.dumps(current, indent=2, ensure_ascii=False))


def format_resets_at(iso_str):
    """将 ISO 时间转为 'Resets in X hr Y min' 格式"""
    if not iso_str:
        return None
    try:
        resets_at = datetime.fromisoformat(iso_str.replace('Z', '+00:00'))
        now = datetime.now(timezone.utc)
        diff = resets_at - now
        total_seconds = max(0, int(diff.total_seconds()))
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        if hours > 0:
            return f'Resets in {hours} hr {minutes} min'
        return f'Resets in {minutes} min'
    except Exception:
        return iso_str


def build_session():
    """创建 curl_cffi session，impersonate chrome"""
    s = requests.Session()
    s.headers.update({
        'cookie': f'lastActiveOrg=; sessionKey={session_key}',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })
    return s


def api_get(session, url, retries=5):
    """带 429 指数退避重试的 GET 请求"""
    for i in range(retries):
        resp = session.get(url, impersonate='chrome120')
        if resp.status_code == 429:
            wait = 10 * (2 ** i)  # 10s, 20s, 40s, 80s, 160s
            print(f'[{ts()}][{email}] ⚠️ 429 限速，{wait}s 后重试 ({i+1}/{retries})...')
            time.sleep(wait)
            continue
        return resp
    return resp


def fetch_usage(session):
    """调用 API 获取 usage 数据"""
    # 1. 获取 orgId
    resp = api_get(session, f'{BASE_URL}/api/organizations')
    if resp.status_code in (401, 403):
        print(f'[{ts()}][{email}] ❌ sessionKey 无效 (HTTP {resp.status_code})')
        return None
    resp.raise_for_status()
    orgs = resp.json()
    if not orgs or not isinstance(orgs, list) or len(orgs) == 0:
        print(f'[{ts()}][{email}] ❌ 无法获取 organization')
        return None
    org_id = orgs[0]['uuid']

    # 2. 获取 usage
    resp = api_get(session, f'{BASE_URL}/api/organizations/{org_id}/usage')
    resp.raise_for_status()
    usage = resp.json()
    return usage


def parse_usage(usage_data):
    """解析 usage 数据，返回 (session%, weekly%, weeklyResetsAt, sessionResetsAt)"""
    five_hour = usage_data.get('five_hour', {})
    seven_day = usage_data.get('seven_day', {})

    session_pct = five_hour.get('utilization')
    weekly_pct = seven_day.get('utilization')

    # utilization 已经是百分比整数（如 67 = 67%），无需再乘 100
    if session_pct is not None:
        session_pct = round(session_pct, 1)
    if weekly_pct is not None:
        weekly_pct = round(weekly_pct, 1)

    session_resets = five_hour.get('resets_at')
    weekly_resets = seven_day.get('resets_at')

    return session_pct, weekly_pct, weekly_resets, session_resets


# ── 主循环 ────────────────────────────────────────────────

def main():
    ensure_dirs()

    # 启动延迟：用 email hash 产生 0-60s 不同延迟，避免同时请求触发 429
    delay_ms = STARTUP_DELAY_MS or (int(hashlib.md5(email.encode()).hexdigest(), 16) % 60000)
    delay_s = delay_ms / 1000
    print(f'[{ts()}][{email}] ⏳ 启动延迟 {delay_s:.0f}s...')
    time.sleep(delay_s)

    session = build_session()
    check_interval_s = CHECK_INTERVAL_MS / 1000

    def run_check():
        try:
            usage_data = fetch_usage(session)
            if usage_data is None:
                return

            session_pct, weekly_pct, weekly_resets, session_resets = parse_usage(usage_data)

            session_resets_str = format_resets_at(session_resets)
            weekly_resets_str = format_resets_at(weekly_resets)

            print(f'[{ts()}][{email}] ✅ session={session_pct}% weekly={weekly_pct}% | {session_resets_str} | {weekly_resets_str}')

            write_data(session_pct, weekly_pct, weekly_resets, session_resets)

        except Exception as e:
            print(f'[{ts()}][{email}] ❌ 检查失败：{e}')

    # 首次检查
    run_check()

    # 定时循环 + trigger 监听
    last_check = time.time()
    while True:
        time.sleep(5)

        # trigger 文件检测
        if trigger_file.exists():
            try:
                trigger_file.unlink()
            except Exception:
                pass
            print(f'[{ts()}][{email}] ⚡ 收到触发信号，立即检查')
            run_check()
            last_check = time.time()
            continue

        # 定时检查
        if time.time() - last_check >= check_interval_s:
            run_check()
            last_check = time.time()


if __name__ == '__main__':
    main()
