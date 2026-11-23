'use strict';

const cnList = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
const usList = 'https://stock.finance.sina.com.cn/usstock/api/json_v2.php/US_CategoryService.getList';
const headers = { Referer: 'https://finance.sina.com.cn/' };
const scope = {
  CN: '新浪财经沪深 A 股按人民币总市值降序。价格、涨跌幅对应各股最近交易日。',
  US: '新浪财经美股按美元总市值降序，经 Nasdaq 证券目录筛选普通股及 ADR，同一公司的不同股类分别列示。'
};

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

async function getJson(url, signal) {
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw new Error('新浪行情源暂不可用');
  return response.json();
}

async function getRows(market, allowed, signal) {
  let raw;
  if (market === 'CN') {
    raw = await getJson(cnList + '?page=1&num=80&sort=mktcap&asc=0&node=hs_a', signal);
  } else {
    const url = page => usList + '?page=' + page + '&num=20&sort=mktcap&asc=0';
    const pages = await Promise.all([1, 2, 3].map(i => getJson(url(i), signal)));
    raw = pages.flatMap(p => p.data).filter(q => allowed.has(q.symbol));
    for (let i = 4; raw.length < 50 && i <= 10; i++) {
      const next = await getJson(url(i), signal);
      if (!next.data.length) break;
      raw.push(...next.data.filter(q => allowed.has(q.symbol)));
    }
  }
  const bySymbol = new Map();
  for (const q of raw) {
    const symbol = market === 'CN' ? q.code : q.symbol;
    if (!symbol || (market === 'CN' && !/^[603]\d{5}$/.test(symbol))) continue;
    const cap = num(q.mktcap);
    if (!(cap > 0)) continue;
    const price = num(market === 'CN' ? q.trade : q.price);
    const changePct = num(market === 'CN' ? q.changepercent : q.chg);
    if (!(price > 0) || changePct === null) throw new Error('行情字段缺失');
    bySymbol.set(symbol, {
      symbol, name: (market === 'CN' ? q.name : q.cname || q.name),
      marketCap: market === 'CN' ? Math.round(cap * 10000) : cap, price, changePct,
      quoteKey: market === 'CN' ? q.symbol : 'gb_' + symbol.toLowerCase().replace(/\./g, '$')
    });
  }
  const rows = [...bySymbol.values()].sort((a, b) => b.marketCap - a.marketCap).slice(0, 50);
  if (rows.length !== 50) throw new Error('榜单不完整');
  return rows;
}

function usDate(fields) {
  // The time at index 3 also updates pre-market. Index 25 refers to regular trading.
  const lastTrade = /^(\w{3}) (\d{1,2})\s/.exec(fields[25] || '');
  const reference = /^(\d{4})-(\d{2})-\d{2}/.exec(fields[3] || '');
  if (!lastTrade || !reference) return null;
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(lastTrade[1]) + 1;
  if (!month) return null;
  const year = Number(reference[1]) - (month > Number(reference[2]) ? 1 : 0);
  return year + '-' + String(month).padStart(2, '0') + '-' + lastTrade[2].padStart(2, '0');
}

async function getSinaRanking(market, allowed) {
  const signal = AbortSignal.timeout(9500);
  const rows = await getRows(market, allowed, signal);
  const url = 'https://hq.sinajs.cn/list=' + rows.map(r => r.quoteKey).join(',');
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw new Error('无法取得交易日');
  const records = new Map();
  const payload = new TextDecoder('gbk').decode(await response.arrayBuffer());
  for (const match of payload.matchAll(/hq_str_([\w$]+)="([^"]*)";/g)) {
    records.set(match[1], match[2].split(','));
  }
  for (const row of rows) {
    const f = records.get(row.quoteKey) || [];
    row.quoteDate = market === 'CN' ? f[30] : usDate(f);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.quoteDate || '')) throw new Error('证券交易日缺失：' + row.symbol);
    if (market === 'CN' && /^\d{2}:\d{2}:\d{2}$/.test(f[31])) row.quoteTime = row.quoteDate + 'T' + f[31] + '+08:00';
    delete row.quoteKey;
  }
  const dates = rows.map(r => r.quoteDate).sort();
  return {
    market, asOf: dates.at(-1), asOfKind: 'quote', quoteDate: dates.at(-1), earliestQuoteDate: dates[0],
    retrievedAt: new Date().toISOString(), status: 'updated', source: '新浪财经',
    sourceUrl: market === 'CN' ? 'https://vip.stock.finance.sina.com.cn/mkt/#hs_a' : 'https://stock.finance.sina.com.cn/usstock/',
    scope: scope[market], currency: market === 'CN' ? 'CNY' : 'USD', rows
  };
}

module.exports = { getSinaRanking };
