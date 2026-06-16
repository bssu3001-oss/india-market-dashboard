#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
인도 증시 대시보드 알림체크 — GitHub Actions 하루 3번 실행
① AI 코멘트 (매 실행마다 카톡)
② 매수/손절 조건 충족 시 즉시 카톡
"""

import json
import os
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

import yfinance as yf

KST = timezone(timedelta(hours=9))
STATE_FILE = os.path.join(os.path.dirname(__file__), "알림상태.json")
DASHBOARD_URL = "https://bssu3001-oss.github.io/india-market-dashboard/"


# ── 상태 저장 (중복 발송 방지) ──
def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

def already_sent(state, key):
    today = datetime.now(KST).strftime("%Y-%m-%d")
    run_slot = get_run_slot()
    return f"{key}_{run_slot}" in state.get(today, [])

def mark_sent(state, key):
    today = datetime.now(KST).strftime("%Y-%m-%d")
    run_slot = get_run_slot()
    state.setdefault(today, [])
    slot_key = f"{key}_{run_slot}"
    if slot_key not in state[today]:
        state[today].append(slot_key)

def get_run_slot():
    hour = datetime.now(KST).hour
    if hour < 12:
        return "morning"
    elif hour < 17:
        return "afternoon"
    else:
        return "evening"


# ── 카카오 API ──
def kakao_get_access_token(rest_api_key, refresh_token, client_secret=None):
    params = {"grant_type": "refresh_token", "client_id": rest_api_key, "refresh_token": refresh_token}
    if client_secret:
        params["client_secret"] = client_secret
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(
        "https://kauth.kakao.com/oauth/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        result = json.loads(r.read())
    if "access_token" not in result:
        raise RuntimeError(f"토큰 갱신 실패: {result}")
    return result["access_token"]

def kakao_send(access_token, text):
    template = json.dumps({
        "object_type": "text",
        "text": text[:1000],
        "link": {"web_url": DASHBOARD_URL, "mobile_web_url": DASHBOARD_URL},
        "button_title": "대시보드 열기",
    }, ensure_ascii=False)
    data = urllib.parse.urlencode({"template_object": template}).encode()
    req = urllib.request.Request(
        "https://kapi.kakao.com/v2/api/talk/memo/default/send",
        data=data,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        result = json.loads(r.read())
    if result.get("result_code") != 0:
        raise RuntimeError(f"메시지 전송 실패: {result}")
    print("✅ 카카오 전송 완료")


# ── 시장 데이터 수집 ──
def fetch_market_data():
    ticker = yf.Ticker("^NSEI")
    hist = ticker.history(period="1y", interval="1wk")
    prices = [float(r["Close"]) for _, r in hist.iterrows() if not r.isnull()["Close"]]

    current = prices[-1]
    prev = prices[-2] if len(prices) >= 2 else current
    pct = (current - prev) / prev * 100

    ma5  = sum(prices[-5:])  / min(5,  len(prices))
    ma13 = sum(prices[-13:]) / min(13, len(prices))
    ma26 = sum(prices[-26:]) / min(26, len(prices))

    if ma5 > ma13 > ma26:
        ma_signal = "정배열(상승)"
    elif ma5 < ma13 < ma26:
        ma_signal = "역배열(하락)"
    else:
        ma_signal = "혼조"

    # RSI(14)
    deltas = [prices[i] - prices[i-1] for i in range(1, len(prices))]
    gains  = [d for d in deltas[-14:] if d > 0]
    losses = [-d for d in deltas[-14:] if d < 0]
    avg_g = sum(gains) / 14 if gains else 0
    avg_l = sum(losses) / 14 if losses else 1
    rsi = 100 - (100 / (1 + avg_g / avg_l)) if avg_l else 100

    # 4주 모멘텀
    mom4 = (prices[-1] - prices[-5]) / prices[-5] * 100 if len(prices) >= 5 else 0

    # 52주 위치
    hi52 = max(prices[-52:]) if len(prices) >= 52 else max(prices)
    lo52 = min(prices[-52:]) if len(prices) >= 52 else min(prices)
    from_hi = (current - hi52) / hi52 * 100

    # 연속 하락 주
    consec_down = 0
    for i in range(len(prices) - 1, 0, -1):
        if prices[i] < prices[i-1]:
            consec_down += 1
        else:
            break

    # 보조 지표
    india_vix = us_vix = crude = usdinr = None
    for ticker_sym, var_name in [("^INDIAVIX","india_vix"),("^VIX","us_vix"),("BZ=F","crude"),("USDINR=X","usdinr")]:
        try:
            val = yf.Ticker(ticker_sym).fast_info.last_price
            if var_name == "india_vix": india_vix = round(val, 1)
            elif var_name == "us_vix": us_vix = round(val, 1)
            elif var_name == "crude": crude = round(val, 1)
            elif var_name == "usdinr": usdinr = round(val, 2)
        except Exception:
            pass

    return {
        "current": round(current),
        "prev": round(prev),
        "pct": round(pct, 2),
        "ma5": round(ma5), "ma13": round(ma13), "ma26": round(ma26),
        "ma_signal": ma_signal,
        "rsi": round(rsi, 1),
        "mom4": round(mom4, 1),
        "from_hi": round(from_hi, 1),
        "india_vix": india_vix,
        "us_vix": us_vix,
        "crude": crude,
        "usdinr": usdinr,
        "consec_down": consec_down,
    }


# ── AI 코멘트 생성 ──
def generate_ai_comment(data, anthropic_api_key):
    if not anthropic_api_key:
        return None
    slot_kr = {"morning": "오전", "afternoon": "오후", "evening": "저녁"}.get(get_run_slot(), "")
    prompt = f"""아래는 인도 NIFTY 50 최신 데이터입니다. 한국 투자자 관점에서 오늘 {slot_kr} 시황을 3문장으로 요약해주세요. 숫자 근거 포함, 쉬운 말로, 마지막엔 한 줄 투자 조언.

현재가: {data['current']:,} ({'+' if data['pct']>=0 else ''}{data['pct']}%)
이평선: {data['ma_signal']} (MA5={data['ma5']:,} MA13={data['ma13']:,} MA26={data['ma26']:,})
RSI(14주): {data['rsi']} | 4주 모멘텀: {data['mom4']:+}%
52주 고점 대비: {data['from_hi']}%
India VIX: {data['india_vix'] or 'N/A'} | US VIX: {data['us_vix'] or 'N/A'}
USD/INR: {data['usdinr'] or 'N/A'} | 브렌트유: ${data['crude'] or 'N/A'}"""

    req_body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 300,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=req_body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": anthropic_api_key,
            "anthropic-version": "2023-06-01",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            result = json.loads(r.read())
        return result.get("content", [{}])[0].get("text", "").strip()
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  AI 코멘트 실패 ({e.code}): {body[:200]}")
        return None
    except Exception as e:
        print(f"  AI 코멘트 실패: {e}")
        return None


# ── 종합신호 점수 계산 (대시보드 로직 동일) ──
def calc_scorecard(data):
    score = 0
    max_score = 0

    # 기술적 지표 (각 1.5점)
    rsi = data["rsi"]
    ma  = data["ma_signal"]
    mom = data["mom4"]
    fhi = data["from_hi"]
    lo52_pct = data.get("from_lo", 0)

    rsi_s = 1 if rsi <= 40 else (-1 if rsi >= 70 else 0)
    ma_s  = 1 if "정배열" in ma else (-1 if "역배열" in ma else 0)
    mom_s = 1 if mom >= 2 else (-1 if mom <= -2 else 0)
    # 변동성: 낮을수록 좋음 (std 없으면 중립)
    vol_s = 0
    # 52주 위치: 저점 부근 좋음
    pos_s = 1 if fhi <= -20 else (-1 if fhi >= -3 else 0)

    for s in [rsi_s, ma_s, mom_s, vol_s, pos_s]:
        score += s * 1.5
        max_score += 1.5

    # 매크로 (각 1.0점)
    vix_i = data["india_vix"] or 0
    vix_u = data["us_vix"] or 0
    crude = data["crude"] or 80
    usdinr = data["usdinr"] or 84

    vix_i_s = 1 if vix_i < 15 else (-1 if vix_i > 22 else 0)
    vix_u_s = 1 if vix_u < 20 else (-1 if vix_u > 28 else 0)
    crude_s = 1 if crude < 75 else (-1 if crude > 85 else 0)
    usdinr_s = 1 if usdinr < 83 else (-1 if usdinr > 87 else 0)

    for s in [vix_i_s, vix_u_s, crude_s, usdinr_s]:
        score += s * 1.0
        max_score += 1.0

    pct = max(0, min(100, round((score + max_score) / (2 * max_score) * 100)))

    if score >= max_score * 0.5:   label, emoji = "강매수", "🔥"
    elif score >= max_score * 0.15: label, emoji = "매수 검토", "🟢"
    elif score >= -max_score * 0.15: label, emoji = "관망", "📌"
    elif score >= -max_score * 0.5:  label, emoji = "조심", "⚠️"
    else:                             label, emoji = "진입 자제", "🔴"

    # 한 줄 설명
    desc_parts = []
    if "정배열" in ma: desc_parts.append("이평선 정배열")
    elif "역배열" in ma: desc_parts.append("이평선 역배열")
    else: desc_parts.append("이평선 혼조")
    if mom >= 2: desc_parts.append(f"모멘텀 강세(+{mom:.1f}%)")
    elif mom <= -2: desc_parts.append(f"모멘텀 약세({mom:.1f}%)")
    if vix_i > 0: desc_parts.append(f"India VIX {vix_i}({'안정' if vix_i < 15 else '주의' if vix_i < 22 else '공포'})")
    if usdinr > 0: desc_parts.append(f"루피 {'약세' if usdinr > 87 else '보통'}")

    desc = " / ".join(desc_parts)
    return pct, label, emoji, desc


# ── 알림 조건 체크 ──
def check_conditions(data):
    alerts = []
    nifty = data["current"]
    rsi = data["rsi"]
    india_vix = data["india_vix"]
    us_vix = data["us_vix"]
    ma_signal = data["ma_signal"]

    buy1_price = round(nifty * 0.97)
    buy2_price = round(nifty * 0.91)
    stop_price = round(nifty * 0.90)

    # ── 매수 신호 ──
    if rsi <= 35:
        alerts.append({"type": "매수핵심",
            "msg": f"🟢 [인도증시] 매수 신호!\nRSI {rsi} — 과매도 구간 진입\nNIFTY {nifty:,} | 1차 매수 검토하세요"})

    if ma_signal == "정배열(상승)" and data["mom4"] > 0:
        alerts.append({"type": "매수핵심",
            "msg": f"🟢 [인도증시] 매수 신호!\n이평선 정배열 + 모멘텀 상승 ({data['mom4']:+}%)\nNIFTY {nifty:,} | 추세 추종 매수 검토"})

    if india_vix and india_vix <= 13 and rsi <= 50:
        alerts.append({"type": "매수참고",
            "msg": f"📊 [인도증시] 매수 참고\nIndia VIX {india_vix} (안정) + RSI {rsi}\n변동성 낮은 눌림목 구간"})

    if data["from_hi"] <= -15 and rsi <= 45:
        alerts.append({"type": "매수참고",
            "msg": f"📊 [인도증시] 매수 참고\n52주 고점 대비 {data['from_hi']}% + RSI {rsi}\n저점 매수 구간 진입"})

    # ── 주의/손절 신호 ──
    if india_vix and india_vix >= 22:
        alerts.append({"type": "주의",
            "msg": f"⚠️ [인도증시] 주의\nIndia VIX {india_vix} — 변동성 급등\n신규 매수 자제, 보유분 점검"})

    if us_vix and us_vix >= 28:
        alerts.append({"type": "주의",
            "msg": f"⚠️ [인도증시] 글로벌 경보\n미국 VIX {us_vix} — 공포 구간\n포지션 축소 검토"})

    if data["consec_down"] >= 3:
        alerts.append({"type": "주의",
            "msg": f"⚠️ [인도증시] 주의\nNIFTY {data['consec_down']}주 연속 하락\n추가 하락 가능성, 관망 권장"})

    if nifty <= 22500:
        alerts.append({"type": "손절",
            "msg": f"🔴 [인도증시] 손절 경고!\nNIFTY {nifty:,} — 주요 지지선 붕괴\n손절 기준 재점검하세요"})

    # ── 호재 이벤트 ──
    if ma_signal == "정배열(상승)" and data["pct"] >= 1.5:
        alerts.append({"type": "호재",
            "msg": f"🚀 [인도증시] 강세 신호!\nNIFTY {nifty:,} (+{data['pct']}%) 상승\n이평선 정배열 유지 중"})

    return alerts


# ── 메인 ──
def main():
    rest_api_key    = os.environ.get("KAKAO_REST_API_KEY", "").strip()
    refresh_token   = os.environ.get("KAKAO_REFRESH_TOKEN", "").strip()
    client_secret   = os.environ.get("KAKAO_CLIENT_SECRET", "").strip() or None
    anthropic_key   = os.environ.get("ANTHROPIC_API_KEY", "").strip()

    if not rest_api_key or not refresh_token:
        print("⚠️  KAKAO 환경변수 없음 — 알림 건너뜀")
        return

    now_kst = datetime.now(KST).strftime("%Y-%m-%d %H:%M")
    slot_kr = {"morning": "오전", "afternoon": "오후", "evening": "저녁"}.get(get_run_slot(), "")
    today = datetime.now(KST).strftime("%Y-%m-%d")

    print(f"[{now_kst}] 인도증시 알림체크 시작")
    state = load_state()

    print("카카오 토큰 갱신 중...")
    access_token = kakao_get_access_token(rest_api_key, refresh_token, client_secret)

    print("NIFTY 데이터 수집 중...")
    data = fetch_market_data()
    print(f"NIFTY: {data['current']:,} ({data['pct']:+}%) | RSI: {data['rsi']} | 이평: {data['ma_signal']}")

    # 종합신호 계산
    pct_score, sc_label, sc_emoji, sc_desc = calc_scorecard(data)
    pct_str = f"+{data['pct']:.2f}" if data['pct'] >= 0 else f"{data['pct']:.2f}"

    # ① 시황 알림 (실행마다 1회)
    if not already_sent(state, "ai_comment"):
        print("AI 코멘트 생성 중...")
        comment = generate_ai_comment(data, anthropic_key)
        if comment:
            msg = (f"🇮🇳 인도 증시 {slot_kr} 시황 [{now_kst}]\n\n"
                   f"{comment}\n\n"
                   f"━━━━━━━━━━━━\n"
                   f"종합신호: {sc_emoji} {sc_label} ({pct_score}점)\n"
                   f"{sc_desc}")
        else:
            msg = (f"🇮🇳 인도 증시 {slot_kr} 시황 [{now_kst}]\n\n"
                   f"NIFTY 50: {data['current']:,} ({pct_str}%)\n"
                   f"이평선: {data['ma_signal']} | RSI: {data['rsi']}\n"
                   f"India VIX: {data['india_vix'] or 'N/A'} | USD/INR: {data['usdinr'] or 'N/A'}\n\n"
                   f"━━━━━━━━━━━━\n"
                   f"종합신호: {sc_emoji} {sc_label} ({pct_score}점)\n"
                   f"{sc_desc}")
        kakao_send(access_token, msg)
        mark_sent(state, "ai_comment")
        save_state(state)

    # ② 조건 알림
    alerts = check_conditions(data)
    priority = {"손절": 0, "주의": 1, "매수핵심": 2, "호재": 3, "매수참고": 4}
    alerts.sort(key=lambda a: priority.get(a["type"], 99))

    for alert in alerts:
        key = alert["type"]
        if already_sent(state, key):
            print(f"  ⏭ 오늘 이 슬롯에 이미 보낸 알림 스킵: {key}")
            continue
        kakao_send(access_token, alert["msg"])
        mark_sent(state, key)
        save_state(state)
        print(f"  → {key}: {alert['msg'][:50]}...")

    if not alerts:
        print("✅ 조건 알림 없음")

    # 오래된 상태 정리 (3일 이전 삭제)
    cutoff = (datetime.now(KST) - timedelta(days=3)).strftime("%Y-%m-%d")
    for d in list(state.keys()):
        if d < cutoff:
            del state[d]
    save_state(state)
    print("완료")


if __name__ == "__main__":
    main()
