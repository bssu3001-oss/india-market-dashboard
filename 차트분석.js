/* ────────────────────────────────────────────────────────────────
   차트분석.js — kodex 대시보드 차트/분석 기능을 클라이언트(브라우저)로 이식.
   야후 캔들(시·고·저·종·거래량)만으로 이동평균·지지저항·시그널·시나리오·
   백테스트·오늘의 흐름을 전부 브라우저에서 계산해 lightweight-charts로 렌더.
   대시보드별로 다른 값은 window.KODEX_CFG 하나로만 받는다.
   ──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var CFG = window.KODEX_CFG || {};
  var TZ = CFG.tz || 'America/New_York';
  var DEC = CFG.dec || 0;
  var PFX = CFG.unitPrefix || '';
  var SFX = CFG.unitSuffix || '';

  var MA_COLORS = { '5': '#f7c948', '20': '#e884f7', '60': '#4cafe9', '120': '#f77c48' };
  var isDark = matchMedia('(prefers-color-scheme: dark)').matches;

  // ── 포맷 헬퍼 ──
  function fmt(n, dec) {
    if (n == null || isNaN(n)) return '–';
    dec = dec == null ? 0 : dec;
    return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function money(n) { if (n == null || isNaN(n)) return '–'; return PFX + fmt(n, DEC) + SFX; }
  function pct(n) {
    if (n == null || isNaN(n)) return '–';
    var s = Number(n).toFixed(2);
    return (Number(n) >= 0 ? '+' : '') + s + '%';
  }
  function colorClass(n) { return Number(n) > 0 ? 'up' : (Number(n) < 0 ? 'down' : ''); }

  // ── 시간대 헬퍼 (장 시간/날짜를 시장 현지 기준으로) ──
  function tzParts(epochSec) {
    var d = new Date(epochSec * 1000);
    var p = {};
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
    }).formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }
  function tzDate(epochSec) { var p = tzParts(epochSec); return p.year + '-' + p.month + '-' + p.day; }
  function tzHM(epochSec) { var p = tzParts(epochSec); return (p.hour === '24' ? '00' : p.hour) + ':' + p.minute; }
  function marketStatus() {
    var p = tzParts(Date.now() / 1000);
    if (p.weekday === 'Sat' || p.weekday === 'Sun') return 'CLOSE';
    var mins = (+(p.hour === '24' ? 0 : p.hour)) * 60 + (+p.minute);
    return (mins >= (CFG.openMin || 0) && mins < (CFG.closeMin || 1440)) ? 'OPEN' : 'CLOSE';
  }

  // ═══════════════ 지표 계산 (lib/indicators.py 이식) ═══════════════
  function smaSeries(candles, period) {
    var closes = candles.map(function (c) { return c.close; });
    if (closes.length < period) return [];
    var out = [], sum = 0;
    for (var i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= period) sum -= closes[i - period];
      if (i >= period - 1) out.push({ date: candles[i].date, value: Math.round((sum / period) * 100) / 100 });
    }
    return out;
  }
  function smaCurrent(candles, period) {
    if (candles.length < period) return null;
    var s = 0; for (var i = candles.length - period; i < candles.length; i++) s += candles[i].close;
    return Math.round((s / period) * 100) / 100;
  }
  function rsiCurrent(candles, period) {
    period = period || 14;
    var closes = candles.map(function (c) { return c.close; });
    if (closes.length < period + 1) return null;
    var gains = [], losses = [];
    for (var i = 1; i < closes.length; i++) { var d = closes[i] - closes[i - 1]; gains.push(Math.max(d, 0)); losses.push(Math.abs(Math.min(d, 0))); }
    var ag = 0, al = 0, j;
    for (j = 0; j < period; j++) { ag += gains[j]; al += losses[j]; }
    ag /= period; al /= period;
    for (j = period; j < gains.length; j++) { ag = (ag * (period - 1) + gains[j]) / period; al = (al * (period - 1) + losses[j]) / period; }
    if (al === 0) return ag > 0 ? 100 : 50;
    var rs = ag / al; return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
  }
  function atrCurrent(candles, period) {
    period = period || 14;
    if (candles.length < period + 1) return null;
    var trs = [];
    for (var i = 1; i < candles.length; i++) {
      var h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    var atr = 0, k; for (k = 0; k < period; k++) atr += trs[k]; atr /= period;
    for (k = period; k < trs.length; k++) atr = (atr * (period - 1) + trs[k]) / period;
    return Math.round(atr * 10) / 10;
  }
  function movingAlignment(candles) {
    var ma5 = smaCurrent(candles, 5), ma20 = smaCurrent(candles, 20), ma60 = smaCurrent(candles, 60), ma120 = smaCurrent(candles, 120);
    var pairs = { ma5: ma5, ma20: ma20, ma60: ma60, ma120: ma120 };
    var defined = [ma5, ma20, ma60, ma120].filter(function (v) { return v != null; });
    var status;
    if (defined.length < 2) status = '데이터 부족';
    else if (defined.every(function (v, i) { return i === 0 || defined[i - 1] >= v; })) status = '정배열';
    else if (defined.every(function (v, i) { return i === 0 || defined[i - 1] <= v; })) status = '역배열';
    else status = '혼조';
    var current = candles.length ? candles[candles.length - 1].close : null;
    var gap = {};
    Object.keys(pairs).forEach(function (k) { var v = pairs[k]; if (v != null) gap[k] = (current && v) ? Math.round((current - v) / v * 100 * 100) / 100 : null; });
    return { status: status, ma5: ma5, ma20: ma20, ma60: ma60, ma120: ma120, gap_pct: gap };
  }
  function detectCrosses(candles) {
    if (candles.length < 21) return { golden: null, dead: null };
    var golden = null, dead = null;
    for (var i = 20; i < candles.length; i++) {
      var sub = candles.slice(0, i + 1), prev = candles.slice(0, i);
      var m5n = smaCurrent(sub, 5), m20n = smaCurrent(sub, 20), m5p = smaCurrent(prev, 5), m20p = smaCurrent(prev, 20);
      if (m5n == null || m20n == null || m5p == null || m20p == null) continue;
      if (m5p < m20p && m5n >= m20n) golden = candles[i].date;
      else if (m5p > m20p && m5n <= m20n) dead = candles[i].date;
    }
    return { golden: golden, dead: dead };
  }
  function supportResistance(candles, lookback, resLookback) {
    lookback = lookback || 60; resLookback = resLookback || 250;
    var recent = candles.length >= lookback ? candles.slice(-lookback) : candles;
    var resRecent = candles.length >= resLookback ? candles.slice(-resLookback) : candles;
    var current = candles[candles.length - 1].close;
    var swingLows = [], swingHighs = [], i, c;
    for (i = 2; i < recent.length - 2; i++) {
      var l = recent[i].low, min = Infinity;
      for (var a = i - 2; a <= i + 2; a++) min = Math.min(min, recent[a].low);
      if (l === min) swingLows.push(l);
    }
    for (i = 2; i < resRecent.length - 2; i++) {
      var hh = resRecent[i].high, max = -Infinity;
      for (var b = i - 2; b <= i + 2; b++) max = Math.max(max, resRecent[b].high);
      if (hh === max) swingHighs.push(hh);
    }
    [20, 60, 120].forEach(function (p) { var v = smaCurrent(candles, p); if (v) { if (v < current) swingLows.push(v); else swingHighs.push(v); } });
    function cluster(prices, thr) {
      thr = thr || 0.5;
      if (!prices.length) return [];
      var uniq = Array.from(new Set(prices.map(function (p) { return Math.round(p); }))).sort(function (x, y) { return x - y; });
      var cl = [[uniq[0]]];
      for (var k = 1; k < uniq.length; k++) {
        var p = uniq[k];
        if (Math.abs(p - cl[cl.length - 1][0]) / cl[cl.length - 1][0] * 100 < thr) cl[cl.length - 1].push(p);
        else cl.push([p]);
      }
      return cl.map(function (g) { return Math.round(g.reduce(function (a, b) { return a + b; }, 0) / g.length); });
    }
    var supports = cluster(swingLows).filter(function (p) { return p < current; }).sort(function (a, b) { return b - a; }).slice(0, 4);
    var resistances = cluster(swingHighs).filter(function (p) { return p > current; }).sort(function (a, b) { return a - b; }).slice(0, 5);
    var nearestSup = supports[0] != null ? supports[0] : null;
    var nearestRes = resistances[0] != null ? resistances[0] : null;
    var maLevels = [smaCurrent(candles, 60), smaCurrent(candles, 120)].filter(Boolean);
    var testWin = candles.length >= 120 ? candles.slice(-120) : candles;
    function strength(level, win, key) {
      var band = level * 0.007;
      var touches = win.filter(function (c) { return Math.abs(c[key] - level) <= band; }).length;
      var conf = maLevels.filter(function (m) { return Math.abs(m - level) / level <= 0.012; }).length;
      return { touches: touches, confluence: conf, score: touches + conf * 3 };
    }
    var supportMeta = [], strongestSup = null, best = -1;
    supports.forEach(function (s) { var st = strength(s, testWin, 'low'); supportMeta.push({ level: s, touches: st.touches, confluence: st.confluence, score: st.score }); if (st.score > best) { best = st.score; strongestSup = s; } });
    var resMeta = [], strongestRes = null, bestR = -1;
    resistances.forEach(function (r) { var st = strength(r, resRecent, 'high'); resMeta.push({ level: r, touches: st.touches, confluence: st.confluence, score: st.score }); if (st.score > bestR) { bestR = st.score; strongestRes = r; } });
    return {
      supports: supports, resistances: resistances, support_meta: supportMeta, resistance_meta: resMeta,
      strongest_support: strongestSup, strongest_resistance: strongestRes,
      nearest_support: nearestSup, nearest_resistance: nearestRes,
      dist_to_support_pct: nearestSup ? Math.round((current - nearestSup) / current * 100 * 100) / 100 : null,
      dist_to_resistance_pct: nearestRes ? Math.round((nearestRes - current) / current * 100 * 100) / 100 : null,
    };
  }
  function volumeAnalysis(candles) {
    if (candles.length < 20) return { trend: '데이터 부족', vs_ma5: null, vs_ma20: null };
    var vols = candles.map(function (c) { return c.volume || 0; });
    var ma5 = vols.slice(-5).reduce(function (a, b) { return a + b; }, 0) / 5;
    var ma20 = vols.slice(-20).reduce(function (a, b) { return a + b; }, 0) / 20;
    var cur = vols[vols.length - 1];
    return {
      current: cur, ma5: Math.round(ma5), ma20: Math.round(ma20),
      vs_ma5_pct: ma5 ? Math.round((cur - ma5) / ma5 * 100 * 10) / 10 : null,
      vs_ma20_pct: ma20 ? Math.round((cur - ma20) / ma20 * 100 * 10) / 10 : null,
      trend: cur > ma5 ? '증가' : '감소',
    };
  }
  function highLowPosition(candles, quote) {
    if (!candles.length) return {};
    var current = (quote && quote.price) ? quote.price : candles[candles.length - 1].close;
    var r60 = candles.length >= 60 ? candles.slice(-60) : candles;
    var recentHigh = Math.max.apply(null, r60.map(function (c) { return c.high; }));
    var recentLow = Math.min.apply(null, r60.map(function (c) { return c.low; }));
    var high52, low52;
    if (quote && quote.high_52w && quote.low_52w) { high52 = quote.high_52w; low52 = quote.low_52w; }
    else { var w = candles.length >= 252 ? candles.slice(-252) : candles; high52 = Math.max.apply(null, w.map(function (c) { return c.high; })); low52 = Math.min.apply(null, w.map(function (c) { return c.low; })); }
    return {
      current: current,
      from_60d_high_pct: Math.round((current - recentHigh) / recentHigh * 100 * 100) / 100,
      from_60d_low_pct: Math.round((current - recentLow) / recentLow * 100 * 100) / 100,
      from_52w_high_pct: Math.round((current - high52) / high52 * 100 * 100) / 100,
      from_52w_low_pct: Math.round((current - low52) / low52 * 100 * 100) / 100,
      position_52w_pct: high52 !== low52 ? Math.round((current - low52) / (high52 - low52) * 100 * 10) / 10 : 50,
    };
  }
  function aggregateWeekly(candles) {
    var wk = {};
    candles.forEach(function (c) {
      var dt = new Date(c.date + 'T00:00:00Z');
      var dow = (dt.getUTCDay() + 6) % 7; // Mon=0
      var mon = new Date(dt.getTime() - dow * 86400000);
      var key = mon.toISOString().slice(0, 10);
      if (!wk[key]) wk[key] = { date: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
      else { wk[key].high = Math.max(wk[key].high, c.high); wk[key].low = Math.min(wk[key].low, c.low); wk[key].close = c.close; wk[key].volume += (c.volume || 0); }
    });
    return Object.keys(wk).sort().map(function (k) { return wk[k]; });
  }
  function computeAll(candles, quote) {
    return {
      alignment: movingAlignment(candles), crosses: detectCrosses(candles),
      sr: supportResistance(candles), volume: volumeAnalysis(candles),
      position: highLowPosition(candles, quote), rsi: rsiCurrent(candles), atr: atrCurrent(candles),
      sma: { '5': smaSeries(candles, 5), '20': smaSeries(candles, 20), '60': smaSeries(candles, 60), '120': smaSeries(candles, 120) },
    };
  }

  // ═══════════════ 시그널 (lib/signals.py 이식) ═══════════════
  function evaluate(ind) {
    var alignment = ind.alignment.status, rsi = ind.rsi || 50;
    var volTrend = ind.volume.trend, volVs = ind.volume.vs_ma20_pct || 0;
    var nearestRes = ind.sr.nearest_resistance, strongestSup = ind.sr.strongest_support;
    var current = ind.position.current || 0;
    var distSup = (strongestSup && current) ? Math.round((current - strongestSup) / current * 100 * 100) / 100 : 999;
    var distRes = (nearestRes && current) ? Math.round((nearestRes - current) / current * 100 * 100) / 100 : 999;
    var golden = ind.crosses.golden, dead = ind.crosses.dead;
    var atr = ind.atr || (current * 0.015);
    var score = 0, reasons = [];
    if (alignment === '정배열') { score += 2; reasons.push('이동평균 정배열 (상승 추세)'); }
    else if (alignment === '역배열') { score -= 3; reasons.push('이동평균 역배열 (하락 추세) — 매수 보류'); }
    else reasons.push('이동평균 혼조 — 추세 불명확');
    if (golden && !dead) { score += 1; reasons.push('골든크로스 발생 (' + golden + ') — 단기 상승 전환 신호'); }
    else if (dead && !golden) { score -= 1; reasons.push('데드크로스 발생 (' + dead + ') — 단기 하락 전환 신호'); }
    if (rsi >= 70) { score -= 1; reasons.push('RSI ' + rsi.toFixed(0) + ' — 과열 구간 (단기 조정 가능)'); }
    else if (rsi <= 30) { score += 1; reasons.push('RSI ' + rsi.toFixed(0) + ' — 과매도 구간 (단기 반등 가능)'); }
    else reasons.push('RSI ' + rsi.toFixed(0) + ' — 정상 범위');
    if (volTrend === '증가' && volVs > 20) { score += 1; reasons.push('거래량 20일 평균 대비 증가 — 추세에 힘 실림'); }
    else if (volTrend === '감소') { score -= 0.5; reasons.push('거래량 감소 — 추세 신뢰도 낮음'); }
    if (distSup != null && distSup < 3) { score += 0.5; reasons.push('지지선 근접 (' + distSup.toFixed(1) + '% 위) — 분할 매수 후보'); }
    if (distRes != null && distRes < 3) { score -= 0.5; reasons.push('저항선 근접 (' + distRes.toFixed(1) + '% 아래) — 익절/관망 구간'); }
    var verdict, confidence;
    if (score <= -5 && alignment === '역배열') { verdict = '매도 검토'; confidence = '높음'; }
    else if (alignment === '역배열') { verdict = '관망'; confidence = '높음'; }
    else if (score >= 3) { verdict = '매수 검토'; confidence = '높음'; }
    else if (score >= 1.5) { verdict = '매수 검토'; confidence = '보통'; }
    else if (score <= -2) { verdict = '매도 검토'; confidence = '보통'; }
    else if (score <= -0.5) { verdict = '관망'; confidence = '보통'; }
    else { verdict = '관망'; confidence = '낮음'; }
    var banner = null;
    if (alignment === '역배열') banner = '⛔ 하락 추세 진행 중 — 신규 매수 보류';
    else if (verdict === '매수 검토' && confidence === '높음') banner = '⚡ 매수 시그널: ' + reasons.slice(0, 2).join(', ');
    else if (rsi >= 75) banner = '⚠️ 단기 과열 주의 (RSI ' + rsi.toFixed(0) + ') — 신규 매수 자제';
    var supports = ind.sr.supports || [];
    var entries = supports.length ? supports.slice(0, 4) : [Math.round(current * 0.99)];
    var avgEntry = Math.round(entries.reduce(function (a, b) { return a + b; }, 0) / entries.length);
    var stopLoss = atr ? Math.round(Math.min.apply(null, entries) - atr * 2) : Math.round(Math.min.apply(null, entries) * 0.97);
    var target1 = (nearestRes && nearestRes > avgEntry) ? Math.round(nearestRes) : Math.round(avgEntry * 1.10);
    var aboveT1 = (ind.sr.resistance_meta || []).filter(function (m) { return m.level > target1; });
    var target2 = aboveT1.length ? Math.round(aboveT1.reduce(function (a, b) { return b.score > a.score ? b : a; }).level) : null;
    var risk = avgEntry - stopLoss, reward = target1 - avgEntry;
    var rr = risk > 0 ? Math.round(reward / risk * 100) / 100 : null;
    var scenario = {
      entries: entries, avg_entry: avgEntry, entry: avgEntry, stop_loss: stopLoss,
      target: target1, target2: target2, risk_reward: rr,
      strongest_support: ind.sr.strongest_support, strongest_resistance: ind.sr.strongest_resistance,
      note: verdict === '매수 검토' ? '지지선 분할 매수, 저항선 근처 분할 익절' : '추세 확인 후 분할 진입',
    };
    var trendWord = alignment === '정배열' ? '상승' : (alignment === '역배열' ? '하락' : '횡보');
    var lines = [
      '현재 ' + (CFG.name || '') + '은(는) 이동평균 ' + alignment + ' 상태로 ' + trendWord + ' 추세입니다.',
      'RSI ' + rsi.toFixed(0) + '은(는) ' + (rsi >= 70 ? '과열 구간으로 단기 조정에 주의해야 합니다' : (rsi <= 30 ? '과매도 구간으로 반등 가능성이 있습니다' : '정상 범위입니다')) + '.',
      '거래량은 20일 평균 대비 ' + (volVs >= 0 ? '+' : '') + volVs.toFixed(0) + '%로 ' + (volVs > 0 ? '힘이 실리고 있습니다' : '약해지고 있습니다') + '.',
    ];
    if (strongestSup) {
      var resStr = nearestRes ? (', 저항선은 ' + money(nearestRes) + ' (+' + distRes.toFixed(1) + '%)') : '';
      lines.push('핵심 지지선은 ' + money(strongestSup) + ' (현재가 대비 -' + distSup.toFixed(1) + '%)' + resStr + '입니다.');
    }
    if (rr && rr > 0) lines.push('지지선 균등 분할 매수 시 평단 ' + money(avgEntry) + ' 기준 예상 손익비는 ' + rr.toFixed(2) + ':1입니다. 손절선 ' + money(stopLoss) + ', 1차 목표 ' + money(target1) + '.');
    lines.push('※ 분석 결과이며 투자 권유가 아닙니다. 매매 시 손절선 준수와 분할 진입을 권장합니다.');
    return { verdict: verdict, confidence: confidence, score: Math.round(score * 10) / 10, reasons: reasons, banner: banner, insight: lines.join(' '), scenario: scenario };
  }

  // ═══════════════ 백테스트 (lib/backtest.py 이식) ═══════════════
  function runBacktest(candles, stopPct, tpPct, warmup) {
    stopPct = stopPct || 7.0; tpPct = tpPct || 10.0; warmup = warmup || 30;
    var trades = [], inTrade = false, entryPrice = null, entryDate = null, entryTarget = null, entryStop = null, entryIdx = -1;
    for (var i = warmup; i < candles.length - 1; i++) {
      if (!inTrade) {
        var sub = candles.slice(0, i + 1), ind, sig;
        try { ind = computeAll(sub); sig = evaluate(ind); } catch (e) { continue; }
        if (sig.verdict === '매수 검토') {
          entryIdx = i + 1; entryPrice = candles[i + 1].open; entryDate = candles[i + 1].date;
          var nres = ind.sr.nearest_resistance, atr = ind.atr;
          entryTarget = (nres && nres > entryPrice) ? nres : entryPrice * (1 + tpPct / 100);
          entryStop = atr ? entryPrice - atr * 2 : entryPrice * (1 - stopPct / 100);
          inTrade = true;
        }
      } else {
        if (i <= entryIdx) continue;
        var c = candles[i], exitPrice = null, exitReason = null;
        if (c.low <= entryStop) { exitPrice = entryStop; exitReason = '손절'; }
        else if (c.high >= entryTarget) { exitPrice = entryTarget; exitReason = '익절'; }
        if (exitPrice) {
          var ret = (exitPrice - entryPrice) / entryPrice * 100;
          trades.push({ entry_date: entryDate, exit_date: c.date, entry: entryPrice, exit: exitPrice, return_pct: Math.round(ret * 100) / 100, reason: exitReason });
          inTrade = false;
        }
      }
    }
    if (!trades.length) return { total_trades: 0, win_rate: 0, avg_return_pct: 0, mdd_pct: 0, trades: [] };
    var wins = trades.filter(function (t) { return t.return_pct > 0; }).length;
    var avg = trades.reduce(function (a, t) { return a + t.return_pct; }, 0) / trades.length;
    var equity = 1, peak = 1, mdd = 0;
    trades.forEach(function (t) { equity *= (1 + t.return_pct / 100); if (equity > peak) peak = equity; var dd = (peak - equity) / peak * 100; if (dd > mdd) mdd = dd; });
    return { total_trades: trades.length, win_rate: Math.round(wins / trades.length * 100 * 10) / 10, avg_return_pct: Math.round(avg * 100) / 100, mdd_pct: Math.round(mdd * 100) / 100, trades: trades.slice(-20) };
  }

  // ═══════════════ 오늘의 흐름 (lib/commentary.py 이식) ═══════════════
  function signed(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function buildTimeline(points) {
    var p = points.filter(function (x) { return x.price != null; });
    var n = p.length; if (!n) return [];
    var idxs;
    if (n <= 6) { idxs = []; for (var i = 0; i < n; i++) idxs.push(i); }
    else {
      var hi = 0, lo = 0;
      for (var k = 1; k < n; k++) { if (p[k].price > p[hi].price) hi = k; if (p[k].price < p[lo].price) lo = k; }
      var set = new Set([0, hi, lo, n - 1]); var j = 0;
      while (set.size < 6 && j < n) { set.add(j); j += Math.max(1, Math.floor(n / 6)); }
      idxs = Array.from(set).sort(function (a, b) { return a - b; }).slice(0, 6).sort(function (a, b) { return a - b; });
    }
    return idxs.map(function (i) { return p[i].t + ' ' + money(p[i].price); });
  }
  function volPhrase(ind) {
    var v = ((ind || {}).volume || {}).vs_ma20_pct;
    if (v == null) return '';
    if (v > 20) return ' 거래량은 평소보다 많습니다.';
    if (v < -20) return ' 거래량은 평소보다 다소 적습니다.';
    return ' 거래량은 평소 수준입니다.';
  }
  function genCommentary(points, quote, ind, status) {
    var q = quote || {}, price = q.price, open_ = q.open, chg = q.change_pct;
    points = points || [];
    // 분봉이 비어와도(지수 등) 일봉 시세로 요약을 만든다. 시세 자체가 없을 때만 대기.
    if (price == null) return { mode: 'waiting', title: '오늘의 흐름', body: '시세를 불러오는 중입니다.', timeline: [] };
    var prices = points.filter(function (p) { return p.price != null; }).map(function (p) { return p.price; });
    var dayHigh = q.high || (prices.length ? Math.max.apply(null, prices) : null);
    var dayLow = q.low || (prices.length ? Math.min.apply(null, prices) : null);
    var start = open_ || (points.length ? points[0].price : null);
    var mood = (chg != null && chg > 0) ? '강세 우위' : (chg != null && chg < 0 ? '약세 우위' : '보합권');
    var vol = volPhrase(ind);
    if (status === 'CLOSE') {
      var closeWord = (open_ && price && price > open_) ? '강세 마감' : (open_ && price && price < open_ ? '약세 마감' : '보합 마감');
      var span = (dayHigh && dayLow) ? Math.round((dayHigh - dayLow) / dayLow * 100 * 10) / 10 : null;
      var body = money(start) + '로 출발, 장중 ' + money(dayHigh) + '까지 올랐다 ' + money(price) + '으로 마감';
      if (chg != null) body += '(' + signed(chg) + ')';
      body += '. 시가 대비 ' + closeWord + '입니다. 고점 ' + money(dayHigh) + ' / 저점 ' + money(dayLow);
      if (span != null) body += ', 변동폭 ' + span.toFixed(1) + '%';
      body += '.' + vol;
      return { mode: 'close', title: '✅ 오늘 마감 요약', body: body.trim(), timeline: buildTimeline(points) };
    }
    var b = money(start) + '로 출발해 ';
    if (dayHigh && price && dayHigh > price) b += '장중 ' + money(dayHigh) + '까지 올랐다가 현재 ' + money(price);
    else if (dayLow && price && dayLow < price) b += '장중 ' + money(dayLow) + '까지 밀렸다가 현재 ' + money(price);
    else b += '현재 ' + money(price);
    b += chg != null ? (', 전일 대비 ' + signed(chg) + '로 ' + mood + '입니다') : (', ' + mood + '입니다');
    b += '. 오늘 고점 ' + money(dayHigh) + ' / 저점 ' + money(dayLow) + '.' + vol;
    return { mode: 'live', title: '📡 오늘의 흐름', body: b.trim(), timeline: buildTimeline(points) };
  }

  // ═══════════════ 야후 데이터 ═══════════════
  var PROXIES = [
    function (u) { return 'https://corsproxy.io/?' + encodeURIComponent(u); },
    function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
    function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); },
  ];
  function fetchYahoo(ticker, interval, range, timeout) {
    var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=' + interval + '&range=' + range;
    return PROXIES.reduce(function (chain, make) {
      return chain.then(function (res) {
        if (res) return res;
        var ctrl = new AbortController(); var t = setTimeout(function () { ctrl.abort(); }, timeout || 9000);
        return fetch(make(url), { signal: ctrl.signal }).then(function (r) { clearTimeout(t); return r.ok ? r.json() : null; })
          .then(function (j) { return (j && j.chart && j.chart.result && j.chart.result[0]) ? j.chart.result[0] : null; })
          .catch(function () { clearTimeout(t); return null; });
      });
    }, Promise.resolve(null));
  }
  function toCandles(res) {
    var ts = res.timestamp || [], q = res.indicators.quote[0];
    var out = [];
    for (var i = 0; i < ts.length; i++) {
      if (q.close[i] == null || q.open[i] == null) continue;
      out.push({ date: tzDate(ts[i]), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
    }
    // 같은 날짜 중복(장중 마지막 봉) 제거 — 마지막 값 우선
    var map = {}; out.forEach(function (c) { map[c.date] = c; });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }

  // ═══════════════ 렌더 ═══════════════
  var D = {};
  window._tog = window._tog || { ma5: true, ma20: true, ma60: true, ma120: true, sr: true, vol: true };
  var currentPeriod = '6M', currentType = 'daily';

  function $(id) { return document.getElementById(id); }

  function renderCommentary() {
    var c = D.commentary, card = $('k-commentary-card'); if (!card) return;
    if (!c) { card.style.display = 'none'; return; }
    $('k-commentary-title').textContent = c.title || '오늘의 흐름';
    $('k-commentary-body').textContent = c.body || '';
    var tl = $('k-commentary-timeline');
    if (c.timeline && c.timeline.length) { tl.textContent = c.timeline.join('   ·   '); tl.style.display = ''; }
    else tl.style.display = 'none';
  }
  function renderSignal() {
    var sig = D.signal || {};
    $('k-signal-verdict').textContent = sig.verdict || '–';
    var badge = $('k-signal-badge'); badge.textContent = sig.confidence || '';
    badge.className = 'signal-badge ' + (sig.verdict === '매수 검토' ? 'badge-buy' : sig.verdict === '매도 검토' ? 'badge-sell' : 'badge-watch');
    $('k-signal-reasons').innerHTML = (sig.reasons || []).map(function (r) { return '<li>' + r + '</li>'; }).join('');
    var banner = $('k-banner');
    if (sig.banner) { banner.textContent = sig.banner; banner.className = 'banner ' + (sig.banner.indexOf('매수') !== -1 ? 'banner-buy' : sig.banner.indexOf('⛔') !== -1 ? 'banner-sell' : 'banner-warn'); banner.style.display = ''; }
    else banner.style.display = 'none';
  }
  function renderSignalNote() {
    var noteEl = $('k-signal-bt-note'); if (!noteEl) return;
    var sig = D.signal || {}, bt = D.backtest || {};
    if (sig.verdict === '매수 검토' && bt.total_trades) {
      var neg = bt.avg_return_pct < 0, col = neg ? 'var(--k-gold)' : 'var(--k-green)', bg = neg ? 'rgba(240,180,41,0.12)' : 'rgba(38,166,154,0.1)';
      noteEl.innerHTML = '<div style="margin-top:10px;padding:8px 11px;border-radius:6px;font-size:12px;background:' + bg + ';border:1px solid ' + col + ';color:' + col + '">⚠️ 참고: 이 "매수 검토" 신호대로 과거에 매매했을 때 성적은 ' + bt.total_trades + '회 중 승률 ' + bt.win_rate + '%, 평균 ' + pct(bt.avg_return_pct) + ' 였습니다.' + (neg ? ' 신호만 믿지 말고 분할 진입·손절을 반드시 지키세요.' : '') + '</div>';
    } else noteEl.innerHTML = '';
  }
  function renderTrend() {
    var a = D.indicators.alignment || {}, cr = D.indicators.crosses || {};
    var statusColor = a.status === '정배열' ? 'var(--k-green)' : (a.status === '역배열' ? 'var(--k-red)' : 'var(--k-gold)');
    var rows = [['MA5', a.ma5, a.gap_pct && a.gap_pct.ma5], ['MA20', a.ma20, a.gap_pct && a.gap_pct.ma20], ['MA60', a.ma60, a.gap_pct && a.gap_pct.ma60], ['MA120', a.ma120, a.gap_pct && a.gap_pct.ma120]];
    var cur = (D.indicators.position && D.indicators.position.current) || (D.quote && D.quote.price);
    var order = [{ k: '현재가', v: cur, c: '#58a6ff', strong: true }, { k: 'MA5', v: a.ma5, c: MA_COLORS['5'] }, { k: 'MA20', v: a.ma20, c: MA_COLORS['20'] }, { k: 'MA60', v: a.ma60, c: MA_COLORS['60'] }, { k: 'MA120', v: a.ma120, c: MA_COLORS['120'] }].filter(function (it) { return it.v != null; }).sort(function (x, y) { return y.v - x.v; });
    var strip = '<div style="font-size:11px;color:var(--k-muted);margin-bottom:6px">값이 높은 순 (왼쪽) → 낮은 순 (오른쪽)</div><div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:16px">' +
      order.map(function (it, i) {
        var pill = '<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:14px;background:rgba(127,127,127,0.08);border:1px solid ' + it.c + ';' + (it.strong ? 'font-weight:700;' : '') + '"><span style="width:7px;height:7px;border-radius:50%;background:' + it.c + ';flex-shrink:0"></span><span style="color:' + it.c + '">' + it.k + '</span><span style="color:var(--k-text);font-size:12px">' + money(it.v) + '</span></span>';
        return pill + (i < order.length - 1 ? '<span style="color:var(--k-muted);font-weight:700">›</span>' : '');
      }).join('') + '</div>';
    $('k-trend-content').innerHTML = '<div style="margin-bottom:12px"><span style="font-size:20px;font-weight:700;color:' + statusColor + '">' + (a.status || '–') + '</span>' +
      (cr.golden ? '<span style="margin-left:16px;font-size:12px;color:var(--k-green)">골든크로스 ' + cr.golden + '</span>' : '') +
      (cr.dead ? '<span style="margin-left:16px;font-size:12px;color:var(--k-red)">데드크로스 ' + cr.dead + '</span>' : '') + '</div>' + strip +
      '<table class="data-table"><thead><tr><th>이평선</th><th>현재값</th><th>현재가 대비</th></tr></thead><tbody>' +
      rows.map(function (r) { var g = r[2]; var cls = g == null ? '' : (g > 0 ? 'up' : g < 0 ? 'down' : ''); return '<tr><td>' + r[0] + '</td><td>' + money(r[1]) + '</td><td class="' + cls + '">' + (g == null ? '–' : pct(g)) + '</td></tr>'; }).join('') + '</tbody></table>';
  }
  function renderSR() {
    var sr = D.indicators.sr || {}, strong = sr.strongest_support;
    var metaByLevel = {}; (sr.support_meta || []).forEach(function (m) { metaByLevel[Math.round(m.level)] = m; });
    var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div><div style="color:var(--k-green);font-weight:600;margin-bottom:6px">지지선</div>';
    (sr.supports || []).forEach(function (s, i) {
      var isStrong = strong != null && Math.round(s) === Math.round(strong), m = metaByLevel[Math.round(s)] || {};
      html += '<div style="padding:4px 0;' + (i === 0 ? 'font-weight:700;font-size:15px;' : '') + (isStrong ? 'color:#f7c948;' : '') + '">' + money(s);
      if (i === 0 && sr.dist_to_support_pct) html += ' <span style="color:var(--k-muted);font-size:12px">(-' + sr.dist_to_support_pct + '%)</span>';
      if (isStrong) html += ' <span style="font-size:11px;color:#f7c948">★핵심 지지 (테스트 ' + (m.touches || 0) + '회' + (m.confluence ? ', 이평선 겹침' : '') + ')</span>';
      html += '</div>';
    });
    if (!sr.supports || !sr.supports.length) html += '<span style="color:var(--k-muted)">–</span>';
    html += '</div><div><div style="color:var(--k-red);font-weight:600;margin-bottom:6px">저항선</div>';
    var strongR = sr.strongest_resistance, rMeta = {}; (sr.resistance_meta || []).forEach(function (m) { rMeta[Math.round(m.level)] = m; });
    (sr.resistances || []).forEach(function (r, i) {
      var isStrongR = strongR != null && Math.round(r) === Math.round(strongR), rm = rMeta[Math.round(r)] || {};
      html += '<div style="padding:4px 0;' + (i === 0 ? 'font-weight:700;font-size:15px;' : '') + (isStrongR ? 'color:#f7c948;' : '') + '">' + money(r);
      if (i === 0 && sr.dist_to_resistance_pct != null) html += ' <span style="color:var(--k-muted);font-size:12px">(+' + sr.dist_to_resistance_pct + '%)</span>';
      if (isStrongR) html += ' <span style="font-size:11px;color:#f7c948">★가장 강한 저항 (테스트 ' + (rm.touches || 0) + '회' + (rm.confluence ? ', 이평선 겹침' : '') + ')</span>';
      html += '</div>';
    });
    if (!sr.resistances || !sr.resistances.length) html += '<span style="color:var(--k-muted)">–</span>';
    html += '</div></div>';
    $('k-sr-content').innerHTML = html;
  }
  function renderMomentum() {
    var rsi = D.indicators.rsi, vol = D.indicators.volume || {}, pos = D.indicators.position || {};
    var rsiColor = rsi >= 70 ? 'var(--k-red)' : (rsi <= 30 ? 'var(--k-green)' : 'var(--k-text)');
    var rsiLabel = rsi >= 70 ? '과열' : (rsi <= 30 ? '과매도' : '정상');
    var items = [
      { label: 'RSI (14)', val: (rsi != null ? rsi : '–') + ' <span style="font-size:11px">' + rsiLabel + '</span>', style: 'color:' + rsiColor },
      { label: '거래량 추세', val: vol.trend || '–', cls: vol.trend === '증가' ? 'up' : 'down' },
      { label: 'vs 20일 평균', val: pct(vol.vs_ma20_pct), cls: colorClass(vol.vs_ma20_pct) },
      { label: '60일 고점 대비', val: pct(pos.from_60d_high_pct), cls: 'down' },
      { label: '60일 저점 대비', val: pct(pos.from_60d_low_pct), cls: 'up' },
      { label: '52주 고점 대비', val: pct(pos.from_52w_high_pct), cls: 'down' },
    ];
    $('k-momentum-content').innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">' +
      items.map(function (s) { return '<div class="stat-card"><div class="stat-label">' + s.label + '</div><div class="stat-value ' + (s.cls || '') + '" style="' + (s.style || '') + '">' + s.val + '</div></div>'; }).join('') + '</div>';
  }
  function renderTrades() {
    var candles = (D.candles || []).slice().reverse().slice(0, 20);
    $('k-trades-tbody').innerHTML = candles.map(function (c, i) {
      var prev = candles[i + 1], chg = prev ? (c.close - prev.close) / prev.close * 100 : null;
      return '<tr><td>' + c.date + '</td><td>' + money(c.close) + '</td><td class="' + (chg != null ? colorClass(chg) : '') + '">' + (chg != null ? pct(chg) : '–') + '</td><td>' + fmt(c.volume) + '</td></tr>';
    }).join('');
  }
  function renderInsights() {
    var sig = D.signal || {};
    $('k-insight-text').textContent = sig.insight || '–';
    var sc = sig.scenario || {}, entries = sc.entries || (sc.entry ? [sc.entry] : []);
    var ord = ['1차 진입', '2차 진입', '3차 진입', '4차 진입'];
    var cards = entries.map(function (e, i) { var isStrong = sc.strongest_support != null && Math.round(e) === Math.round(sc.strongest_support); return { label: ord[i] || ((i + 1) + '차 진입'), val: money(e), strong: isStrong }; });
    cards.push({ label: '균등 평단', val: money(sc.avg_entry || sc.entry) });
    cards.push({ label: '추세이탈선(손절)', val: money(sc.stop_loss), cls: 'down' });
    cards.push({ label: '1차 목표 (가까운 저항선)', val: money(sc.target), cls: 'up' });
    cards.push({ label: '2차 목표 (가장 강한 저항선)', val: sc.target2 ? money(sc.target2) : '저항 없음', cls: sc.target2 ? 'up' : '' });
    cards.push({ label: '손익비 (평단 기준)', val: sc.risk_reward ? sc.risk_reward + ':1' : '–' });
    cards.push({ label: '메모', val: sc.note || '–' });
    $('k-scenario-grid').innerHTML = cards.map(function (s) {
      var border = s.strong ? 'border:1px solid #f7c948;' : '', badge = s.strong ? ' <span style="font-size:10px;color:#f7c948">★핵심 지지</span>' : '';
      return '<div class="stat-card" style="' + border + '"><div class="stat-label">' + s.label + badge + '</div><div class="stat-value ' + (s.cls || '') + '">' + s.val + '</div></div>';
    }).join('');
  }
  function renderBacktest() {
    var bt = D.backtest || {};
    $('k-bt-stats').innerHTML = [
      { label: '총 매매 횟수', val: bt.total_trades || 0 },
      { label: '승률', val: (bt.win_rate || 0) + '%' },
      { label: '평균 수익률', val: pct(bt.avg_return_pct), cls: colorClass(bt.avg_return_pct) },
      { label: '최대낙폭(MDD)', val: '-' + (bt.mdd_pct || 0) + '%', cls: 'down' },
    ].map(function (s) { return '<div class="stat-card"><div class="stat-label">' + s.label + '</div><div class="stat-value ' + (s.cls || '') + '">' + s.val + '</div></div>'; }).join('');
    $('k-bt-tbody').innerHTML = (bt.trades || []).slice(-15).reverse().map(function (t) {
      return '<tr><td>' + t.entry_date + '</td><td>' + t.exit_date + '</td><td>' + money(t.entry) + '</td><td>' + money(t.exit) + '</td><td class="' + colorClass(t.return_pct) + '">' + pct(t.return_pct) + '</td><td>' + t.reason + '</td></tr>';
    }).join('');
  }

  // ═══════════════ 차트 (lightweight-charts) ═══════════════
  function getFilteredCandles(period, type) {
    var src = type === 'weekly' ? D.weekly_candles : D.candles;
    if (!src || !src.length) return [];
    if (period === 'ALL') return src;
    var days = { '3M': 90, '6M': 180, '1Y': 365 }[period] || 180;
    var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
    var cutStr = cutoff.toISOString().slice(0, 10);
    return src.filter(function (c) { return c.date >= cutStr; });
  }
  function applyPeriodView(period) {
    if (!window._chartInst) return;
    var ts = window._chartInst.timeScale();
    if (period === 'ALL') { ts.fitContent(); return; }
    var days = { '3M': 90, '6M': 180, '1Y': 365 }[period] || 180;
    var end = new Date(), start = new Date(); start.setDate(start.getDate() - days);
    try { ts.setVisibleRange({ from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }); } catch (e) { ts.fitContent(); }
  }
  function _addSRLines(candle, arr) {
    var sr = D.indicators.sr || {}, GOLD = 'rgba(247,201,72,0.95)', RED = 'rgba(239,83,80,0.9)';
    function add(price, color, title) { if (price == null) return; arr.push(candle.createPriceLine({ price: price, color: color, lineWidth: 2, lineStyle: 2, axisLabelVisible: false, title: title })); }
    add(sr.strongest_support, GOLD, '핵심지지');
    var t1 = sr.nearest_resistance, t2 = (D.signal && D.signal.scenario && D.signal.scenario.target2) || null;
    add(t1, RED, '1차목표');
    if (t2 != null && (t1 == null || Math.round(t2) !== Math.round(t1))) add(t2, GOLD, '2차목표');
  }
  function buildChart(period, type) {
    var container = $('k-chart-container'); if (!container || !window.LightweightCharts) return;
    container.innerHTML = '';
    var popup = $('k-chart-popup'); if (popup) popup.style.display = 'none';
    if (window._chartInst) { try { window._chartInst.remove(); } catch (e) { } window._chartInst = null; }
    if (window._chartResize) { window.removeEventListener('resize', window._chartResize); window._chartResize = null; }
    var allCandles = type === 'weekly' ? D.weekly_candles : D.candles;
    if (!allCandles || !allCandles.length) { container.innerHTML = '<p style="color:var(--k-muted);padding:16px">데이터 없음</p>'; return; }
    var isMobile = window.matchMedia('(max-width: 600px)').matches;
    var gridC = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
    var chart = LightweightCharts.createChart(container, {
      width: container.clientWidth, height: isMobile ? 360 : 440,
      layout: { background: { color: 'transparent' }, textColor: isDark ? '#aeaeb2' : '#24292f', fontSize: isMobile ? 10 : 12 },
      grid: { vertLines: { color: gridC }, horzLines: { color: gridC } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Magnet, vertLine: { color: '#0969da', width: 1, style: 2, labelBackgroundColor: '#0969da' }, horzLine: { color: '#0969da', width: 1, style: 2, labelBackgroundColor: '#0969da' } },
      rightPriceScale: { borderColor: isDark ? '#3a3a3c' : '#d0d7de', minimumWidth: 44, scaleMargins: { top: 0.05, bottom: 0.22 } },
      timeScale: {
        borderColor: isDark ? '#3a3a3c' : '#d0d7de', timeVisible: false, fixLeftEdge: true, fixRightEdge: true, rightOffset: 3,
        tickMarkFormatter: function (time, tType) {
          var y, m, day;
          if (typeof time === 'string') { var p = time.split('-'); y = +p[0]; m = +p[1]; day = +p[2]; }
          else if (typeof time === 'number') { var d = new Date(time * 1000); y = d.getUTCFullYear(); m = d.getUTCMonth() + 1; day = d.getUTCDate(); }
          else { y = time.year; m = time.month; day = time.day; }
          if (tType === 0) return y + '년'; if (tType === 1) return m + '월'; return m + '/' + day;
        }
      },
      handleScale: isMobile ? { axisPressedMouseMove: { time: false, price: false } } : undefined,
      trackingMode: { exitMode: LightweightCharts.TrackingModeExitMode.OnTouchEnd },
    });
    window._chartInst = chart;
    var candleSeries = chart.addCandlestickSeries({
      upColor: '#e53935', downColor: '#1976d2', borderUpColor: '#c62828', borderDownColor: '#1565c0',
      wickUpColor: '#c62828', wickDownColor: '#1565c0', lastValueVisible: true, priceLineVisible: true,
      priceLineColor: '#0969da', priceLineWidth: 1, priceLineStyle: 2, priceFormat: { type: 'price', precision: DEC, minMove: DEC ? Math.pow(10, -DEC) : 1 },
    });
    candleSeries.setData(allCandles.map(function (c) { return { time: c.date, open: c.open, high: c.high, low: c.low, close: c.close }; }));
    var sma = D.indicators.sma || {}, maRefs = {};
    ['5', '20', '60', '120'].forEach(function (p) {
      if (!sma[p] || !sma[p].length) return;
      var s = chart.addLineSeries({ color: MA_COLORS[p], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: window._tog['ma' + p] });
      s.setData(sma[p].map(function (d) { return { time: d.date, value: d.value }; })); maRefs[p] = s;
    });
    var srLines = []; if (window._tog.sr) _addSRLines(candleSeries, srLines);
    var volSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, visible: window._tog.vol });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    volSeries.setData(allCandles.map(function (c) { return { time: c.date, value: c.volume, color: c.close >= c.open ? 'rgba(229,57,53,0.5)' : 'rgba(25,118,210,0.5)' }; }));
    window._chartRefs = { candle: candleSeries, vol: volSeries, srLines: srLines, ma5: maRefs['5'], ma20: maRefs['20'], ma60: maRefs['60'], ma120: maRefs['120'] };
    var dmap = {};
    allCandles.forEach(function (c, i) { dmap[c.date] = { o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, pc: i > 0 ? allCandles[i - 1].close : c.open, pv: i > 0 ? allCandles[i - 1].volume : c.volume, ma: {} }; });
    ['5', '20', '60', '120'].forEach(function (p) { (sma[p] || []).forEach(function (s) { if (dmap[s.date]) dmap[s.date].ma[p] = s.value; }); });
    var DAYS = ['일', '월', '화', '수', '목', '금', '토'], dmapCandle = {};
    allCandles.forEach(function (c) { dmapCandle[c.date] = c; });
    function _timeToKey(time) { if (typeof time === 'string') return time; if (time && time.year) return time.year + '-' + ('0' + time.month).slice(-2) + '-' + ('0' + time.day).slice(-2); return null; }
    function renderPopupForCandle(c, pointX) {
      if (!c) return false;
      var d = dmap[c.date] || {}, pc = d.pc || c.open, pv = d.pv || 1, upC = '#ef5350', dnC = '#1976d2';
      function chgCol(v, ref) { return v >= ref ? upC : dnC; }
      function chgStr(v, ref) { var p = ((v - ref) / ref * 100); return (p >= 0 ? '+' : '') + p.toFixed(2) + '%'; }
      var dt = new Date(c.date);
      $('k-pp-date').textContent = c.date.replace(/-/g, '.') + '(' + DAYS[dt.getDay()] + ')';
      var rows = [['종', c.close, pc], ['시', c.open, pc], ['고', c.high, pc], ['저', c.low, pc], ['거래량', c.volume, pv]];
      $('k-pp-ohlcv').innerHTML = rows.map(function (r) { var col = chgCol(r[1], r[2]); var isVol = r[0] === '거래량'; return '<tr><td>' + r[0] + '</td><td style="color:' + col + '">' + (isVol ? fmt(r[1]) : money(r[1])) + '</td><td style="color:' + col + '">' + chgStr(r[1], r[2]) + '</td></tr>'; }).join('');
      var maRows = [['5', '이평 5'], ['20', '이평 20'], ['60', '이평 60'], ['120', '이평 120']];
      $('k-pp-ma').innerHTML = maRows.map(function (r) { var v = d.ma && d.ma[r[0]]; if (!v) return ''; var col = chgCol(v, pc); return '<tr><td style="color:#57606a;width:52px">' + r[1] + '</td><td style="text-align:right;padding-right:6px;font-weight:600;color:' + col + '">' + money(v) + '</td><td style="text-align:right;font-size:11px;color:' + col + '">' + chgStr(v, pc) + '</td></tr>'; }).join('');
      var popW = Math.min(224, container.clientWidth - 12), cw = container.clientWidth, x = pointX == null ? 20 : pointX;
      popup.style.left = (x + 20 + popW < cw ? x + 20 : Math.max(4, x - popW - 10)) + 'px'; popup.style.top = '16px'; popup.style.display = 'block';
      return true;
    }
    chart.subscribeClick(function (param) {
      if (!popup || isMobile) return;
      if (popup.style.display === 'block') { popup.style.display = 'none'; return; }
      if (!param || !param.time || !param.point) { popup.style.display = 'none'; return; }
      renderPopupForCandle(dmapCandle[_timeToKey(param.time)], param.point.x);
    });
    if (isMobile) {
      var lpTimer = null, scrubbing = false, sx = 0, sy = 0, LONG_MS = 350, MOVE_TOL = 12;
      function scrubToClientX(clientX) {
        var rect = container.getBoundingClientRect(), x = clientX - rect.left, logical = chart.timeScale().coordinateToLogical(x);
        if (logical == null) return;
        var idx = Math.max(0, Math.min(allCandles.length - 1, Math.round(logical))), c = allCandles[idx];
        try { chart.setCrosshairPosition(c.close, c.date, candleSeries); } catch (e) { }
        renderPopupForCandle(c, x);
      }
      function endScrub() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } if (scrubbing) { scrubbing = false; chart.applyOptions({ handleScroll: true }); try { chart.clearCrosshairPosition(); } catch (e) { } popup.style.display = 'none'; } }
      container.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) { endScrub(); return; }
        var t = e.touches[0]; sx = t.clientX; sy = t.clientY; if (lpTimer) clearTimeout(lpTimer);
        lpTimer = setTimeout(function () { scrubbing = true; chart.applyOptions({ handleScroll: false }); if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { } } scrubToClientX(sx); }, LONG_MS);
      }, { passive: true });
      container.addEventListener('touchmove', function (e) {
        var t = e.touches[0]; if (!t) return;
        if (!scrubbing) { if (Math.abs(t.clientX - sx) > MOVE_TOL || Math.abs(t.clientY - sy) > MOVE_TOL) { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } } return; }
        e.preventDefault(); scrubToClientX(t.clientX);
      }, { passive: false });
      container.addEventListener('touchend', endScrub, { passive: true });
      container.addEventListener('touchcancel', endScrub, { passive: true });
    }
    applyPeriodView(period);
    window._chartResize = function () { chart.applyOptions({ width: container.clientWidth }); };
    window.addEventListener('resize', window._chartResize);
  }
  window.setChartPeriod = function (p, btn) {
    currentPeriod = p;
    document.querySelectorAll('#kodex-analysis .chart-controls .btn').forEach(function (b) { if (['3개월', '6개월', '1년', '전체'].indexOf(b.textContent) !== -1) b.classList.remove('active'); });
    if (btn) btn.classList.add('active'); applyPeriodView(p);
  };
  window.setChartType = function (t, btn) {
    currentType = t;
    document.querySelectorAll('#kodex-analysis .chart-controls .btn').forEach(function (b) { if (['일봉', '주봉'].indexOf(b.textContent) !== -1) b.classList.remove('active'); });
    if (btn) btn.classList.add('active'); buildChart(currentPeriod, currentType);
  };
  window.toggleOverlay = function (key) {
    window._tog[key] = !window._tog[key];
    var btn = document.querySelector('#kodex-analysis .tgl[data-k="' + key + '"]'); if (btn) btn.classList.toggle('on', window._tog[key]);
    var refs = window._chartRefs || {};
    if (key === 'vol') { if (refs.vol) refs.vol.applyOptions({ visible: window._tog.vol }); }
    else if (key === 'sr') { (refs.srLines || []).forEach(function (pl) { try { refs.candle.removePriceLine(pl); } catch (e) { } }); refs.srLines = []; if (window._tog.sr) _addSRLines(refs.candle, refs.srLines); }
    else { var p = key.replace('ma', ''); if (refs['ma' + p]) refs['ma' + p].applyOptions({ visible: window._tog[key] }); }
  };

  // ═══════════════ 부트스트랩 ═══════════════
  function quoteFromRes(res, candles) {
    var m = res.meta || {};
    var last = candles[candles.length - 1] || {};
    // 전일 종가 = 직전 거래일 봉의 종가 (장기 range에서 meta.chartPreviousClose는 range 시작 직전값이라 부정확)
    var prev = candles.length >= 2 ? candles[candles.length - 2].close : (m.chartPreviousClose || last.close);
    // 마지막 봉이 '오늘'이면 라이브가, 아니면(주말·휴장) 마지막 봉 종가를 현재가로
    var lastIsToday = last.date === tzDate(Date.now() / 1000);
    var price = (lastIsToday && m.regularMarketPrice != null) ? m.regularMarketPrice : (last.close != null ? last.close : m.regularMarketPrice);
    return {
      price: price,
      open: (lastIsToday && m.regularMarketOpen) || last.open, high: (lastIsToday && m.regularMarketDayHigh) || last.high, low: (lastIsToday && m.regularMarketDayLow) || last.low,
      volume: (lastIsToday && m.regularMarketVolume) || last.volume, change: price != null && prev != null ? price - prev : null,
      change_pct: prev ? (price - prev) / prev * 100 : null, high_52w: m.fiftyTwoWeekHigh, low_52w: m.fiftyTwoWeekLow, prev: prev,
    };
  }
  function intradayPoints(res, prev) {
    if (!res || !res.timestamp) return [];
    var ts = res.timestamp, q = res.indicators.quote[0], out = [];
    for (var i = 0; i < ts.length; i++) {
      var p = q.close[i]; if (p == null) continue;
      out.push({ t: tzHM(ts[i]), price: p, change_pct: prev ? (p - prev) / prev * 100 : null });
    }
    return out;
  }

  function run() {
    if (!window.LightweightCharts) { console.warn('[차트분석] lightweight-charts 미로딩'); }
    fetchYahoo(CFG.ticker, '1d', '5y', 10000).then(function (res) {
      if (!res || !res.timestamp) { var el = $('k-chart-container'); if (el) el.innerHTML = '<p style="color:var(--k-muted);padding:16px">차트 데이터를 불러오지 못했어요. 잠시 후 새로고침 해주세요.</p>'; return; }
      var candles = toCandles(res);
      if (candles.length < 30) { var el2 = $('k-chart-container'); if (el2) el2.innerHTML = '<p style="color:var(--k-muted);padding:16px">데이터 부족</p>'; return; }
      var quote = quoteFromRes(res, candles);
      D.candles = candles;
      D.weekly_candles = aggregateWeekly(candles);
      D.quote = quote;
      D.indicators = computeAll(candles, quote);
      D.signal = evaluate(D.indicators);
      D.commentary = genCommentary([], quote, D.indicators, marketStatus()); // 분봉 도착 전 임시
      // 즉시 렌더 (무거운 백테스트 제외)
      renderSignal(); renderTrend(); renderSR(); renderMomentum(); renderTrades(); renderInsights(); renderCommentary();
      buildChart(currentPeriod, currentType);
      // 오늘의 흐름: 분봉으로 타임라인 보강
      fetchYahoo(CFG.ticker, '1m', '1d', 8000).then(function (ires) {
        var pts = intradayPoints(ires, quote.prev);
        D.commentary = genCommentary(pts, quote, D.indicators, marketStatus());
        renderCommentary();
      }).catch(function () { });
      // 백테스트: 화면 그린 뒤 백그라운드로 (무거움)
      setTimeout(function () {
        try { D.backtest = runBacktest(candles); renderBacktest(); renderSignalNote(); } catch (e) { console.warn('[백테스트]', e); }
      }, 60);
    }).catch(function (e) { console.warn('[차트분석] 실패', e); });
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', function () { setTimeout(run, 200); });
  else setTimeout(run, 200);
  // 장중 5분마다 오늘의 흐름 갱신
  setInterval(function () {
    if (!D.quote) return;
    fetchYahoo(CFG.ticker, '1m', '1d', 8000).then(function (ires) {
      var pts = intradayPoints(ires, D.quote.prev);
      D.commentary = genCommentary(pts, D.quote, D.indicators, marketStatus());
      renderCommentary();
    }).catch(function () { });
  }, 5 * 60 * 1000);
})();
