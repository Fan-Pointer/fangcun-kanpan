'use strict';

const bundled = require('../miniprogram/data/leaders');
const dayMs = 86400000;
const source = '东方财富 · 涨停股池';
const scope = '东方财富收录的沪深北 A 股涨停股中，连续涨停至少 2 个交易日。按连板天数降序，同板数按当日成交额降序，成交额相同按代码排列。';
const industryNames = { '汽车零部': '汽车零部件', '农产品加': '农产品加工' };
let lastGood = bundled;
let cache;
let pending;

function poolUrl(date) {
  const url = new URL('https://push2ex.eastmoney.com/getTopicZTPool');
  url.search = new URLSearchParams({
    ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt', Pageindex: '0',
    pagesize: '10000', sort: 'fbt:asc', date: date.replace(/-/g, '')
  });
  return url.toString();
}

// Publish completed sessions. During the session use the last close, including
// the prior Friday on Monday morning. Official exchange holidays are resolved
// from the latest Shanghai Composite daily bar if the pool has no dated rows.
function targetDate(now) {
  const cst = new Date(now.getTime() + 8 * 3600000);
  if (cst.getUTCHours() * 60 + cst.getUTCMinutes() < 15 * 60 + 10) {
    cst.setUTCDate(cst.getUTCDate() - 1);
  }
  while ([0, 6].includes(cst.getUTCDay())) cst.setUTCDate(cst.getUTCDate() - 1);
  return cst.toISOString().slice(0, 10);
}

function normalize(payload, date) {
  if (!payload || payload.rc !== 0) throw new Error('涨停池上游响应无效');
  const data = payload.data;
  if (!data || String(data.qdate) !== date.replace(/-/g, '')) return null;
  if (!Number.isInteger(data.tc) || !Array.isArray(data.pool) || data.tc !== data.pool.length) {
    throw new Error('涨停池结果不完整');
  }
  const seen = new Set();
  const rows = [];
  for (const item of data.pool) {
    if (!item || !Number.isInteger(item.lbc) || item.lbc < 1 ||
      typeof item.c !== 'string' || !/^\d{6}$/.test(item.c) || seen.has(item.c)) {
      throw new Error('涨停池股票数据无效');
    }
    seen.add(item.c);
    if (item.lbc < 2) continue;
    if (!item.n || !Number.isFinite(item.zdp) || !Number.isFinite(item.amount) || item.amount < 0) {
      throw new Error('涨停池连板数据不完整');
    }
    rows.push({
      symbol: item.c, name: item.n, streak: item.lbc, changePct: Number(item.zdp.toFixed(2)),
      industry: industryNames[item.hybk] || item.hybk || '—', turnover: item.amount
    });
  }
  rows.sort((a, b) => b.streak - a.streak || b.turnover - a.turnover || a.symbol.localeCompare(b.symbol));
  return { tradeDate: date, status: 'eod', source, sourceUrl: poolUrl(date), scope, poolSize: data.tc, rows };
}

async function readJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(4500), redirect: 'error'
  });
  if (!res.ok) throw new Error('上游暂不可用');
  return res.json();
}

async function indexSession(target) {
  const url = new URL('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get');
  url.searchParams.set('param', 'sh000001,day,,' + target + ',12,qfq');
  const body = await readJson(url);
  const index = body?.data?.sh000001;
  const series = index?.day || index?.qfqday;
  if (body.code !== 0 || !Array.isArray(series)) throw new Error('指数交易日期不可用');
  const earliest = new Date(Date.parse(target) - 15 * dayMs).toISOString().slice(0, 10);
  const dates = series.filter(r => Array.isArray(r) && /^\d{4}-\d{2}-\d{2}$/.test(r[0]) &&
    r[0] >= earliest && r[0] <= target && Number(r[2]) > 0).map(r => r[0]).sort();
  if (!dates.length) throw new Error('未能确认最近交易日');
  return dates[dates.length - 1];
}

async function load(now) {
  const target = targetDate(now);
  let data = normalize(await readJson(poolUrl(target)), target);
  // A valid nonempty pool with zero multi-day streaks is a valid empty ranking.
  // A zero-stock pool needs confirmation of a session before publishing it.
  if (!data || !data.poolSize) {
    const actual = await indexSession(target);
    if (actual !== target) data = normalize(await readJson(poolUrl(actual)), actual);
  }
  if (!data || data.tradeDate < lastGood.tradeDate) throw new Error('缺少近期完整数据');
  lastGood = data;
  return data;
}

function getLeaders() {
  const now = new Date();
  if (cache && cache.until > now.getTime()) return Promise.resolve(cache.data);
  if (!pending) {
    pending = load(now).catch(() => ({
      ...lastGood, status: lastGood.status === 'snapshot' ? 'snapshot' : 'stale',
      notice: '暂时无法核验最新涨停池，显示已保存的收盘数据。'
    })).then(data => {
      cache = { data, until: Date.now() + (data.status === 'eod' ? 300000 : 60000) };
      return data;
    }).finally(() => { pending = null; });
  }
  return pending;
}

module.exports = { getLeaders };
