'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const endpoint = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const reports = ['RPT_DAILYBILLBOARD_DETAILS', 'RPT_BILLBOARD_DAILYDETAILSBUY', 'RPT_BILLBOARD_DAILYDETAILSSELL'];
const aliases = new Map([
  ['国泰海通证券股份有限公司上海长宁区江苏路证券营业部', '章盟主'],
  ['国泰海通证券股份有限公司长宁区江苏路证券营业部', '章盟主'],
  ['东方证券股份有限公司杭州龙井路证券营业部', '章盟主'],
  ['国投证券股份有限公司西安曲江池南路证券营业部', '曲江池'],
  ['东莞证券股份有限公司南京分公司', '玉兰路'],
  ['国泰海通证券股份有限公司湛江万豪世家证券营业部', '湛江万豪世家'],
  ['民生证券股份有限公司宁波财神殿南路证券营业部', '总舵主'],
  ['甬兴证券有限公司宁波和源路证券营业部', '宁波和源路']
]);
const scope = '按最新披露日的沪深北 A 股龙虎榜净买额降序取前十。同股多个上榜原因只取净买额最大的一条，不累加。多日异动的金额覆盖相应披露期。买卖各列前五席，未披露的对侧金额为空。';

function knownAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function seats(records, stock, side) {
  const ranked = records.filter(item => item.SECURITY_CODE === stock.SECURITY_CODE &&
    String(item.TRADE_ID) === String(stock.TRADE_ID) && item.TRADE_DATE === stock.TRADE_DATE);
  if (!ranked.length) throw new Error('席位明细尚未齐备');
  ranked.sort((a, b) => b[side] - a[side]);
  return ranked.slice(0, 5).map(item => {
    if (!item.OPERATEDEPT_NAME || knownAmount(item[side]) === null) throw new Error('席位字段缺失');
    const name = item.OPERATEDEPT_NAME;
    const data = { name, buy: knownAmount(item.BUY), sell: knownAmount(item.SELL) };
    const alias = aliases.get(name);
    if (alias) {
      data.alias = alias;
      data.aliasSource = 'https://www.kanpanba.com/lhb/trader/' + encodeURIComponent(alias);
    }
    return data;
  });
}

function buildDragon(tradeDate, market, buy, sell) {
  const sorted = market.filter(item => item.SECURITY_TYPE_CODE === '058001001' &&
    item.TRADE_DATE?.slice(0, 10) === tradeDate && knownAmount(item.BILLBOARD_NET_AMT) !== null)
    .sort((a, b) => b.BILLBOARD_NET_AMT - a.BILLBOARD_NET_AMT || Number(a.TRADE_ID) - Number(b.TRADE_ID));
  const rows = [];
  const used = new Set();
  for (const item of sorted) {
    if (used.has(item.SECURITY_CODE)) continue;
    used.add(item.SECURITY_CODE);
    rows.push({
      symbol: item.SECURITY_CODE, name: item.SECURITY_NAME_ABBR,
      changePct: knownAmount(item.CHANGE_RATE), netBuy: item.BILLBOARD_NET_AMT,
      reason: item.EXPLANATION, tradeId: String(item.TRADE_ID),
      buyTotal: knownAmount(item.BILLBOARD_BUY_AMT), sellTotal: knownAmount(item.BILLBOARD_SELL_AMT),
      sourceUrl: 'https://data.eastmoney.com/stock/lhb/' + item.SECURITY_CODE + '.html',
      buySeats: seats(buy, item, 'BUY'), sellSeats: seats(sell, item, 'SELL')
    });
    if (rows.length === 10) break;
  }
  if (!rows.length) throw new Error('尚无 A 股披露记录');
  return {
    tradeDate, retrievedAt: new Date().toISOString(), status: 'updated', source: '东方财富数据中心',
    sourceUrl: 'https://data.eastmoney.com/stock/tradedetail.html', currency: 'CNY', scope,
    aliasNote: '游资别名为第三方对营业部的市场归纳，交易所仅披露交易席位，无法据此辨认交易人。',
    rows
  };
}

async function page(reportName, params, signal) {
  const search = new URLSearchParams({reportName, columns: 'ALL', pageSize: '500', pageNumber: '1', ...params});
  const response = await fetch(endpoint + '?' + search, { signal, redirect: 'error' });
  if (!response.ok) throw new Error('东财行情源暂不可用');
  const body = await response.json();
  if (!body.success || !Array.isArray(body.result?.data)) throw new Error('东财披露数据暂缺');
  return body.result;
}

async function report(name, date, signal) {
  const params = { filter: "(TRADE_DATE='" + date + "')", sortColumns: 'TRADE_ID', sortTypes: '1' };
  if (name !== reports[0]) {
    const side = name === reports[1] ? 'BUY' : 'SELL';
    params.sortColumns += ',' + side + ',OPERATEDEPT_CODE';
    params.sortTypes += ',-1,1';
  }
  const first = await page(name, params, signal);
  const rows = first.data.slice();
  for (let i = 2; i <= first.pages; i++) {
    const next = await page(name, { ...params, pageNumber: String(i) }, signal);
    rows.push(...next.data);
  }
  if (rows.length !== first.count) throw new Error('龙虎榜源数据正在更新');
  return rows;
}

async function download() {
  const signal = AbortSignal.timeout(12000);
  const latest = await page(reports[0], { columns: 'TRADE_DATE', pageSize: '1', sortColumns: 'TRADE_DATE', sortTypes: '-1' }, signal);
  const date = latest.data[0]?.TRADE_DATE?.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('缺少交易日期');
  const data = await Promise.all(reports.map(name => report(name, date, signal)));
  return buildDragon(date, ...data);
}

let previous;
let validUntil = 0;
let pending;
async function update() {
  const cacheFile = path.join(process.env.CACHE_DIR || path.join(__dirname, '.cache'), 'dragon.json');
  if (!previous) {
    const bundled = require('../miniprogram/data/dragon');
    previous = bundled;
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (cached.status === 'updated' && cached.tradeDate >= bundled.tradeDate && Array.isArray(cached.rows) && cached.rows.length &&
        cached.rows.every(row => row.buySeats?.length && row.sellSeats?.length)) previous = cached;
    } catch { /* First use can start from the bundled disclosure. */ }
  }
  try {
    const next = await download();
    if (next.tradeDate < previous.tradeDate) throw new Error('上游交易日早于已有披露');
    previous = next;
    validUntil = Date.now() + 300000;
    const temporary = cacheFile + '.' + randomUUID() + '.tmp';
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(next), 'utf8');
      await fs.rename(temporary, cacheFile);
    } catch {
      console.warn('龙虎榜使用内存缓存。');
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  } catch {
    previous = { ...previous, status: previous.status === 'snapshot' ? 'snapshot' : 'stale', notice: '暂未取得新披露，显示已有交易日数据。' };
    validUntil = Date.now() + 60000;
  }
  return previous;
}

function getDragon() {
  if (previous && Date.now() < validUntil) return Promise.resolve(previous);
  if (!pending) pending = update().finally(() => { pending = undefined; });
  return pending;
}

module.exports = { getDragon, buildDragon };
