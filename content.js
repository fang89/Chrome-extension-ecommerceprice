// Ecommerce Price Checker — a coloured panel docked on the right of product pages of Shopee SG, Amazon.sg, Amazon.com, Lazada SG and PDD.
// Reads the item on the page you're on (title, shown price, image), searches the OTHER stores for the
// same item, colours the panel by the answer (green = cheaper elsewhere, orange = this page is cheapest), lists
// every store's results under it, and puts a matching badge under the page's own price.
//  - Amazon / Lazada: fetched by the background worker and parsed here.
//  - Shopee / PDD: read from a background tab using your own logged-in session (both render with JS behind a login).
//  - PDD is searched in Chinese (auto-translated, editable) and ordered by sales.
// Only listings that match the item count; the rest sit behind "show N other results".
(() => {
  if (window.__spcLoaded) return;
  window.__spcLoaded = true;

  const LIMIT = 4;                    // results shown per store
  const MATCH_MIN = 0.6;              // token-overlap needed to count as "same item"
  const ACCESSORY_RATIO = 0.35;       // a "match" under 35% of this page's price is probably a case/cable
  const STOP = new Set(('ready stock sg seller local singapore free shipping delivery instock in stock new hot sale ' +
    'original authentic genuine cod warranty year years month months official store promo offer best cheapest ' +
    'gift free fast high quality premium 2023 2024 2025 2026 brand ship ships day days the for and with of a an ' +
    'set pcs pc piece pieces vs').split(' '));

  let usdSgd = 1.29, cnySgd = 0.193;
  const zhOf = new Map();             // English keywords → Chinese (for searching PDD)
  const cache = new Map();

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const meta = p => $(`meta[property="${p}"],meta[name="${p}"]`)?.content || '';
  const money = v => v == null || isNaN(v) ? '—' : 'S$' + v.toFixed(2);
  const send = msg => new Promise(res => chrome.runtime.sendMessage(msg, r => res(r || { ok: false, error: chrome.runtime.lastError?.message })));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // links come from other sites' pages: only ever use http(s) ones as an href
  const href = u => /^https?:\/\//i.test(u || '') ? esc(u) : '#';
  const fxReady = send({ type: 'fx' }).then(r => { if (r?.rate) usdSgd = r.rate; if (r?.cny) cnySgd = r.cny; });

  function parsePrice(text, defaultCur) {
    if (text == null) return null;
    const t = String(text);
    const n = parseFloat(t.replace(/,/g, '').match(/\d+(\.\d+)?/)?.[0]);
    if (isNaN(n)) return null;
    let cur = defaultCur;
    if (/S\$|SGD/i.test(t)) cur = 'SGD';
    else if (/US\$|USD/i.test(t)) cur = 'USD';
    else if (/[¥￥]|CNY|RMB/i.test(t)) cur = 'CNY';
    return cur === 'USD' ? n * usdSgd : cur === 'CNY' ? n * cnySgd : n;
  }

  function cleanTitle(title) {
    const words = title
      .replace(/【[^】]*】|\[[^\]]*\]|「[^」]*」|〔[^〕]*〕/g, ' ')
      .replace(/[\p{Extended_Pictographic}☀-➿]/gu, ' ')
      .replace(/[|/\\,;:+*#~!?()（）]/g, ' ')
      .split(/\s+/)
      .filter(w => w && !STOP.has(w.toLowerCase()) && !/^[-–—.]+$/.test(w));
    return words.slice(0, 8).join(' ');
  }

  const tokens = s => (s.toLowerCase().match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g) || []).filter(w => w.length >= 2 && !STOP.has(w));

  // score = fraction of query tokens found in the result title (model numbers count double).
  // core = the result also has every "identity" token: the first 3 keywords (brand + model name)
  // and every token with a digit (3S, 256GB, A15) — so "MX Anywhere 3S" is not a match for "MX Master 3S".
  function matchScore(query, title) {
    const q = [...new Set(tokens(query))];
    if (!q.length) return { score: 0, core: false };
    const t = ' ' + tokens(title).join(' ') + ' ';
    const t2 = t.replace(/ /g, '');
    const has = w => t.includes(' ' + w + ' ') || (w.length >= 3 && t2.includes(w));
    let got = 0, tot = 0, core = true;
    q.forEach((w, i) => {
      const digit = /\d/.test(w), wt = digit ? 2 : 1, hit = has(w);
      tot += wt; if (hit) got += wt;
      if ((i < 3 || digit) && !hit) core = false;
    });
    // keyword-stuffed listings ("MX Anywhere 3S ... for Mac Master") contain every word but not the model name
    // as a phrase: also require keywords 2+3 next to each other ("mx master", "iphone 15").
    if (q.length >= 3 && !t2.includes(q[1] + q[2])) core = false;
    return { score: got / tot, core };
  }

  // PDD titles are Chinese: score = share of the translated keywords' character pairs (and any
  // Latin words / model numbers in the translation) found in the title. Model numbers are required.
  function matchZh(q, title) {
    const zh = zhOf.get(q) || '';
    const t = title.toLowerCase();
    const flat = t.replace(/\s+/g, '');
    const parts = [];
    for (const seg of zh.split(/[^一-鿿]+/)) for (let i = 0; i + 1 < seg.length; i++) parts.push(seg.slice(i, i + 2));
    const latin = [...new Set([...tokens(zh), ...tokens(q).filter(w => /\d/.test(w))])];
    let got = 0, core = true;
    for (const g of parts) if (t.includes(g)) got++;
    for (const w of latin) { if (flat.includes(w)) got++; else if (/\d/.test(w)) core = false; }
    const tot = parts.length + latin.length;
    const score = tot ? got / tot : 0;
    return { score, core: core && score >= 0.5 };
  }

  // ---------- reading the product on THIS page ----------
  function fromLdJson() {
    let title = '', price = null, image = '';
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent);
        for (const o of [].concat(j['@graph'] || j)) {
          if (o && o['@type'] === 'Product') {
            title = o.name || title;
            image = [].concat(o.image || [])[0] || image;
            const of = [].concat(o.offers || [])[0];
            price = parseFloat(of?.lowPrice ?? of?.price) || price;
          }
        }
      } catch (e) {}
    }
    return { title, price, image };
  }

  // The price the shopper actually sees (respects the selected variation): the biggest price-looking text on the page.
  // Checks whole elements, so "¥" "12" ".9" split across spans still reads as one price.
  function biggestPrice(re) {
    let best = null, bestSize = 0, bestEl = null;
    for (const el of document.body.querySelectorAll('span,div,p,strong,b,em,ins,h2,h3')) {
      if (el.childElementCount > 4 || host.contains(el)) continue;
      const txt = el.textContent.trim();
      if (txt.length > 16 || !re.test(txt) || !el.offsetParent) continue;
      let size = parseFloat(getComputedStyle(el).fontSize) || 0;
      for (const c of el.children) size = Math.max(size, parseFloat(getComputedStyle(c).fontSize) || 0);
      if (size > bestSize) { bestSize = size; best = txt; bestEl = el; }
    }
    priceAnchor = priceEl = bestSize >= 16 ? bestEl : null;
    return bestSize >= 16 ? best : null;
  }

  function readGeneric(suffixRe) {
    const ld = fromLdJson();
    const title = ld.title || $('h1')?.textContent || meta('og:title') || document.title.replace(suffixRe, '');
    const shown = biggestPrice(/^S?\$\s?[\d,]+(\.\d{1,2})?$/);
    priceCur = 'SGD';
    return {
      title: title.replace(/\s+/g, ' ').trim(),
      price: shown ? parsePrice(shown, 'SGD') : ld.price,
      image: ld.image || meta('og:image'),
    };
  }

  function readAmazon(cur) {
    const title = $('#productTitle')?.textContent || meta('og:title') || document.title;
    const priceEl = $(['#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen',
      '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen',
      '#apex_desktop .a-price:not(.a-text-price) .a-offscreen', '#price_inside_buybox', '#priceblock_ourprice',
      '#priceblock_dealprice', '.a-price:not(.a-text-price) .a-offscreen'].join(','));
    priceAnchor = priceEl ? (priceEl.closest('.a-price') || priceEl).parentElement : null;
    setPriceEl(priceEl, cur);
    const img = $('#landingImage, #imgBlkFront');
    return {
      title: title.replace(/\s+/g, ' ').trim(),
      price: parsePrice(priceEl?.textContent, cur),
      image: img?.getAttribute('data-old-hires') || img?.src || meta('og:image'),
    };
  }

  function readPdd() {
    const title = meta('og:title') || document.title.replace(/\s*[-_|–]?\s*拼多多.*$/, '');
    const shown = biggestPrice(/^[¥￥]\s?[\d,]+(\.\d{1,2})?\s*(起)?$/);
    priceCur = 'CNY';
    const big = [...document.images].find(i => i.naturalWidth >= 300);
    return { title: title.replace(/\s+/g, ' ').trim(), price: shown ? parsePrice(shown, 'CNY') : null, image: meta('og:image') || big?.src || '' };
  }

  const amazonKey = () => location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/)?.[1] || null;
  const SITES = {
    'shopee.sg': {
      id: 'shopee', name: 'Shopee',
      key: () => { const m = location.pathname.match(/-i\.(\d+)\.(\d+)/) || location.pathname.match(/\/product\/(\d+)\/(\d+)/); return m ? m[1] + '.' + m[2] : null; },
      read: () => readGeneric(/\s*\|\s*Shopee.*$/i),
    },
    'www.amazon.sg': { id: 'amzsg', name: 'Amazon.sg', key: amazonKey, read: () => readAmazon('SGD') },
    'www.amazon.com': { id: 'amzcom', name: 'Amazon.com', key: amazonKey, read: () => readAmazon('USD') },
    'www.lazada.sg': {
      id: 'lazada', name: 'Lazada',
      key: () => location.pathname.match(/-i(\d+)(?:-s\d+)?\.html/)?.[1] || null,
      read: () => readGeneric(/\s*\|\s*Lazada.*$/i),
    },
    'mobile.yangkeduo.com': {
      id: 'pdd', name: 'PDD', zh: true,
      key: () => /goods\d*\.html/.test(location.pathname) ? new URLSearchParams(location.search).get('goods_id') : null,
      read: readPdd,
    },
  };
  const SITE = SITES[location.host];
  if (!SITE) return;

  // ---------- stores we search ----------
  const PDD_URL = zh => `https://mobile.yangkeduo.com/search_result.html?search_key=${encodeURIComponent(zh)}&sort=_sales`;
  const SHOPEE_URL = q => `https://shopee.sg/search?keyword=${encodeURIComponent(q)}`;
  const ALL_STORES = [
    {
      id: 'shopee', name: 'Shopee',
      url: SHOPEE_URL,
      search: q => scrape(SHOPEE_URL(q), 'Shopee', 'https://shopee.sg/buyer/login', 'SGD', 'shopee'),
    },
    {
      id: 'amzsg', name: 'Amazon.sg', host: 'www.amazon.sg',
      url: q => `https://www.amazon.sg/s?k=${encodeURIComponent(q)}`,
      parse: (r) => parseAmazon(r, 'www.amazon.sg', 'SGD'),
    },
    {
      id: 'amzcom', name: 'Amazon.com', host: 'www.amazon.com', note: 'ships to SG, before shipping/GST',
      url: q => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
      parse: (r) => parseAmazon(r, 'www.amazon.com', 'USD'),
    },
    {
      id: 'lazada', name: 'Lazada', host: 'www.lazada.sg',
      url: q => `https://www.lazada.sg/catalog/?q=${encodeURIComponent(q)}`,
      fetchUrl: q => `https://www.lazada.sg/catalog/?ajax=true&q=${encodeURIComponent(q)}`,
      parse: parseLazada,
    },
    {
      // sort=_sales = PDD's 销量 (sales) order; the panel also re-sorts by the sales count it reads
      id: 'pdd', name: 'PDD', note: '¥ → S$, China price, + forwarding to SG',
      url: q => PDD_URL(zhOf.get(q) || q),
      match: matchZh,
      sortBy: 'sales',
      search: async q => {
        if (!zhOf.has(q)) zhOf.set(q, (await send({ type: 'translate', text: q, to: 'zh-CN' })).text || q);
        return scrape(PDD_URL(zhOf.get(q)), 'PDD', 'https://mobile.yangkeduo.com/login.html', 'CNY', 'pdd');
      },
    },
  ];
  const STORES = ALL_STORES.filter(s => s.id !== SITE.id);
  const searchesPdd = STORES.some(s => s.id === 'pdd');

  class StoreError extends Error { constructor(msg, link, linkText) { super(msg); this.link = link; this.linkText = linkText; } }

  async function scrape(url, name, loginUrl, cur, kind) {
    const r = await send({ type: 'scrape', url, kind });
    if (r.login) throw new StoreError(`Log in to ${name} once in this browser, then search again.`, loginUrl, `Log in to ${name} ↗`);
    if (r.blocked) throw new StoreError(`${name} asked for a verification. Solve it once, then search again.`, url, `Open ${name} ↗`);
    if (!r.ok) {
      if (r.debug) console.warn('[price-checker]', name, 'read nothing', r.debug);
      throw new StoreError(r.empty ? `${name} loaded but no listings could be read.` : (r.error || `${name} failed`), url, `Open ${name} ↗`);
    }
    return r.items.map(x => ({
      ...x, price: cur === 'CNY' ? x.price * cnySgd : x.price, sales: parseSales(x.extra),
      extra: [cur === 'CNY' ? (x.priceText || '').replace(/\s+/g, '') : '', x.extra].filter(Boolean).join(' · '),
    }));
  }

  // "已拼1.2万+件" / "总售10万+" / "1.2k sold" → 12000 / 100000 / 1200
  function parseSales(t) {
    const m = String(t || '').match(/([\d.]+)\s*(万|千|k|w)?\+?\s*件?/i);
    if (!m || !/拼|售|sold/i.test(t)) return 0;
    const mult = { '万': 1e4, w: 1e4, W: 1e4, '千': 1e3, k: 1e3, K: 1e3 }[m[2]] || 1;
    return parseFloat(m[1]) * mult;
  }

  const LINKS = [
    { name: 'Google Lens', url: (_q, img) => img ? `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(img)}` : null, note: 'image search: finds the same photo anywhere', image: true },
    { name: 'Google Shopping', url: q => `https://www.google.com.sg/search?tbm=shop&q=${encodeURIComponent(q)}` },
  ];

  // textContent glues "Logitech" + "MX Master" into "LogitechMX Master"; join the text nodes with spaces instead
  function spacedText(el) {
    if (!el) return '';
    const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT), out = [];
    while (w.nextNode()) out.push(w.currentNode.nodeValue);
    return out.join(' ');
  }

  function parseAmazon(r, host, cur) {
    if (/captcha|Robot Check|api-services-support@amazon/i.test(r.text.slice(0, 20000)) && !/s-search-result/.test(r.text))
      throw new Error('Amazon asked for a captcha — open the search once in a tab, then retry');
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    const out = [];
    for (const el of doc.querySelectorAll('[data-component-type="s-search-result"]')) {
      const asin = el.getAttribute('data-asin');
      if (!asin) continue;
      const img = el.querySelector('img.s-image');
      const title = (spacedText(el.querySelector('[data-cy="title-recipe"]')) || img?.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      const priceTxt = el.querySelector('.a-price:not(.a-text-price) .a-offscreen')?.textContent;
      const price = parsePrice(priceTxt, cur);
      if (!title || price == null) continue;
      out.push({
        title, price, img: img?.getAttribute('src'),
        link: `https://${host}/dp/${asin}`,
        ad: !!el.querySelector('.puis-sponsored-label-text, .s-sponsored-label-text, [aria-label="Sponsored"]'),
        extra: el.querySelector('[aria-label*="out of 5 stars"]')?.getAttribute('aria-label')?.replace(/ out of 5 stars.*/, '★') || '',
      });
    }
    return out;
  }

  function parseLazada(r) {
    let j;
    try { j = JSON.parse(r.text); } catch (e) { throw new Error('Lazada showed a slider check — open the search once in a tab, then retry'); }
    return (j?.mods?.listItems || []).map(x => ({
      title: x.name, price: parseFloat(x.price), img: x.image,
      link: x.itemUrl?.startsWith('//') ? 'https:' + x.itemUrl : x.itemUrl,
      extra: [x.ratingScore ? (+x.ratingScore).toFixed(1) + '★' : '', x.itemSoldCntShow || '', x.location || ''].filter(Boolean).join(' · '),
    })).filter(x => x.title && !isNaN(x.price));
  }

  async function searchStore(store, q) {
    const k = store.id + '|' + q;
    if (cache.has(k)) return cache.get(k);
    const p = (async () => {
      if (store.search) return store.search(q);
      const r = await send({ type: 'fetch', url: (store.fetchUrl || store.url)(q) });
      if (!r.ok) throw new Error(r.status ? `HTTP ${r.status} — try the link` : (r.error || 'network error'));
      // Amazon.com geo-redirects some sessions to Amazon.sg; don't pass those off as .com listings
      const got = r.url && new URL(r.url).host;
      if (store.host && got && got !== store.host) throw new Error(`${store.name} redirected to ${got}, so there are no separate results`);
      return store.parse(r);
    })();
    cache.set(k, p);
    p.catch(() => cache.delete(k));
    return p;
  }

  // ---------- overlay ----------
  // A full-height panel docked on the right (green = cheaper elsewhere, orange = this page is cheapest,
  // grey = searching) with every store's results under the answer, a badge right under this page's own price,
  // and the toolbar icon badge. view: 'open' (the panel) | 'slim' (a thin coloured strip; narrow windows start here)
  const PANEL_W = 380, SLIM_W = 46;
  let state = { key: null, product: null, query: '', view: innerWidth < 1000 ? 'slim' : 'open', results: {}, showAll: {} };
  let priceAnchor = null;             // where the badge goes: the block showing this page's price (set by the readers)
  let priceEl = null, priceCur = 'SGD'; // the element whose text IS the price
  function setPriceEl(el, cur) { priceEl = el; priceCur = cur; }
  let lastKind = 'wait', lastToolbar = null;

  const host = document.createElement('div');
  host.style.cssText = `all:initial;position:fixed;z-index:2147483646;top:0;right:0;bottom:0;width:${PANEL_W}px;`;
  const root = host.attachShadow({ mode: 'open' });
  // the page is narrowed by the panel's width so nothing sits underneath it
  const docEl = document.documentElement, origMargin = docEl.style.marginRight;
  function dock(px) {
    host.style.display = px ? '' : 'none';
    host.style.width = px + 'px';
    docEl.style.marginRight = px ? px + 'px' : origMargin;
  }
  root.innerHTML = `<style>
    :host{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--line:#e5e5ea;--card:#f6f6f8;--acc:#ee4d2d;--good:#0a8a43;--goodbg:#e8f7ee;--bad:#b3261e;--chip:#fff3ef;--wait:#6e6e73}
    @media (prefers-color-scheme:dark){:host{--bg:#1c1c1e;--fg:#f2f2f7;--mut:#a1a1a6;--line:#38383a;--card:#2c2c2e;--acc:#e8502c;--good:#0f9d50;--goodbg:#13301f;--bad:#ff7b72;--chip:#3a2520;--wait:#48484a}}
    *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    a{color:inherit}
    /* a full-height panel docked on the right; its colour IS the answer */
    .wrap{display:flex;flex-direction:column;height:100vh;font-size:13px;color:var(--fg);background:var(--bg);
      border-left:6px solid var(--wait);box-shadow:-8px 0 28px rgba(0,0,0,.25)}
    .wrap.win{border-color:var(--good)} .wrap.here{border-color:var(--acc)}
    .bar{flex:none;display:flex;flex-direction:column;gap:10px;padding:14px 18px 16px;background:var(--wait);color:#fff}
    .bar.win{background:var(--good)} .bar.here{background:var(--acc)}
    .bar .hd{display:flex;align-items:center;gap:8px}
    .bar .lead{flex:1;font-size:13px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}
    .bar .store{font-size:22px;font-weight:800;line-height:1.1}
    .bar .big{font-size:40px;font-weight:800;line-height:1}
    .bar .save{align-self:flex-start;background:#fff;color:var(--good);font-weight:800;font-size:16px;padding:6px 13px;border-radius:999px}
    .bar.here .save{color:var(--acc)}
    .bar .item{display:flex;gap:10px;align-items:center}
    .bar img{width:64px;height:64px;border-radius:10px;object-fit:cover;background:#fff;flex:none}
    .bar .nm{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;line-height:1.3;opacity:.95}
    .bar .mini{font-size:12px;opacity:.85}
    .bar .prog{height:8px;border-radius:4px;background:rgba(255,255,255,.3);overflow:hidden}
    .bar .prog i{display:block;height:100%;background:#fff;transition:width .3s}
    .bar a.buy{display:block;text-align:center;background:#fff;color:var(--good);font-weight:800;font-size:18px;padding:13px;border-radius:12px;text-decoration:none}
    .bar button{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.55);color:#fff;border-radius:10px;padding:6px 11px;
      font-weight:700;font-size:14px;cursor:pointer;white-space:nowrap}
    .bar button:hover{background:rgba(255,255,255,.3)}
    .flash{animation:flash .45s ease-in-out 4}
    @keyframes flash{50%{filter:brightness(1.4)}}
    .vt{display:none}
    /* collapsed: a coloured strip down the right edge, click to open */
    .slim{border-left:0;cursor:pointer}
    .slim .bar{height:100%;padding:12px 0;align-items:center}
    .slim .bar > *{display:none}
    .slim .bar > .vt{display:block;writing-mode:vertical-rl;font-weight:800;font-size:16px;white-space:nowrap;letter-spacing:.03em}

    /* every store's results, below the answer */
    .body{flex:1;min-height:0;overflow:auto}
    .inner{padding:0 16px 16px}
    header{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--line)}
    header img{width:44px;height:44px;border-radius:8px;object-fit:cover;background:var(--card)}
    header .t{flex:1;min-width:0}
    header .n{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    header .p{color:var(--acc);font-weight:700;font-size:15px}
    form{display:grid;grid-template-columns:1fr auto;gap:6px;padding:10px 0;border-bottom:1px solid var(--line)}
    form label{grid-column:1 / -1;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--mut)}
    form label input{font-size:12px}
    input{flex:1;min-width:0;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:13px}
    button.go{padding:7px 12px;border:0;border-radius:8px;background:var(--acc);color:#fff;font-weight:600;cursor:pointer}

    /* price ladder: every store's best match, cheapest on top */
    .ladder{margin:12px 0 4px;border:1px solid var(--line);border-radius:12px;overflow:hidden}
    .ladder a,.ladder div.l{display:grid;grid-template-columns:24px 1fr auto auto;gap:10px;align-items:center;padding:9px 12px;text-decoration:none;border-top:1px solid var(--line)}
    .ladder > :first-child{border-top:0}
    .ladder .rk{font-weight:800;color:var(--mut);text-align:center}
    .ladder .s{font-weight:600;white-space:nowrap}
    .ladder .v{font-weight:800}
    .ladder .dd{font-size:11px;font-weight:700;min-width:64px;text-align:right}
    .ladder .top{background:var(--good);color:#fff;font-size:15px}
    .ladder .top .rk,.ladder .top .dd{color:#fff}
    .ladder .top .s::after{content:"CHEAPEST";display:inline-block;vertical-align:2px;font-size:10px;font-weight:800;letter-spacing:.06em;margin-left:6px;padding:1px 6px;border-radius:4px;background:rgba(255,255,255,.25)}
    .ladder .self{background:var(--chip)}
    .ladder .self.top{background:var(--acc)}
    .ladder .self .s::after{content:" · this page";font-weight:400;color:var(--mut)}
    .ladder .self.top .s::after{content:"this page · CHEAPEST";padding:0;color:#fff;background:none}

    h3{margin:16px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);display:flex;justify-content:space-between;align-items:baseline}
    h3 a{color:var(--acc);text-transform:none;letter-spacing:0;font-weight:600;text-decoration:none}
    .row{display:flex;gap:9px;align-items:center;padding:7px;border-radius:10px;text-decoration:none;color:inherit;border:2px solid transparent}
    .row:hover{background:var(--card)}
    .row.best{border-color:var(--line)}
    .row.cheapest{border:3px solid var(--good);background:var(--goodbg)}
    .row img{width:40px;height:40px;border-radius:6px;object-fit:cover;background:var(--card);flex:none}
    .row .t{flex:1;min-width:0}
    .row .n{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.3}
    .row .m{color:var(--mut);font-size:11px;margin-top:2px}
    .row .pr{text-align:right;flex:none;font-weight:700}
    .row .d{font-size:11px;font-weight:600}
    .cheaper{color:var(--good)} .dearer{color:var(--bad)}
    .tag{display:inline-block;font-size:10px;padding:0 5px;border-radius:4px;background:var(--card);color:var(--mut);margin-right:3px}
    .tag.ok{color:var(--good)}
    .tag.crown{background:var(--good);color:#fff;font-weight:800}
    .msg{color:var(--mut);padding:6px 2px;font-size:12px}
    .links{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
    .links a{padding:6px 10px;border-radius:8px;background:var(--card);color:var(--fg);text-decoration:none;font-size:12px;border:1px solid var(--line)}
    .links a:hover{border-color:var(--acc)}
    button.more{background:none;border:0;color:var(--mut);font-size:11.5px;cursor:pointer;padding:4px 2px;text-decoration:underline}
    .foot{color:var(--mut);font-size:11px;margin-top:12px;line-height:1.4}
  </style><div id="w"></div>`;
  const W = root.getElementById('w');
  (document.body || document.documentElement).append(host);

  // ---- badge under this page's own price ----
  const badge = document.createElement('div');
  badge.style.cssText = 'all:initial;display:block;margin:8px 0;max-width:520px';
  const broot = badge.attachShadow({ mode: 'open' });
  // how much cheaper the winning store is than this page: { amt, pct } or null
  function savings(v) {
    const sp = state.product?.price;
    if (v.kind !== 'win' || !sp) return null;
    const amt = sp - v.top.b.price;
    return { amt, pct: Math.round(100 * amt / sp), txt: `S$${amt.toFixed(2)} (${Math.round(100 * amt / sp)}%)` };
  }

  function renderBadge(v) {
    const p = state.product;
    const sv = savings(v);
    const saveTxt = sv ? 'save ' + sv.txt : '';
    if (!priceAnchor?.isConnected || v.kind === 'wait' || !p?.price) { badge.remove(); return; }
    // put it after the price's block (not inside an inline span next to the digits)
    let target = priceAnchor;
    while (target.parentElement && target.parentElement !== document.body && /^inline/.test(getComputedStyle(target).display)) target = target.parentElement;
    if (badge.previousElementSibling !== target) target.insertAdjacentElement('afterend', badge);
    const win = v.kind === 'win', b = win && v.top.b;
    const c = win ? '#0a8a43' : '#ee4d2d', bg = win ? '#e8f7ee' : '#fff3ef';
    const checked = v.L.length - 1;
    broot.innerHTML = `<style>
      a,div{all:initial;box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font:600 14px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
        color:${c};background:${bg};border:3px solid ${c};border-radius:12px;padding:9px 14px;cursor:${win ? 'pointer' : 'default'}}
      b{all:initial;font:800 18px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:${c};white-space:nowrap}
      i{all:initial;font:800 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;background:${c};border-radius:6px;padding:5px 8px;white-space:nowrap}
      span{all:initial;font:inherit;color:inherit;white-space:nowrap}
    </style>` + (win
      ? `<a href="${href(b.link)}" target="_blank" rel="noopener"><i>★ CHEAPER</i><span>${esc(v.top.s.name)}</span><b>${money(b.price)}</b><span>${esc(saveTxt)} ↗</span></a>`
      : `<div><i>✓ CHEAPEST</i><span>Lowest of ${checked + 1} store${checked ? 's' : ''} with this item${v.L[1] ? ` · next ${esc(v.L[1].s.name)} ${money(v.L[1].b.price)}` : ''}</span></div>`);
  }

  // ---- toolbar icon badge: "-30%" in green when another store is cheaper, "✓" in orange when this page is ----
  function setToolbar(v) {
    const sv = savings(v);
    const t = sv ? { text: '-' + sv.pct + '%', color: '#0a8a43' }
      : v.kind === 'here' ? { text: '✓', color: '#ee4d2d' } : { text: '', color: '#6e6e73' };
    const k = t.text + t.color;
    if (k === lastToolbar) return;
    lastToolbar = k;
    send({ type: 'badge', ...t });
  }

  function delta(price) {
    const sp = state.product?.price;
    if (!sp || price == null) return '';
    const d = price - sp;
    if (Math.abs(d) < 0.005) return '<div class="d">same</div>';
    return `<div class="d ${d < 0 ? 'cheaper' : 'dearer'}">${d < 0 ? '−' : '+'}S$${Math.abs(d).toFixed(2)}</div>`;
  }

  // listings that are FOR the item rather than the item: priced far below it, or named as an add-on
  // ("Case for MX Master 3S", "鼠标垫 适用…") when this page's title isn't itself one of those.
  const ACC_WORDS = /\b(case|cases|cover|covers|compatible|protector|protective|skin|skins|sleeve|pouch|replacement|tempered|film|decal|sticker|holder|mount|stand|strap|grip|mat|pad)\b|适用|保护套|保护壳|手机壳|贴膜|收纳|鼠标垫|配件/i;
  function isAcc(x) {
    const sp = state.product?.price;
    if (sp && x.price < sp * ACCESSORY_RATIO) return true;
    return ACC_WORDS.test(x.title) && !ACC_WORDS.test((state.product?.title || '') + ' ' + state.query);
  }
  const isMatch = x => x.core && x.score >= MATCH_MIN && !isAcc(x);

  // result order inside a store: PDD by sales, the rest by price
  const order = s => s.sortBy === 'sales'
    ? (a, b) => (b.sales || 0) - (a.sales || 0) || a.price - b.price
    : (a, b) => a.price - b.price;

  // PDD: the best-selling match (cheap PDD listings are often a different/fake item); other stores: the cheapest match
  function bestOf(items, s) {
    return items.filter(isMatch).sort(order(s))[0] || null;
  }

  // every store's pick, cheapest first, plus this page
  function ladder() {
    const rows = STORES.map(s => state.results[s.id]?.best && { s, b: state.results[s.id].best }).filter(Boolean);
    const p = state.product;
    if (p?.price) rows.push({ self: true, s: { name: SITE.name }, b: { price: p.price, link: location.href } });
    return rows.sort((a, b) => a.b.price - b.b.price);
  }
  // 'win' = another store is cheaper; 'here' = this page is cheapest; 'wait' = no verdict yet
  function verdict() {
    const L = ladder(), done = STORES.filter(s => state.results[s.id] && !state.results[s.id].loading).length;
    const top = L[0];
    if (!top || (L.length === 1 && top.self)) return { kind: 'wait', L, done };
    return { kind: top.self ? 'here' : 'win', L, top, done };
  }

  function render() {
    const p = state.product, v = verdict();
    const total = STORES.length, pct = Math.round(100 * v.done / total);
    const searching = !!state.query && v.done < total;   // no keywords = nothing is being searched
    const cls = v.kind === 'wait' ? '' : v.kind;
    const sv = savings(v);
    const saveTxt = sv ? 'Save ' + sv.txt : '';
    const flash = v.kind !== lastKind && v.kind !== 'wait';
    lastKind = v.kind;
    renderBadge(v);
    setToolbar(v);

    // ---- the answer, at the top of the panel ----
    const slim = state.view === 'slim', open = !slim;
    const hd = lead => `<div class="hd"><span class="lead">${lead}</span><button class="min" title="Collapse to a strip">»</button></div>`;
    let bar, vt;
    if (v.kind === 'win') {
      const b = v.top.b;
      bar = hd('★ Cheaper on') + `<div class="store">${esc(v.top.s.name)}</div><div class="big">${money(b.price)}</div>
        ${saveTxt ? `<span class="save">${saveTxt} vs ${esc(SITE.name)}</span>` : ''}
        <div class="item">${b.img ? `<img src="${esc(b.img)}" alt="">` : ''}
        <span class="nm" title="${esc(b.title)}">${esc(b.title)}${v.top.s.note ? ' · ' + esc(v.top.s.note) : ''}</span></div>
        <a class="buy" href="${href(b.link)}" target="_blank" rel="noopener">Open ${esc(v.top.s.name)} ↗</a>`;
      vt = `★ ${esc(v.top.s.name)} ${money(b.price)}${sv ? ` · −${sv.pct}%` : ''}`;
    } else if (v.kind === 'here') {
      const next = v.L[1];
      bar = hd('✓ Cheapest here') + `<div class="store">${esc(SITE.name)}</div><div class="big">${money(p.price)}</div>
        ${next ? `<span class="save">next: ${esc(next.s.name)} ${money(next.b.price)} (+S$${(next.b.price - p.price).toFixed(2)})</span>` : ''}`;
      vt = `✓ Cheapest here · ${money(p.price)}`;
    } else {
      bar = hd(searching ? `Comparing ${total} stores…` : 'No same item found elsewhere') +
        (searching ? `<div class="prog"><i style="width:${pct}%"></i></div>`
          : `<span class="nm">Check the results below or edit the keywords.</span>`);
      vt = searching ? 'Comparing prices…' : 'No match elsewhere';
    }
    if (searching && v.kind !== 'wait') bar += `<span class="mini">${v.done}/${total} stores checked</span>`;
    bar += `<span class="vt">${vt} ‹</span>`;

    // ---- every store's results, under the answer ----
    let html = '';
    const q = state.query;
    if (open) {
      html += `<div class="body"><div class="inner"><header>
        ${p?.image ? `<img src="${esc(p.image)}" alt="">` : ''}
        <div class="t"><div class="n" title="${esc(p?.title)}">${esc(p?.title || SITE.name + ' search')}</div>
        <div class="p">${p?.price ? esc(SITE.name) + ' ' + money(p.price) + ' (this page)' : ''}</div></div></header>
        <form><input class="q" data-d="${esc(q)}" value="${esc(q)}" placeholder="keywords"><button class="go" type="submit">Search</button>
        ${searchesPdd ? `<label>PDD 中文 <input class="zh" data-d="${esc(zhOf.get(q) || '')}" value="${esc(zhOf.get(q) || '')}" placeholder="auto-translated; edit to fix"></label>` : ''}</form>`;

      if (v.L.length) {
        html += `<div class="ladder">` + v.L.map((r, i) => {
          const d = p?.price && !r.self ? r.b.price - p.price : null;
          const tag = r.self ? 'div class="l' : `a href="${href(r.b.link)}" target="_blank" rel="noopener" class="`;
          return `<${tag}${i === 0 && v.kind !== 'wait' ? ' top' : ''}${r.self ? ' self' : ''}"><span class="rk">${i === 0 ? '★' : i + 1}</span><span class="s">${esc(r.s.name)}</span>
            <span class="v">${money(r.b.price)}</span><span class="dd ${d == null ? '' : d < 0 ? 'cheaper' : 'dearer'}">${d == null ? '' : (d < 0 ? '−' : '+') + 'S$' + Math.abs(d).toFixed(2)}</span></${r.self ? 'div' : 'a'}>`;
        }).join('') + `</div>`;
        if (searching) html += `<div class="msg">Still searching ${total - v.done} store${total - v.done > 1 ? 's' : ''}…</div>`;
      }
      const crown = v.kind === 'win' ? v.top.b : null;

      for (const s of STORES) {
        const r = state.results[s.id] || {};
        html += `<h3><span>${esc(s.name)}${s.note ? ` <span style="text-transform:none;letter-spacing:0">· ${esc(s.note)}</span>` : ''}</span>
          <a href="${esc(s.url(q))}" target="_blank" rel="noopener">all results ↗</a></h3>`;
        if (r.loading) html += `<div class="msg">Searching…</div>`;
        else if (r.error) html += `<div class="msg">${esc(r.error)}${r.link ? ` <a href="${esc(r.link)}" target="_blank" rel="noopener" style="color:var(--acc)">${esc(r.linkText)}</a>` : ''}</div>`;
        else if (r.items && !r.items.length) html += `<div class="msg">No results for these keywords.</div>`;
        else if (r.items) {
          const matched = r.items.filter(isMatch).sort(order(s));
          const others = r.items.filter(x => !isMatch(x));
          const all = state.showAll[s.id];
          const shown = all ? [...matched, ...others] : matched.slice(0, LIMIT);
          if (!matched.length) html += `<div class="msg">No listing matches this item.</div>`;
          const hidden = r.items.length - shown.length;
          for (const x of shown) {
            const acc = isAcc(x);
            html += `<a class="row${x === crown ? ' cheapest' : x === r.best ? ' best' : ''}" href="${href(x.link)}" target="_blank" rel="noopener">
              ${x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy">` : ''}
              <div class="t"><div class="n">${esc(x.title)}</div>
              <div class="m">${x === crown ? '<span class="tag crown">★ CHEAPEST</span>' : x === r.best ? `<span class="tag ok">${s.sortBy === 'sales' ? 'top seller' : 'best here'}</span>` : ''}<span class="tag${isMatch(x) ? ' ok' : ''}">${Math.round(x.score * 100)}% match</span>${acc ? '<span class="tag">accessory?</span>' : ''}${x.ad ? '<span class="tag">ad</span>' : ''}${esc(x.extra || '')}</div></div>
              <div class="pr">${money(x.price)}${delta(x.price)}</div></a>`;
          }
          if (hidden > 0 || all) html += `<button class="more" data-s="${s.id}">${all ? 'show matches only' : `show ${hidden} other result${hidden > 1 ? 's' : ''}`}</button>`;
        }
      }

      html += `<h3><span>Search elsewhere</span></h3><div class="links">`;
      for (const l of LINKS) {
        const u = l.url(q, p?.image);
        if (u) html += `<a href="${esc(u)}" target="_blank" rel="noopener" title="${esc(l.note || '')}">${l.image ? '📷 ' : ''}${esc(l.name)} ↗</a>`;
      }
      html += `</div><div class="foot">US$1 = S$${usdSgd.toFixed(3)}, ¥1 = S$${cnySgd.toFixed(3)}${zhOf.get(q) ? `. PDD searched as “${esc(zhOf.get(q))}”` : ''}. Item prices only: check shipping, vouchers and variant before buying. "% match" = share of your keywords in the listing title; a match must also contain the first 3 keywords (2nd + 3rd side by side) and every model number. · v${chrome.runtime.getManifest().version}</div></div></div>`;
    }
    html = `<div class="wrap ${cls}${slim ? ' slim' : ''}"><div class="bar ${cls}${flash ? ' flash' : ''}">${bar}</div>${html}</div>`;

    // results arrive while you type: keep what's in the boxes (and the cursor) across the re-render
    const sameQ = W.dataset.q === state.query;
    const keep = !sameQ ? [] : [...root.querySelectorAll('form input')].filter(i => i.value !== i.dataset.d || root.activeElement === i)
      .map(i => ({ cls: i.className, v: i.value, f: root.activeElement === i, at: i.selectionStart }));
    const body = root.querySelector('.body'), scroll = body ? body.scrollTop : 0;
    W.innerHTML = html;
    W.dataset.q = state.query;
    dock(slim ? SLIM_W : PANEL_W);
    if (slim) { root.querySelector('.wrap').onclick = () => { state.view = 'open'; render(); }; return; }
    root.querySelector('.min').onclick = () => { state.view = 'slim'; render(); };

    root.querySelector('.body').scrollTop = scroll;
    for (const k of keep) {
      const i = root.querySelector('form input.' + k.cls);
      if (!i) continue;
      if (k.v !== i.dataset.d) i.value = k.v;
      if (k.f) { i.focus(); try { i.setSelectionRange(k.at, k.at); } catch (e) {} }
    }
    root.querySelectorAll('.more').forEach(b => b.onclick = () => { state.showAll[b.dataset.s] = !state.showAll[b.dataset.s]; render(); });
    root.querySelector('form').onsubmit = e => {
      e.preventDefault();
      const nq = root.querySelector('input.q').value.trim();
      const zhIn = root.querySelector('input.zh');
      const zh = zhIn ? zhIn.value.trim() : '';
      // keep a hand-edited Chinese query; a changed English query with an untouched Chinese box re-translates
      if (zh && (nq === q || zh !== (zhOf.get(q) || ''))) zhOf.set(nq, zh);
      for (const k of [...cache.keys()]) if (k.startsWith('pdd|')) cache.delete(k);
      runSearch(nq);
    };
  }

  function runSearch(q) {
    state.query = q;
    if (!q) { render(); return; }
    const myKey = state.key + '|' + q;
    for (const s of STORES) {
      state.results[s.id] = { loading: true };
      searchStore(s, q).then(items => {
        if (state.key + '|' + state.query !== myKey) return;
        const scored = items.map(x => ({ ...x, ...(s.match || matchScore)(q, x.title) }));
        state.results[s.id] = { items: scored, best: bestOf(scored, s) };
        render();
      }).catch(e => {
        if (state.key + '|' + state.query !== myKey) return;
        state.results[s.id] = { error: e.message, link: e.link, linkText: e.linkText };
        render();
      });
    }
    render();
  }

  // ---------- page lifecycle (Shopee / Lazada / PDD are single-page apps) ----------
  let lastHref = '';
  async function onPage() {
    const key = SITE.key();
    if (key === state.key && state.product) return;
    state = { key, product: null, query: '', view: state.view, results: {}, showAll: {} };
    if (!key) { dock(0); badge.remove(); lastKind = 'wait'; setToolbar({ kind: 'wait' }); return; }
    lastKind = 'wait';
    render();
    await fxReady;
    // wait for the product to render (title + price), up to ~10 s
    for (let i = 0; i < 20 && SITE.key() === key; i++) {
      const p = SITE.read();
      if (p.title && p.price && !/^(shopee|lazada|amazon|拼多多)/i.test(p.title)) { state.product = p; break; }
      await sleep(500);
    }
    if (SITE.key() !== key) return;
    state.product = state.product || SITE.read();
    let title = state.product.title;
    // a Chinese PDD title: translate it so the English-language stores can be searched
    if (SITE.zh && /[一-鿿]/.test(title)) title = (await send({ type: 'translate', text: title.slice(0, 120), to: 'en' })).text || title;
    if (SITE.key() !== key) return;
    runSearch(cleanTitle(title));
  }

  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; onPage(); } }, 700);

  // re-read this page's price when the shopper picks a different variation
  let tick = 0;
  setInterval(() => {
    if (!state.product || document.hidden) return;
    const quick = priceEl?.isConnected && ++tick % 5;
    const p = quick ? { price: parsePrice(priceEl.textContent, priceCur) } : SITE.read();
    if (!badge.isConnected) renderBadge(verdict());   // the site re-rendered and dropped our badge
    if (p.price && Math.abs(p.price - (state.product.price || 0)) > 0.004) {
      state.product.price = p.price;
      for (const s of STORES) { const r = state.results[s.id]; if (r?.items) r.best = bestOf(r.items, s); }
      render();
    }
  }, 2000);

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'toggle') {
      state.view = state.view === 'open' ? 'slim' : 'open';
      render();
    }
  });
})();
