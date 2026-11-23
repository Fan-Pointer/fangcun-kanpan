'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getRanking } = require('./provider');
const { getDragon } = require('./dragon');
const { getLeaders } = require('./leaders');
const bundled = require('../miniprogram/data/rankings');

const directory = process.env.CACHE_DIR || path.join(__dirname, '.cache');
const cache = new Map();
const inFlight = new Map();
const freshFor = 60 * 1000;

function validSnapshot(data, market) {
  return data && data.market === market && ['东方财富行情中心', '新浪财经'].includes(data.source) && data.status === 'updated' &&
    data.currency === bundled[market].currency && typeof data.asOf === 'string' &&
    Number.isFinite(Date.parse(data.retrievedAt)) && Array.isArray(data.rows) && data.rows.length === 50 &&
    new Set(data.rows.map(row => row.symbol)).size === 50 &&
    data.rows.every((row, i, all) => typeof row.name === 'string' && typeof row.symbol === 'string' &&
      Number.isFinite(row.marketCap) && row.marketCap > 0 && Number.isFinite(row.price) && row.price > 0 &&
      Number.isFinite(row.changePct) && (!i || row.marketCap <= all[i - 1].marketCap));
}

async function fromDisk(market) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(directory, market + '.json'), 'utf8'));
    return validSnapshot(data, market) ? data : null;
  } catch {
    return null;
  }
}

async function save(market, data) {
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, market + '.json');
  const temporary = target + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(data), 'utf8');
  try {
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function refresh(market) {
  const previous = cache.get(market)?.data || await fromDisk(market);
  const diskFresh = previous?.status === 'updated' && Date.now() - Date.parse(previous.retrievedAt) < freshFor;
  if (diskFresh) {
    cache.set(market, { data: previous, until: Date.parse(previous.retrievedAt) + freshFor });
    return previous;
  }
  try {
    const data = await getRanking(market);
    if (!validSnapshot(data, market)) throw new Error('Invalid data.');
    const referenceDate = previous?.quoteDate || bundled[market].quoteDate;
    if (referenceDate && data.quoteDate < referenceDate) throw new Error('Older trading date.');
    try {
      await save(market, data);
    } catch {
      console.warn('磁盘缓存不可写，继续使用内存缓存。');
    }
    cache.set(market, { data, until: Date.now() + freshFor });
    return data;
  } catch {
    console.warn('上游行情暂不可用：' + market);
  }
  const lastGood = previous && previous.status !== 'snapshot' ? previous : null;
  const fallback = lastGood ? { ...lastGood, status: 'stale' } : { ...bundled[market] };
  fallback.notice = '行情源暂不可用，' +
    (lastGood ? '显示最近成功缓存。' : '显示内置榜单快照。');
  cache.set(market, { data: fallback, until: Date.now() + 60000 });
  return fallback;
}

function ranking(market) {
  const current = cache.get(market);
  if (current && current.until > Date.now()) return Promise.resolve(current.data);
  if (!inFlight.has(market)) {
    const pending = refresh(market).finally(() => inFlight.delete(market));
    inFlight.set(market, pending);
  }
  return inFlight.get(market);
}

function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const routes = ['/api/rankings', '/api/dragon', '/api/leaders'];
    if (!routes.includes(url.pathname)) return json(res, 404, { error: '未找到接口' });
    if (req.method !== 'GET') return json(res, 405, { error: '请使用 GET 请求' });
    if (url.pathname === '/api/dragon') return json(res, 200, await getDragon());
    if (url.pathname === '/api/leaders') return json(res, 200, await getLeaders());
    const market = url.searchParams.get('market');
    if (market !== 'CN' && market !== 'US') return json(res, 400, { error: 'market 取值为 CN 或 US' });
    json(res, 200, await ranking(market));
  } catch {
    json(res, 500, { error: '服务暂不可用' });
  }
});

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log('市值榜服务已启动 http://' + host + ':' + port));
}

module.exports = server;
