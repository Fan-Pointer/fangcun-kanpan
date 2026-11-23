'use strict';

const listUrl = 'https://push2.eastmoney.com/api/qt/clist/get';
const directoryUrl = 'https://www.nasdaqtrader.com/dynamic/symdir/nasdaqtraded.txt';
const markets = {
  CN: {
    filter: 'm:0+t:6+f:!2,m:0+t:80+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2,m:0+t:81+s:262144+f:!2',
    url: 'https://quote.eastmoney.com/center/gridlist.html#hs_a_board',
    zone: 'Asia/Shanghai', currency: 'CNY',
    scope: '沪深北 A 股按东方财富总市值降序，市值以人民币计，涨跌幅相对该股上个交易日收盘价。'
  },
  US: {
    filter: 'm:105,m:106,m:107',
    url: 'https://quote.eastmoney.com/center/gridlist.html#us_stocks',
    zone: 'America/New_York', currency: 'USD',
    scope: '东方财富美股市场中，按 Nasdaq 证券目录筛选普通股及 ADR，按美元总市值降序。同公司不同股票代码分别列示。'
  }
};
let directory;
const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' };

function parseDirectory(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = header.split('|');
  if (!['Symbol', 'Security Name', 'ETF', 'Test Issue', 'Listing Exchange'].every(x => columns.includes(x))) {
    throw new Error('证券目录格式变动');
  }
  const symbols = new Set();
  for (const line of lines) {
    const cells = line.split('|');
    const field = key => cells[columns.indexOf(key)] || '';
    const name = field('Security Name');
    if (field('ETF') !== 'N' || field('Test Issue') !== 'N') continue;
    const equity = /\b(common|ordinary|capital) (shares?|stocks?)\b|\bamerican deposit[ao]ry\b|\b(ADS|ADR)s?\b|\bnew york registry shares\b|\bsubordinate voting shares\b/i;
    // Some ordinary/ADR listings publish only their legal corporate name (e.g. TSM).
    const corporateName = /\b(inc|incorporated|company|corporation|corp|ltd|limited|plc)\.?\s*$/i;
    if (!equity.test(name) && !corporateName.test(name)) continue;
    if (/\b(funds?|preferred|preference|warrants?|rights?|notes?|debentures?|ETNs?|ETFs?|units?|bonds?|income trust)\b/i.test(name)) continue;
    symbols.add(field('Symbol').replace(/[\/-]/g, '.'));
  }
  if (symbols.size < 1000) throw new Error('证券目录不完整');
  return symbols;
}

async function usDirectory(signal) {
  if (directory && Date.now() < directory.until) return directory.symbols;
  const release = require('./us-listing-snapshot.json');
  try {
    const response = await fetch(directoryUrl, { signal });
    if (!response.ok) throw new Error('证券目录暂不可用');
    const text = await response.text();
    const symbols = parseDirectory(text);
    const captured = /File Creation Time:\s*(\d{2})(\d{2})(\d{4})/.exec(text);
    if (!captured) throw new Error('证券目录日期缺失');
    directory = { symbols, date: captured[3] + '-' + captured[1] + '-' + captured[2], until: Date.now() + 86400000 };
  } catch {
    const last = directory || { symbols: new Set(release.symbols), date: release.asOf };
    directory = { ...last, until: Date.now() + 300000 };
  }
  return directory.symbols;
}

function normalize(market, raw, allowed = null) {
  const rows = new Map();
  const config = markets[market];
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.zone, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  for (const item of raw) {
    const symbol = String(item.f12).replace(/[\/-]/g, '.');
    if (market === 'US' ? !allowed.has(symbol) : !/^(?:[036]\d{5}|(?:43|83|87|88|92)\d{4})$/.test(symbol)) continue;
    if (rows.has(symbol) || !Number.isFinite(item.f20) || item.f20 <= 0) continue;
    const time = Number(item.f124) * 1000;
    if (!(time > 0) || !Number.isFinite(item.f2) || item.f2 <= 0 || !Number.isFinite(item.f3)) {
      throw new Error('行情字段缺失');
    }
    const asOf = new Date(time);
    rows.set(symbol, {
      symbol, name: item.f14, price: item.f2, changePct: item.f3, marketCap: item.f20,
      quoteDate: localDate.format(asOf), quoteTime: asOf.toISOString()
    });
    if (rows.size === 50) break;
  }
  return [...rows.values()].sort((a, b) => b.marketCap - a.marketCap);
}

function makeBoard(market, rows) {
  if (rows.length !== 50) throw new Error('未取得完整市值前五十');
  const dates = rows.map(r => r.quoteDate).sort();
  const quoteDate = dates.at(-1);
  return {
    market, asOf: quoteDate, quoteDate, earliestQuoteDate: dates[0], asOfKind: 'quote',
    retrievedAt: new Date().toISOString(), status: 'updated', currency: markets[market].currency,
    source: '东方财富行情中心', sourceUrl: markets[market].url, scope: markets[market].scope, rows
  };
}

async function list(market, page, signal) {
  const config = markets[market];
  const params = new URLSearchParams({
    pn: String(page), pz: '100', po: '1', np: '1', fltt: '2', invt: '2', fid: 'f20',
    fs: config.filter, fields: 'f2,f3,f12,f13,f14,f20,f124'
  });
  const response = await fetch(listUrl + '?' + params, { headers, signal });
  if (!response.ok) throw new Error('行情源暂不可用');
  const json = await response.json();
  if (json.rc !== 0 || !Array.isArray(json.data?.diff)) throw new Error('行情源未返回列表');
  return json.data.diff;
}

async function eastmoney(market, allowed) {
  const signal = AbortSignal.timeout(4500);
  const first = await list(market, 1, signal);
  const raw = first.slice();
  let rows = normalize(market, raw, allowed);
  for (let page = 2; rows.length < 50 && page <= 10; page++) {
    const more = await list(market, page, signal);
    if (!more.length) break;
    raw.push(...more);
    rows = normalize(market, raw, allowed);
  }
  return makeBoard(market, rows);
}

async function getRanking(market) {
  const allowed = market === 'US' ? await usDirectory(AbortSignal.timeout(2500)) : null;
  let board;
  try {
    board = await eastmoney(market, allowed);
  } catch {
    const { getSinaRanking } = require('./sina');
    board = await getSinaRanking(market, allowed);
  }
  if (market === 'US') {
    board.directoryDate = directory.date;
    board.scope += ' 证券类型目录日期为 ' + directory.date + '。';
  }
  return board;
}

module.exports = { getRanking, parseDirectory, normalize, makeBoard };
