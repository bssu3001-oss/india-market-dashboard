/* ──────────────────────────────────────────────────────────────
   실시간.js — 인도 증시 대시보드
   페이지 열 때마다 차트 과거추이·기술지표·뉴스신호를 실시간 갱신.
   원칙: 어떤 호출이 실패해도 화면이 깨지거나 빈칸이 되지 않고
        직전 값/정적값을 그대로 유지한다.
   ────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── 여러 CORS 프록시를 순서대로 시도 (하나 막혀도 다음으로) ──
  const PROXIES = [
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ];

  async function proxyText(url, timeoutMs) {
    for (const make of PROXIES) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
        const r = await fetch(make(url), { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) continue;
        const txt = await r.text();
        if (txt && txt.length > 0) return txt;
      } catch (e) { /* 다음 프록시 시도 */ }
    }
    return null;
  }

  async function proxyJSON(url, timeoutMs) {
    const txt = await proxyText(url, timeoutMs);
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
  }

  // 영문 → 한국어 번역 (구글 번역, 브라우저 직접 호출 OK)
  async function translateKo(text) {
    if (!text) return text;
    try {
      const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t&q=' + encodeURIComponent(text));
      if (!r.ok) return text;
      const j = await r.json();
      const out = (j[0] || []).map((x) => x[0]).join('');
      return out || text;
    } catch (e) { return text; }
  }

  // 대시보드 시장 설명 (AI 질문/뉴스 분석에 공통 사용)
  const MARKET_DESC = '인도 증시(Nifty 50·Sensex)';

  // ── 야후 차트 1구간 가져와서 {labels, prices} 로 변환 ──
  async function fetchRange(ticker, interval, range, labelMode) {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
    const j = await proxyJSON(url, 9000);
    try {
      const res = j.chart.result[0];
      const ts = res.timestamp || [];
      const closes = res.indicators.quote[0].close || [];
      const labels = [], prices = [];
      for (let i = 0; i < ts.length; i++) {
        if (closes[i] == null) continue;
        const dt = new Date(ts[i] * 1000);
        let lab;
        if (labelMode === 'time') {
          lab = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        } else {
          lab = (dt.getMonth() + 1) + '/' + dt.getDate();
        }
        labels.push(lab);
        prices.push(+closes[i].toFixed(2));
      }
      if (prices.length < 2) return null;
      return { labels, prices, meta: res.meta };
    } catch (e) { return null; }
  }

  // 구간 정의 (대시보드 탭과 1:1)
  const RANGE_DEFS = [
    { key: 'd1',  interval: '1d',  range: '5d', mode: 'date' },
    { key: 'd5',  interval: '1d',  range: '5d', mode: 'date' },
    { key: 'd30', interval: '1d',  range: '1mo', mode: 'date' },
    { key: 'mo3', interval: '1d',  range: '3mo', mode: 'date' },
    { key: 'mo6', interval: '1wk', range: '6mo', mode: 'date' },
    { key: 'yr1', interval: '1wk', range: '1y', mode: 'date' },
  ];

  // ── 차트 한 개를 실시간 데이터로 갱신 ──
  async function refreshChart(canvasId, ticker) {
    const c = window._charts && window._charts[canvasId];
    if (!c) return null;
    let lastMeta = null;
    const tasks = RANGE_DEFS.map(async (d) => {
      const got = await fetchRange(ticker, d.interval, d.range, d.mode);
      if (got) {
        c.data[d.key] = { labels: got.labels, prices: got.prices };
        if (d.key === 'yr1' && got.meta) lastMeta = got.meta;
      }
    });
    await Promise.allSettled(tasks);
    // 현재 활성 탭(기본 d1) 다시 그림
    try {
      const tabsId = canvasId.replace('chart', '').toLowerCase();
      const activeIdx = findActivePeriod(tabsId);
      const key = activeIdx || 'd1';
      if (c.data[key] && typeof makeDatasets === 'function') {
        c.inst.data.labels = c.data[key].labels;
        c.inst.data.datasets = makeDatasets(c.data[key].prices, key, c.data.name, c.data.color);
        c.inst.update();
      }
    } catch (e) { /* 차트 갱신 실패해도 기존 차트 유지 */ }
    return lastMeta;
  }

  function findActivePeriod(prefix) {
    // period-tab 의 onclick 에서 키를 추출 (switchChart('chartNifty','nifty','d30',this))
    const tabs = document.querySelectorAll(`#${prefix}-tabs .period-tab.active`);
    if (!tabs.length) return null;
    const oc = tabs[0].getAttribute('onclick') || '';
    const m = oc.match(/'(d1|d5|d30|mo3|mo6|yr1)'/);
    return m ? m[1] : null;
  }

  // ── 기술적 지표 계산 (주봉 yr1 기반) ──
  function setBadge(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'badge ' + cls;
  }

  function calcRSI(prices, n) {
    if (prices.length < n + 1) return null;
    let gain = 0, loss = 0;
    for (let i = prices.length - n; i < prices.length; i++) {
      const diff = prices[i] - prices[i - 1];
      if (diff >= 0) gain += diff; else loss -= diff;
    }
    if (loss === 0) return 100;
    const rs = (gain / n) / (loss / n);
    return 100 - 100 / (1 + rs);
  }

  function sma(prices, n) {
    if (prices.length < n) return null;
    const s = prices.slice(prices.length - n);
    return s.reduce((a, b) => a + b, 0) / n;
  }

  function updateTechnicals(meta, weeklyPrices) {
    if (!weeklyPrices || weeklyPrices.length < 6) return;
    const cur = weeklyPrices[weeklyPrices.length - 1];

    // RSI (14주)
    const rsi = calcRSI(weeklyPrices, 14);
    if (rsi != null) {
      let lbl, cls;
      if (rsi >= 75) { lbl = '과열'; cls = 'badge-r'; }
      else if (rsi >= 55) { lbl = '중립'; cls = 'badge-b'; }
      else if (rsi >= 45) { lbl = '중립'; cls = 'badge-b'; }
      else if (rsi >= 30) { lbl = '약세'; cls = 'badge-y'; }
      else { lbl = '과매도 — 반등 기대'; cls = 'badge-g'; }
      setBadge('badge-rsi', `RSI ${rsi.toFixed(1)} — ${lbl}`, cls);
    }

    // 이평선 배열 (MA5 / MA13 / MA26 주봉)
    const ma5 = sma(weeklyPrices, 5), ma13 = sma(weeklyPrices, 13), ma26 = sma(weeklyPrices, 26);
    if (ma5 != null && ma13 != null && ma26 != null) {
      let lbl, cls;
      if (cur > ma5 && ma5 > ma13 && ma13 > ma26)      { lbl = '정배열(상승)'; cls = 'badge-g'; }
      else if (cur < ma5 && ma5 < ma13 && ma13 < ma26) { lbl = '역배열(하락)'; cls = 'badge-r'; }
      else if (cur > ma5 && cur > ma13)                 { lbl = '단기 상승';    cls = 'badge-y'; }
      else if (cur < ma5 && cur < ma13)                 { lbl = '단기 하락';    cls = 'badge-y'; }
      else                                               { lbl = '혼조';        cls = 'badge-y'; }
      setBadge('badge-ma', lbl, cls);
    }

    // 단기 모멘텀 (4주 변화)
    if (weeklyPrices.length >= 5) {
      const past = weeklyPrices[weeklyPrices.length - 5];
      const mom = (cur - past) / past * 100;
      const arrow = mom >= 0 ? '▲' : '▼';
      let cls;
      if (mom >= 2) cls = 'badge-g'; else if (mom <= -2) cls = 'badge-r'; else cls = 'badge-y';
      setBadge('tech-mom', `${arrow} ${Math.abs(mom).toFixed(1)}% (4주)`, cls);
    }

    // 52주 가격 위치
    let hi = meta && meta.fiftyTwoWeekHigh, lo = meta && meta.fiftyTwoWeekLow;
    if (!hi || !lo) { hi = Math.max(...weeklyPrices); lo = Math.min(...weeklyPrices); }
    if (hi && lo && hi > lo) {
      const fromHi = (cur - hi) / hi * 100;
      const fromLo = (cur - lo) / lo * 100;
      const pos = (cur - lo) / (hi - lo);
      let cls;
      if (pos < 0.5) cls = 'badge-g'; else if (pos > 0.85) cls = 'badge-y'; else cls = 'badge-b';
      setBadge('tech-pos', `고점 대비 ${fromHi.toFixed(1)}% / 저점 대비 +${fromLo.toFixed(1)}%`, cls);
    }
  }

  // ── 뉴스 신호 AI 분류 (Anthropic 키 있을 때만) ──
  function getAnthropicKey() { return localStorage.getItem('anthropic_api_key') || ''; }

  const NEWS_TOPICS = {
    fii:     'India FII foreign institutional investor flows',
    rbi:     'RBI Reserve Bank India interest rate decision',
    trade:   'India US trade deal tariff',
    china:   'India China relations economy',
    cpi:     'India CPI inflation',
    gdp:     'India GDP growth',
    it:      'India IT manufacturing electronics export',
    rupee:   'India rupee USD INR exchange rate',
    mideast: 'Middle East geopolitics oil price',
  };

  async function fetchHeadlines(query) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en&gl=US&ceid=US:en`;
    const xml = await proxyText(url, 6000);
    if (!xml) return [];
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      return [...doc.querySelectorAll('item')].slice(0, 3)
        .map((it) => (it.querySelector('title')?.textContent || '').split(' - ')[0].trim())
        .filter(Boolean);
    } catch (e) { return []; }
  }

  async function updateNewsSignals() {
    const key = getAnthropicKey();
    if (!key) {
      // 키 없으면 정적값 유지 + 작은 안내 (한 번만)
      const note = document.getElementById('news-live-note');
      if (note) note.textContent = '🔑 AI 키 입력 시 뉴스 신호가 실시간 갱신됩니다';
      return;
    }
    // 실제로 불러온 주요 뉴스(번역본)를 근거로 분석
    const items = window.__majorNewsItems || [];
    const newsBlock = items.slice(0, 8).map((n) => '- ' + (n.title || n.ko)).join('\n');
    if (!newsBlock) return; // 뉴스 못 가져오면 정적 유지

    const sys = '당신은 인도 증시 뉴스 분석가입니다. 주어진 헤드라인을 보고 각 항목을 평가하세요. 반드시 JSON만 출력합니다.';
    const prompt = `아래는 오늘 인도 증시 관련 실제 헤드라인입니다.\n${newsBlock}\n\n이 뉴스들을 근거로 각 항목(fii=외국인자금, rbi=금리, trade=미국무역, china=중국관계, cpi=물가, gdp=성장, it=IT/제조, rupee=루피, mideast=중동/유가)에 대해 한국어 12자 이내 label 과 인도 증시 영향 sentiment(good=호재, bad=악재, neutral=중립)를 매기세요. 관련 뉴스가 없으면 neutral.\n다음 형식의 JSON만 출력:\n{"fii":{"label":"...","sentiment":"good|bad|neutral"}, "rbi":{...}, "trade":{...}, "china":{...}, "cpi":{...}, "gdp":{...}, "it":{...}, "rupee":{...}, "mideast":{...}}`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 700, system: sys, messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await r.json();
      const text = d.content?.[0]?.text || '';
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return;
      const obj = JSON.parse(m[0]);
      const sentCls = { good: 'badge-g', bad: 'badge-r', neutral: 'badge-y' };
      for (const [k, v] of Object.entries(obj)) {
        if (!v || !v.label) continue;
        setBadge('news-' + k, v.label, sentCls[v.sentiment] || 'badge-y');
      }
      const note = document.getElementById('news-live-note');
      if (note) note.textContent = '✓ 뉴스 신호 방금 갱신됨';
    } catch (e) { /* 실패 시 정적 유지 */ }
  }

  // ── AI 차트 분석 카드를 실시간 지표로 다시 작성 (AI 불필요·항상 일치) ──
  function buildAnalysis(name, weekly, d5, meta, scale) {
    const el = document.getElementById('ai-chart-analysis');
    if (!el || !weekly || weekly.length < 14) return;
    const cur = weekly[weekly.length - 1];
    let pct = null;
    if (d5 && d5.length >= 2) pct = (d5[d5.length - 1] - d5[d5.length - 2]) / d5[d5.length - 2] * 100;
    const rsi = calcRSI(weekly, 14);
    const ma5 = sma(weekly, 5), ma13 = sma(weekly, 13), ma26 = sma(weekly, 26);
    let maState = '혼조';
    if (cur > ma5 && ma5 > ma13 && ma13 > ma26)      maState = '정배열(상승)';
    else if (cur < ma5 && ma5 < ma13 && ma13 < ma26) maState = '역배열(하락)';
    else if (cur > ma5 && cur > ma13)                 maState = '단기 상승';
    else if (cur < ma5 && cur < ma13)                 maState = '단기 하락';
    const mom = (cur - weekly[weekly.length - 5]) / weekly[weekly.length - 5] * 100;
    let std = 0;
    const rets = [];
    for (let i = weekly.length - 12; i < weekly.length; i++) rets.push((weekly[i] - weekly[i - 1]) / weekly[i - 1] * 100);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
    let hi = meta && meta.fiftyTwoWeekHigh, lo = meta && meta.fiftyTwoWeekLow;
    if (scale) { if (hi) hi *= scale; if (lo) lo *= scale; }
    if (!hi || !lo) { hi = Math.max(...weekly); lo = Math.min(...weekly); }
    const fromHi = (cur - hi) / hi * 100, fromLo = (cur - lo) / lo * 100;
    const posRatio = (cur - lo) / (hi - lo);
    const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
    const rsiLvl = rsi >= 70 ? '과열권' : rsi >= 55 ? '중립대 상단' : rsi >= 45 ? '중립' : rsi >= 30 ? '약세' : '과매도권';
    const momLvl = mom >= 2 ? '견조한 상승 동력' : mom >= 0 ? '약한 상승 힘' : mom > -2 ? '약한 하락 압력' : '뚜렷한 하락 압력';
    const volLvl = std < 1 ? '낮은' : std < 2 ? '보통' : '높은';
    const posLvl = posRatio < 0.4 ? '저점 부근' : posRatio > 0.8 ? '고점 부근' : '중간값 근처';
    let concl;
    if (maState.indexOf('정배열') >= 0 && mom > 0) concl = '추세·모멘텀이 우호적이라 분할 매수를 고려할 만합니다.';
    else if (maState.indexOf('역배열') >= 0) concl = '추세가 약해 신규 진입보다 반등 확인 후 대응이 바람직합니다.';
    else concl = '방향성이 불명확해 의미 있는 신호 전까지 관망이 최선입니다.';
    const fmt = (n) => Math.round(n).toLocaleString('ko-KR');
    const issueLine = (window.__majorNewsItems && window.__majorNewsItems.length)
      ? `• <strong>주요 이슈</strong>: ${window.__majorNewsItems.slice(0, 2).map((n) => n.ko || n.title).join(' / ')}<br><br>` : '';
    el.innerHTML =
      `# ${name} 주간 차트 분석 (${today})<br><br>` +
      issueLine +
      `• <strong>현재 지수</strong>: ${fmt(cur)}${pct != null ? ` — 전일 대비 ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : ''}<br><br>` +
      `• <strong>추세 (이평)</strong>: 5주·13주·26주 이평 기준 <strong>${maState}</strong>${maState === '혼조' ? ' — 방향성 불명확' : ''}<br><br>` +
      `• <strong>모멘텀</strong>: RSI ${rsi.toFixed(1)} (${rsiLvl}), 4주 모멘텀 ${mom >= 0 ? '+' : ''}${mom.toFixed(1)}% — ${momLvl}<br><br>` +
      `• <strong>변동성</strong>: 주간 ±${std.toFixed(2)}%로 ${volLvl} 수준<br><br>` +
      `• <strong>위치</strong>: 52주 고점(${fmt(hi)}) 대비 ${fromHi.toFixed(1)}%, 저점(${fmt(lo)}) 대비 +${fromLo.toFixed(1)}% — ${posLvl}<br><br>` +
      `• <strong>한 줄 결론</strong>: ${concl}<br><br>` +
      `<span style="color:var(--text3);font-size:11px;">* 열 때마다 실시간 지표로 자동 작성됩니다</span>`;
  }

  // ── 📰 주요 뉴스 (제목+링크, 열 때마다 실시간) ──
  // 한국어 구글뉴스 — 국내 언론사가 발행한 인도 관련 뉴스
  const NEWS_FEEDS = [
    { url: 'https://news.google.com/rss/search?q=인도+증시&hl=ko&gl=KR&ceid=KR:ko', source: '구글뉴스', isKo: true },
    { url: 'https://news.google.com/rss/search?q=인도+경제+투자&hl=ko&gl=KR&ceid=KR:ko', source: '구글뉴스', isKo: true },
  ];

  function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() / 1000 - ts;
    if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + '분 전';
    if (diff < 86400) return Math.round(diff / 3600) + '시간 전';
    return Math.round(diff / 86400) + '일 전';
  }

  async function fetchNewsItems() {
    const sets = await Promise.all(NEWS_FEEDS.map(async (f) => {
      try {
        const parseXml = (xml) => {
          const doc = new DOMParser().parseFromString(xml, 'text/xml');
          return [...doc.querySelectorAll('item')].slice(0, 12).map((item) => {
            const g = (tag) => item.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
            const title = g('title'); const link = g('link') || g('guid'); const pubDate = g('pubDate');
            return { title, link, source: f.source, isKo: !!f.isKo, ts: pubDate ? (new Date(pubDate).getTime() || 0) / 1000 : 0 };
          }).filter((x) => x.title && x.link.startsWith('http'));
        };
        const parseRss = (d) => (d.items || []).slice(0, 12).map((it) => ({
          title: (it.title || '').trim(), link: (it.link || it.guid || '').trim(),
          source: f.source, isKo: !!f.isKo, ts: it.pubDate ? (new Date(it.pubDate).getTime() || 0) / 1000 : 0,
        })).filter((x) => x.title && x.link.startsWith('http'));
        // proxyText와 rss2json 동시 시작 — 먼저 데이터가 오는 쪽 사용
        const items = await new Promise((resolve) => {
          let done = false; let pending = 2;
          const tryResolve = (r) => { if (!done && r.length) { done = true; resolve(r); } if (--pending === 0 && !done) resolve([]); };
          proxyText(f.url, 10000).then(xml => tryResolve(xml ? parseXml(xml) : [])).catch(() => tryResolve([]));
          fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(f.url)}`, { signal: AbortSignal.timeout(10000) })
            .then(r => r.ok ? r.json() : null).then(d => tryResolve(d ? parseRss(d) : [])).catch(() => tryResolve([]));
        });
        return items;
      } catch (e) { return []; }
    }));
    // 인도 증시와 무관한 기사 제거 (한국 증시 우위 비교 기사 등)
    const EXCLUDE = ['한국 증시', '한국이 인도', '인도 제치', '코스피', '코스닥', '삼성전자', '한국 주식'];
    const all = [], seen = new Set();
    sets.forEach((s) => s.forEach((n) => {
      const t = n.title;
      if (EXCLUDE.some((kw) => t.includes(kw))) return;
      const k = t.toLowerCase().slice(0, 60);
      if (seen.has(k)) return;
      seen.add(k); all.push(n);
    }));
    all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return all.slice(0, 8);
  }

  function ensureNewsCard() {
    if (document.getElementById('major-news')) return;
    const anchor = document.querySelector('.section-label') || document.querySelector('.nifty-header');
    if (!anchor || !anchor.parentNode) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div class="card-title">📰 주요 뉴스 <span style="font-size:11px;font-weight:400;color:var(--text3);">— 실시간 · 인도 시장</span></div><div id="major-news"><div style="font-size:12px;color:var(--text3);">뉴스 불러오는 중…</div></div>';
    anchor.parentNode.insertBefore(card, anchor);
  }

  async function renderMajorNews() {
    ensureNewsCard();
    const box = document.getElementById('major-news');
    if (!box) return;
    const items = await fetchNewsItems();
    if (!items.length) { box.innerHTML = '<div style="font-size:12px;color:var(--text3);">뉴스를 불러오지 못했어요 (잠시 후 새로고침)</div>'; return; }
    // 한국어 피드는 번역 생략, 영문만 번역
    const kos = await Promise.all(items.map((n) => n.isKo ? n.title : translateKo(n.title)));
    items.forEach((n, i) => { n.ko = (kos[i] || n.title).trim(); });
    // 전역 저장 (AI 차트분석·액션가이드·AI질문·뉴스신호에서 재사용)
    window.__majorNewsItems = items;
    window.__majorNews = items.slice(0, 6).map((n) => '• ' + n.ko).join('\n');
    box.innerHTML = items.map((n) => {
      const ko = (n.ko || n.title).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const meta = [n.source, relTime(n.ts)].filter(Boolean).join(' · ');
      const ageDay = n.ts ? (Date.now()/1000 - n.ts) / 86400 : 0;
      const dimStyle = ageDay > 7 ? 'opacity:0.4;' : '';
      return `<a href="${n.link}" target="_blank" rel="noopener" style="display:block;padding:9px 0;border-bottom:0.5px solid var(--border);text-decoration:none;color:var(--text);${dimStyle}"><div style="font-size:13px;line-height:1.45;">${ko}</div><div style="font-size:11px;color:var(--text3);margin-top:3px;">${meta} ↗</div></a>`;
    }).join('');
  }

  // ── 한국어 뉴스 키워드로 뉴스 배지 자동 분류 (API 키 불필요) ──
  function updateNewsBadgesFromKorean() {
    const items = (window.__majorNewsItems || []).length
      ? (window.__majorNewsItems || [])
      : (window.__newsForAnalysis || []).map(t => ({ ko: t, title: t }));
    if (!items.length) return;
    const all = items.map(n => (n.ko || n.title || '')).join(' ');

    const relKw = {
      'badge-rbi':   ['rbi','금리','기준금리','긴축','완화','피벗','통화정책','인도중앙은행'],
      'badge-cpi':   ['물가','cpi','인플레','소비자물가','인플레이션'],
      'badge-gdp':   ['gdp','성장률','경제성장','경기','성장'],
      'badge-fed':   ['연준','fed','파월','fomc','달러','금리'],
      'badge-trade': ['무역','관세','tariff','수출','수입','통상'],
      'badge-geo':   ['전쟁','분쟁','지정학','휴전','군사','파키스탄','중국'],
    };
    function cleanTitle2(t) { return (t||'').replace(/\[.*?\]\s*/,'').replace(/\s*[-–]\s*\S+$/, '').trim(); }
    function trimTitle2(t) { return t.length > 30 ? t.slice(0, 30) + '…' : t; }
    const latestHeadline = items.length ? trimTitle2(cleanTitle2(items[0].ko || items[0].title || '')) : null;

    function findRelatedHeadline(searchKws) {
      for (const kw of searchKws) {
        const found = items.find(n => (n.ko || n.title || '').toLowerCase().includes(kw.toLowerCase()));
        if (found) {
          const title = (found.ko || found.title || '').replace(/\[.*?\]\s*/,'').replace(/\s*[-–]\s*\S+$/, '').trim();
          return title.length > 30 ? title.slice(0, 30) + '…' : title;
        }
      }
      return null;
    }
    function ko(id, gKw, rKw, gT, rT, nT, dT) {
      const isG = gKw.some(k => all.includes(k));
      const isR = rKw.some(k => all.includes(k));
      let cls, text;
      if      (isG && !isR) { cls = 'badge-g'; text = gT; }
      else if (isR && !isG) { cls = 'badge-r'; text = rT; }
      else if (isG && isR)  { cls = 'badge-y'; text = nT; }
      else if (dT) { cls = 'badge-y'; text = dT; }
      else { return; }
      const el = document.getElementById(id);
      if (el) { el.textContent = text; el.className = 'badge ' + cls; }
    }

    // badge-fii는 INDA ETF 등락 기반으로 index.html에서 직접 설정

    ko('badge-rbi',
      ['금리 인하','완화','RBI 인하','인하 기대','통화 완화','피벗','RBI 동결'],
      ['금리 인상','긴축','RBI 인상','인상 우려','매파','RBI 긴축'],
      'RBI 완화(호재)', 'RBI 긴축(악재)', 'RBI 혼조', 'RBI 정책 관망');

    ko('badge-cpi',
      ['물가 안정','인플레 완화','물가 하락','물가 둔화','CPI 하락','디스인플레','인플레 둔화'],
      ['물가 상승','인플레 급등','물가 급등','CPI 상승','인플레 우려','인플레이션 심화'],
      '물가 안정(호재)', '물가 상승(악재)', '물가 혼조', '물가 혼조');

    ko('badge-gdp',
      ['GDP 성장','경제성장','성장률 상승','경기 호조','성장 가속','경기 반등','경제 회복'],
      ['GDP 둔화','성장 둔화','경기 침체','성장률 하락','경기 부진','경기 위축'],
      'GDP 성장(호재)', 'GDP 둔화(악재)', 'GDP 혼조', 'GDP 혼조');

    ko('badge-fed',
      ['연준 인하','금리 인하','파월 완화','연준 완화','연준 피벗','dovish'],
      ['연준 인상','연준 긴축','파월 매파','Fed 긴축','금리 동결 우려','hawkish'],
      '연준 완화(호재)', '연준 긴축(악재)', '연준 불확실', '연준 불확실');

    ko('badge-trade',
      ['무역 협상','관세 완화','무역 합의','미-인도 협정','수출 증가','관세 면제','무역 타결'],
      ['관세 부과','무역 갈등','무역 제재','수출 감소','관세 위협','관세 인상'],
      '무역 호조(호재)', '무역 리스크(악재)', '무역 혼조', '무역 주시');

    ko('badge-geo',
      ['지정학 완화','중동 평화','리스크 해소','긴장 완화','분쟁 해소','휴전'],
      ['지정학 리스크','중동 긴장','전쟁','분쟁 확대','지정학 위기','군사 충돌'],
      '지정학 안정(호재)', '지정학 리스크(악재)', '지정학 혼조', '지정학 주시');

    const note = document.getElementById('news-live-note');
    if (note) note.textContent = '✓ 최신 뉴스 기반 자동 분류 (API 키 불필요)';

    // 배지 갱신 후 종합신호 재계산
    if (typeof recalcScorecard === 'function') recalcScorecard();
    if (typeof applyAnalysis === 'function' && typeof ruleBasedAnalysis === 'function' && typeof _liveData !== 'undefined') {
      if (!getAnthropicKey()) applyAnalysis(ruleBasedAnalysis(_liveData));
    }
  }

  // ── 매크로 배지 AI 분류 (Claude API) ──
  async function updateMacroBadgesAI() {
    const key = getAnthropicKey();
    if (!key) return;
    const items = window.__majorNewsItems || [];
    const newsBlock = items.slice(0, 8).map(n => '- ' + (n.ko || n.title)).join('\n');
    if (!newsBlock) return;

    const sys = '당신은 인도 증시 뉴스 분석가입니다. 주어진 헤드라인을 보고 각 항목을 평가하세요. 반드시 JSON만 출력합니다.';
    const prompt = `아래는 오늘 인도 증시 관련 실제 헤드라인입니다.\n${newsBlock}\n\n이 뉴스들을 근거로 각 항목에 대해 한국어 10자 이내 label 과 sentiment(good/bad/neutral)를 매기세요.\n항목: rbi=RBI금리정책, cpi=인도물가, gdp=인도경제성장, fed=미국연준금리, trade=미-인도무역, geo=지정학리스크\n\n규칙:\n- 뉴스에 직접 언급된 항목: 내용 반영한 구체적 label (예: "RBI 6.25% 동결", "물가 안정세", "방산 수출 호조")\n- 언급 안 된 항목도 반드시 현재 시장 맥락에 맞는 label을 써주세요 (예: "RBI 정책 관망", "CPI 발표 대기", "연준 동결 유지", "지정학 안정세")\n- "관련뉴스없음" 같은 표현은 절대 사용 금지\n다음 형식의 JSON만 출력:\n{"rbi":{"label":"...","sentiment":"good|bad|neutral"},"cpi":{...},"gdp":{...},"fed":{...},"trade":{...},"geo":{...}}`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, system: sys, messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await r.json();
      const text = d.content?.[0]?.text || '';
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return;
      const obj = JSON.parse(m[0]);
      const sentCls = { good: 'badge-g', bad: 'badge-r', neutral: 'badge-y' };
      const idMap = { rbi: 'badge-rbi', cpi: 'badge-cpi', gdp: 'badge-gdp', fed: 'badge-fed', trade: 'badge-trade', geo: 'badge-geo' };
      for (const [k, v] of Object.entries(obj)) {
        if (!v || !v.label) continue;
        const label = v.label.trim();
        if (!label || label.includes('없음')) continue;
        const el = document.getElementById(idMap[k]);
        if (el) { el.textContent = label; el.className = 'badge ' + (sentCls[v.sentiment] || 'badge-y'); }
      }
      const note = document.getElementById('news-live-note');
      if (note) note.textContent = '✓ AI 뉴스 신호 방금 갱신됨';
    } catch (e) { /* 실패 시 키워드 분류 유지 */ }
  }

  // ── 매크로 신호 섹션에 뉴스 이슈 리스트 렌더링 ──
  function renderMacroNews() {
    const box = document.getElementById('macro-news-list');
    if (!box) return;
    const items = window.__majorNewsItems || [];
    if (!items.length) { box.innerHTML = '<div style="font-size:12px;color:var(--text3);">뉴스를 불러오지 못했어요</div>'; return; }
    // 제목 정리: 접두어·출처 제거, 50자 이내로 압축
    function clean(t) {
      return (t||'').replace(/\[.*?\]\s*/g,'').replace(/\s*[-–—]\s*[\w가-힣]+\s*$/,'').trim().slice(0,60);
    }
    box.innerHTML = items.slice(0,5).map((n) => {
      const title = clean(n.ko || n.title);
      const time = relTime(n.ts);
      return `<a href="${n.link}" target="_blank" rel="noopener" style="display:flex;align-items:flex-start;gap:6px;padding:7px 0;border-bottom:0.5px solid var(--border);text-decoration:none;color:var(--text);">
        <span style="font-size:14px;margin-top:1px;">•</span>
        <span>
          <span style="font-size:12.5px;line-height:1.5;">${title.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</span>
          ${time ? '<span style="display:block;font-size:10.5px;color:var(--text3);margin-top:2px;">' + time + ' ↗</span>' : ''}
        </span>
      </a>`;
    }).join('');
  }

  // 인라인 액션가이드가 쓰는 fetchLatestNews 를 우리 뉴스(한국어)로 교체 → 액션가이드에 반영
  window.fetchLatestNews = async function () {
    const items = window.__majorNewsItems || [];
    if (!items.length) return {};
    return { '주요 뉴스': items.slice(0, 6).map((n) => n.ko || n.title) };
  };

  // ── 전체 실행 ──
  // 시장데이터.json 로드 → 배지·종합신호 즉시 표시 (live API가 오면 자동 덮어씌움)
  async function loadCachedMarketData() {
    try {
      const res = await fetch('시장데이터.json?t=' + Date.now());
      if (!res.ok) return;
      const d = await res.json();
      if (!d || !d.nifty) return;

      // 종합신호 즉시 표시
      const scEmoji = document.getElementById('sc-emoji');
      const scPct   = document.getElementById('sc-pct');
      if (scEmoji) scEmoji.textContent = (d.score_emoji || '') + ' ' + (d.score_label || '');
      if (scPct)   scPct.textContent   = (d.score_pct || 0) + '점';

      // 기술지표 배지 — ma_signal 기준
      function setB(id, cls, txt) {
        const el = document.getElementById(id);
        if (!el) return;
        // 캐시는 아직 로딩 중인 배지만 채움 → 라이브/정규화 값을 덮어쓰지 않음
        if (!(el.classList.contains('badge-b') || /로딩/.test(el.textContent))) return;
        el.className = 'badge ' + cls;
        el.textContent = txt;
      }
      const ma = d.ma_signal || '';
      setB('badge-ma', ma.includes('정배열') ? 'badge-g' : ma.includes('역배열') ? 'badge-r' : 'badge-y',
           ma.includes('정배열') ? '정배열(상승)' : ma.includes('역배열') ? '역배열(하락)' : '혼조');

      const rsi = d.rsi || 50;
      setB('badge-rsi', rsi <= 40 ? 'badge-g' : rsi >= 70 ? 'badge-r' : 'badge-y',
           rsi <= 40 ? `RSI ${rsi} 과매도` : rsi >= 70 ? `RSI ${rsi} 과매수` : `RSI ${rsi} 중립`);

      const mom = d.mom4 || 0;
      setB('badge-mom', mom >= 2 ? 'badge-g' : mom <= -2 ? 'badge-r' : 'badge-y',
           mom >= 2 ? `모멘텀 +${mom}%` : mom <= -2 ? `모멘텀 ${mom}%` : `모멘텀 보합`);

      const fhi = d.from_hi || 0;
      setB('badge-pos', fhi <= -20 ? 'badge-g' : fhi >= -3 ? 'badge-r' : 'badge-y',
           fhi <= -20 ? `고점대비 ${fhi}% 저점권` : fhi >= -3 ? `고점 근접 ${fhi}%` : `고점대비 ${fhi}%`);

      // 매크로 배지 — India VIX, USD/INR, 유가
      const vix_i = d.india_vix || 0;
      if (vix_i) setB('badge-indiavix', vix_i < 15 ? 'badge-g' : vix_i > 22 ? 'badge-r' : 'badge-y',
           `India VIX ${vix_i} — ${vix_i < 15 ? '안정' : vix_i > 22 ? '공포' : '주의'}`);

      const usdinr = d.usdinr || 0;
      if (usdinr) setB('badge-usdinr', usdinr < 88 ? 'badge-g' : usdinr > 93 ? 'badge-r' : 'badge-y',
           `₹${usdinr}`);

      const crude = d.crude || 0;
      if (crude) setB('badge-crude', crude < 75 ? 'badge-g' : crude > 85 ? 'badge-r' : 'badge-y',
           `유가 $${crude}`);

      try { if (typeof recalcScorecard === 'function') recalcScorecard(); } catch(e) {}
      console.log('[시장데이터] 캐시 로드 완료:', d.updated);
    } catch(e) {
      console.log('[시장데이터] 캐시 없음 (처음 실행이거나 아직 생성 전)');
    }
  }

  async function runRealtime() {
    // 캐시된 데이터로 즉시 초기 표시
    await loadCachedMarketData();

    let niftyMeta = null;
    try {
      niftyMeta = await refreshChart('chartNifty', '%5ENSEI');
      await refreshChart('chartSensex', '%5EBSESN');
    } catch (e) { /* 차트 실패해도 계속 */ }

    // 주요 뉴스 먼저 (번역·전역저장) → 이후 분석/신호에서 반영
    try { await renderMajorNews(); } catch (e) {}

    // 매크로 신호 섹션 이슈 리스트 업데이트
    try { renderMacroNews(); } catch (e) {}

    // 한국어 뉴스로 뉴스 배지 자동 분류 (API 키 불필요)
    try { updateNewsBadgesFromKorean(); } catch (e) {}
    // AI 키 있으면 매크로 배지를 AI로 더 구체적으로 갱신
    try { await updateMacroBadgesAI(); } catch (e) {}

    // 기술지표 + AI 차트분석 — 주봉 직접 fetch (window._charts 의존 제거)
    try {
      const url1y = 'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1wk&range=1y';
      const j1y = await proxyJSON(url1y, 9000);
      if (j1y && j1y.chart && j1y.chart.result && j1y.chart.result[0]) {
        const res1y = j1y.chart.result[0];
        const weekly = (res1y.indicators.quote[0].close || []).filter(p => p != null);
        if (!niftyMeta) niftyMeta = res1y.meta;
        if (weekly.length >= 6) {
          updateTechnicals(niftyMeta, weekly);
          const url5d = 'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=5d';
          const j5d = await proxyJSON(url5d, 6000);
          const d5prices = (j5d && j5d.chart && j5d.chart.result && j5d.chart.result[0])
            ? (j5d.chart.result[0].indicators.quote[0].close || []).filter(p => p != null)
            : null;
          buildAnalysis('Nifty 50', weekly, d5prices, niftyMeta, 1);
        }
      }
    } catch (e) {}

    // 종합 신호 재계산 + 매수 타이밍 가이드 동기화
    try { if (typeof recalcScorecard === 'function') recalcScorecard(); } catch (e) {}
    try { if (typeof buildChecklist === 'function') buildChecklist(); } catch (e) {}

    // 최종 분석 — 1초 대기 후 덮어쓰기 (모든 배지 업데이트 완료 후)
    try {
      await new Promise(r => setTimeout(r, 1000));
      if (typeof recalcScorecard === 'function') recalcScorecard();
      if (typeof buildChecklist === 'function') buildChecklist();
      if (typeof applyAnalysis === 'function' && typeof ruleBasedAnalysis === 'function' && typeof _liveData !== 'undefined') {
        if (!getAnthropicKey()) applyAnalysis(ruleBasedAnalysis(_liveData));
      }
    } catch (e) {}

    // 액션가이드 재생성 (뉴스 반영, AI 키 있을 때)
    try { if (typeof window.updateActionGuide === 'function' && getAnthropicKey()) window.updateActionGuide(); } catch (e) {}
  }

  // ── AI 질문: 현재 지표 + 오늘의 뉴스를 반영해 답변 (인라인 askAI 덮어씀) ──
  window.askAI = async function () {
    const qEl = document.getElementById('ai-q');
    const box = document.getElementById('ai-resp');
    if (!qEl || !box) return;
    const q = (qEl.value || '').trim();
    if (!q) return;
    const key = getAnthropicKey();
    if (!key) {
      const ks = document.getElementById('key-setup');
      if (ks) ks.style.display = 'block';
      box.textContent = 'API 키를 먼저 입력해주세요.';
      return;
    }
    box.textContent = '분석 중...';
    const price = (document.querySelector('.nifty-price')?.textContent || '').trim();
    const sc = ((document.getElementById('sc-emoji')?.textContent || '') + ' ' + (document.getElementById('sc-pct')?.textContent || '')).trim();
    const signals = [...document.querySelectorAll('.signal-row')].slice(0, 20)
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
    const news = window.__majorNews || '';
    const ctx = `당신은 ${MARKET_DESC} 전문 애널리스트입니다. 아래 실시간 데이터와 오늘의 뉴스를 근거로 한국어로 간결하고 구체적으로 답하세요. 마지막에 "본 답변은 참고용입니다"를 덧붙이세요.\n\n[현재 지수] ${price}\n[종합신호] ${sc}\n[지표·신호]\n${signals}` + (news ? `\n\n[오늘의 주요 뉴스]\n${news}` : '');
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 700, system: ctx, messages: [{ role: 'user', content: q }] }),
      });
      const d = await r.json();
      if (d.content && d.content[0] && d.content[0].text) box.textContent = d.content[0].text;
      else box.textContent = '오류: ' + JSON.stringify(d.error || d);
    } catch (e) { box.textContent = '네트워크 오류: ' + e.message; }
  };

  // 페이지의 인라인 스크립트(차트 생성)가 끝난 뒤 실행
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => setTimeout(runRealtime, 300));
  } else {
    setTimeout(runRealtime, 300);
  }
  // 5분마다 재갱신
  setInterval(runRealtime, 5 * 60 * 1000);
})();
