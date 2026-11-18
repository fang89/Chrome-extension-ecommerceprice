// Cross-origin work lives here: a page script on shopee.sg can't read amazon/lazada (CORS),
// but an extension with host_permissions can. HTML parsing happens in content.js (has DOMParser).
//
// PDD renders its search results with JavaScript behind a login, so a plain fetch gets
// a login page. For those we open the search in a background tab (your own logged-in session),
// read the rendered results, and close the tab.

const sleep = ms => new Promise(r => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handlers = {
    fetch: () => fetch(msg.url, { credentials: 'include' })
      .then(async r => ({ ok: r.ok, status: r.status, url: r.url, text: await r.text() }))
      .catch(e => ({ ok: false, status: 0, error: String(e) })),
    fx: () => getRates(),
    translate: () => translate(msg.text, msg.to || 'zh-CN'),
    scrape: () => queueScrape(msg.url, msg.kind || 'pdd'),
    // toolbar icon: "-30%" green when another store is cheaper, "✓" orange when this page is
    badge: async () => {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false };
      await chrome.action.setBadgeText({ tabId, text: msg.text || '' });
      if (msg.color) await chrome.action.setBadgeBackgroundColor({ tabId, color: msg.color });
      return { ok: true };
    },
  };
  if (!handlers[msg.type]) return;
  handlers[msg.type]().then(reply, e => reply({ ok: false, error: String(e) }));
  return true; // async reply
});

// SGD per USD and per CNY, cached 12 h
async function getRates() {
  const { fx } = await chrome.storage.local.get('fx');
  if (fx && fx.cny && Date.now() - fx.t < 12 * 3600e3) return fx;
  try {
    const r = (await (await fetch('https://open.er-api.com/v6/latest/USD')).json()).rates;
    if (r?.SGD && r?.CNY) {
      const v = { rate: r.SGD, cny: r.SGD / r.CNY, t: Date.now() };
      await chrome.storage.local.set({ fx: v });
      return v;
    }
  } catch (e) {}
  return fx || { rate: 1.29, cny: 0.193 };
}

// translations are cached (last 300) so revisiting an item doesn't call the translator again
async function translate(text, to) {
  const k = to + '|' + text;
  const { tr = {} } = await chrome.storage.local.get('tr');
  if (tr[k]) return { text: tr[k] };
  const j = await (await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${encodeURIComponent(text)}`)).json();
  const out = (j?.[0] || []).map(s => s[0]).join('').trim();
  if (out) {
    tr[k] = out;
    const keys = Object.keys(tr);
    for (const old of keys.slice(0, Math.max(0, keys.length - 300))) delete tr[old];
    await chrome.storage.local.set({ tr });
  }
  return { text: out || text };
}

// v2.1.0 and earlier stored one 'tr|…' key per translation: drop them
chrome.runtime.onInstalled.addListener(async () => {
  const old = Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('tr|'));
  if (old.length) await chrome.storage.local.remove(old);
});

// one background tab at a time, so a fast click-through on Shopee doesn't spawn a pile of tabs
let chain = Promise.resolve();
function queueScrape(url, kind) {
  const p = chain.then(() => scrapeInTab(url, kind));
  chain = p.catch(() => {});
  return p;
}

async function scrapeInTab(url, kind, timeoutMs = 15000) {
  const tab = await chrome.tabs.create({ url, active: false });
  chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  let last = null;
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(1000);
      const t = await chrome.tabs.get(tab.id);
      if (/\/login|passport|signin/i.test(t.url || '')) return { ok: false, login: true };
      if (/verify|captcha|punish/i.test(t.url || '')) return { ok: false, blocked: true };
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: extractGoods, args: [kind] });
        last = res?.result;
        // results usually arrive in one go; wait one more tick for late cards, then return
        if (last?.items?.length >= 6 || (last?.items?.length && Date.now() - t0 > 5000)) return { ok: true, ...last };
      } catch (e) { /* page still navigating */ }
    }
    return last?.items?.length ? { ok: true, ...last } : { ok: false, empty: true, debug: last?.debug };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Runs inside a PDD or Shopee search page (kind = 'pdd' | 'shopee'). Must be self-contained (it is serialised into the page).
// Two readers: (1) product cards in the DOM (links to goods pages + a price in the card text),
// (2) the page's embedded JSON (window.rawData) for objects that look like goods.
function extractGoods(kind) {
  const items = new Map();
  const abs = u => { try { return new URL(u, location.href).href; } catch (e) { return null; } };
  const linkSel = kind === 'shopee' ? 'a[href*="-i."]' : 'a[href*="goods_id="]';
  const idOf = href => href.match(kind === 'shopee' ? /-i\.(\d+\.\d+)/ : /goods_id=(\d+)/)?.[1];
  const priceRe = /(?:[¥￥]|S\$|\$)\s*([\d,]+(?:\.\d+)?)/;

  // (1) DOM cards
  for (const a of document.querySelectorAll(linkSel)) {
    const id = idOf(a.href);
    if (!id || items.has(id)) continue;
    // climb to the card: the nearest ancestor whose text includes a price
    let card = a;
    for (let i = 0; i < 5 && card && !priceRe.test(card.innerText || ''); i++) card = card.parentElement;
    if (!card) continue;
    const text = card.innerText || '';
    const m = text.match(priceRe);
    if (!m) continue;
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    const title = a.getAttribute('title') || a.getAttribute('aria-label') ||
      lines.filter(l => !priceRe.test(l) && !/^[\d.,]+$/.test(l)).sort((x, y) => y.length - x.length)[0] || '';
    const sold = lines.find(l => /已拼|已售|sold/i.test(l)) || '';
    items.set(id, {
      title, price: parseFloat(m[1].replace(/,/g, '')), priceText: m[0],
      img: card.querySelector('img')?.currentSrc || card.querySelector('img')?.src || '',
      link: abs(a.getAttribute('href')), extra: sold,
    });
  }

  // (2) embedded JSON
  if (kind === 'pdd' && items.size < 3 && window.rawData) {
    const seen = new WeakSet();
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 12 || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) { o.forEach(x => walk(x, depth + 1)); return; }
      const id = o.goods_id ?? o.goodsID ?? o.goodsId;
      const name = o.goods_name ?? o.goodsName;
      if (id && name && !items.has(String(id))) {
        let price = null, priceText = '';
        const pi = o.price_info ?? o.priceInfo;
        const s = typeof pi === 'string' ? pi : (pi?.price_str ?? pi?.priceStr ?? o.price_str ?? o.priceStr);
        if (typeof s === 'string' && /\d/.test(s)) { priceText = s; price = parseFloat(s.replace(/[^\d.]/g, '')); }
        else {
          const n = o.price ?? o.min_group_price ?? o.group_price ?? pi?.price;
          if (typeof n === 'number') { price = Number.isInteger(n) ? n / 100 : n; priceText = String(n); } // PDD sends fen (cents)
        }
        if (price) items.set(String(id), {
          title: name, price, priceText,
          img: o.thumb_url ?? o.thumbUrl ?? o.hd_thumb_url ?? o.image_url ?? o.imageUrl ?? '',
          link: abs(o.link_url ?? o.linkURL ?? o.seo_link_url ?? `goods.html?goods_id=${id}`),
          extra: o.sales_tip ?? o.salesTip ?? '',
        });
      }
      for (const k in o) walk(o[k], depth + 1);
    };
    try { walk(window.rawData, 0); } catch (e) {}
  }

  return {
    items: [...items.values()].slice(0, 20),
    debug: { url: location.href, title: document.title, hasRaw: !!window.rawData, text: (document.body?.innerText || '').slice(0, 300) },
  };
}

// Toolbar icon toggles the overlay.
chrome.action.onClicked.addListener(tab => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
});
