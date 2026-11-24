// Public browser-side quotes. The payload is decoded as text and never executed.
const webQuotes = {
  enabled: location.protocol === 'https:' || location.protocol === 'http:',
  current: { CN: new Map(), US: new Map() }, base: {}, status: {}, pending: {},
  attempted: {}, snapshotAt: {}, snapshotPending: {}, timer: null
};
const marketEtfs = [
  ['QQQ','纳指100 ETF'], ['SPY','标普500 ETF'], ['DIA','道指 ETF'],
  ['SMH','半导体 ETF'], ['XLK','科技 ETF'], ['KBE','银行 ETF'], ['XLE','能源 ETF'],
  ['GLD','黄金 ETF'], ['SLV','白银 ETF'], ['COPX','铜矿股 ETF'], ['TLT','长期美债 ETF']
];
const indicatorTickers = { nasdaq:'QQQ', sp500:'SPY', dow:'DIA' };
const quoteZones = { CN:'Asia/Shanghai', US:'America/New_York' };
const quoteClocks = Object.fromEntries(Object.entries(quoteZones).map(([key,timeZone]) => [key,
  new Intl.DateTimeFormat('sv-SE',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
]));
function providerKey(m,symbol) {
  if (m === 'US') return /^[A-Z0-9.-]{1,15}$/.test(symbol) ? 'us'+symbol : '';
  if (!/^\d{6}$/.test(symbol)) return '';
  return (/^6/.test(symbol)?'sh':/^[48]|^92/.test(symbol)?'bj':'sz')+symbol;
}
function quoteStamp(m,text) {
  const match = (m==='CN'?/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/:/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/).exec(text);
  if (!match) return '';
  return match[1]+'-'+match[2]+'-'+match[3]+' '+match[4]+':'+match[5]+':'+match[6];
}
function decodeQuotes(m,body,keys) {
  const result=new Map(), now=quoteClocks[m].format(new Date(Date.now()+120000));
  for (const line of body.split(/\r?\n/)) {
    const match=/^v_([A-Za-z0-9.\-]+)="([^"]*)";?$/.exec(line.trim());
    if (!match||!keys.has(match[1])) continue;
    const f=match[2].split('~'),symbol=keys.get(match[1]),stamp=quoteStamp(m,f[30]);
    if (!stamp || stamp>now || !(Number(f[3])>0) || !Number.isFinite(Number(f[3])) || !f[32]?.trim() || !Number.isFinite(Number(f[32]))) continue;
    const marketCap=Number(f[45])*1e8;
    result.set(symbol,{symbol,price:Number(f[3]),changePct:Number(f[32]),stamp,
      quoteDate:stamp.slice(0,10),feedName:'腾讯行情',...(marketCap>0&&Number.isFinite(marketCap)?{marketCap}:{})});
  }
  return result;
}
function activeQuoteMarkets() {
  if (state.page==='home') return [...new Set([state.market,'US'])];
  if (state.page==='ranks') return [state.market];
  if (state.page==='sectors') return ['US'];
  if (state.page==='mine') return ['CN','US'].filter(m=>[...favorites].some(k=>k.startsWith(m+':')||(m==='US'&&/^(benchmark|indicator):/.test(k))));
  return [];
}
function routineHours(m) {
  const now=quoteClocks[m].format(new Date()), day=new Date(now.slice(0,10)+'T12:00:00Z').getUTCDay();
  const t=now.slice(11,16);
  return day>0&&day<6&&(m==='US'?t>='09:30'&&t<='16:10':(t>='09:15'&&t<='11:35')||(t>='12:59'&&t<='15:10'));
}
async function fetchQuoteData(url,binary=false) {
  const ctrl=new AbortController(), timeout=setTimeout(()=>ctrl.abort(),9000);
  try {
    const r=await fetch(url,{signal:ctrl.signal,credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
    if (!r.ok) throw new Error('HTTP '+r.status);
    return binary?new TextDecoder('gbk').decode(await r.arrayBuffer()):await r.json();
  } finally {clearTimeout(timeout);}
}
function mergeQuotes(m) {
  const base=webQuotes.base[m], dates=[], updated=[];
  const rows=base.rows.map(row=>{
    const q=webQuotes.current[m].get(row.symbol);
    let baseline=row.quoteDate||base.quoteDate||'';
    if (row.quoteTime && Number.isFinite(Date.parse(row.quoteTime))) baseline=quoteClocks[m].format(new Date(row.quoteTime));
    if (!q||q.stamp<baseline) {dates.push(row.quoteDate||base.quoteDate);return row;}
    dates.push(q.quoteDate);updated.push(q.stamp);
    return {...row,...q,marketCap:q.marketCap||row.marketCap};
  }).sort((a,b)=>b.marketCap-a.marketCap);
  dates.sort();updated.sort();
  ranks[m]={...base,rows,quoteDate:dates[dates.length-1],earliestQuoteDate:dates[0],lastStamp:updated[updated.length-1],quoteCount:updated.length};
  rows.forEach((o,i)=>register(m+':'+o.symbol,'stock',o,{market:m,rank:i+1}));
  if (m==='US') {
    for (const [symbol,name] of marketEtfs) {
      const q=webQuotes.current.US.get(symbol);
      if (q) register('benchmark:'+symbol,'benchmark',{...q,id:symbol,name});
    }
    market.indicators.forEach(o=>{
      const symbol=indicatorTickers[o.id], q=webQuotes.current.US.get(symbol);
      if(q) register('indicator:'+o.id,'indicator',{...o,...q});
    });
  }
}
function repaintQuotes() {
  if (document.hidden) return;
  // Keep the keyboard and selection alive while a user types a search on mobile.
  if (document.activeElement?.id==='rankSearch') {
    document.querySelector('#rankBody').innerHTML=listBody();
    const breadth=document.querySelector('.breadth');
    if(breadth) breadth.outerHTML=rankBreadth(rankMeta(state.market).rows);
    updateQuoteStrip();
  } else render();
  if (openKey && dialog.open) renderDetail(openKey,false);
}
async function pollQuotes(m,manual=false) {
  if (webQuotes.pending[m] || (!manual && Date.now()-(webQuotes.attempted[m]||0)<(routineHours(m)?15000:60000))) return;
  webQuotes.pending[m]=true;webQuotes.attempted[m]=Date.now();updateQuoteStrip();
  try {
    const symbols=webQuotes.base[m].rows.map(r=>r.symbol);
    if (m==='US') symbols.push(...marketEtfs.map(o=>o[0]));
    const keys=new Map([...new Set(symbols)].map(s=>[providerKey(m,s),s]).filter(([key])=>key));
    const url=new URL('https://qt.gtimg.cn/');
    url.searchParams.set('q',[...keys.keys()].join(','));url.searchParams.set('_',String(Date.now()));
    const fresh=decodeQuotes(m,await fetchQuoteData(url,true),keys);
    if (!fresh.size) throw new Error('无有效报价');
    let accepted=0;
    for (const [symbol,q] of fresh) {
      const previous=webQuotes.current[m].get(symbol);
      if (!previous||previous.stamp<=q.stamp) {webQuotes.current[m].set(symbol,q);accepted++;}
    }
    if (!accepted) throw new Error('报价时间早于已有记录');
    webQuotes.status[m]=fresh;
    mergeQuotes(m);
  } catch {webQuotes.status[m]=null;}
  finally {
    webQuotes.pending[m]=false;
    if(activeQuoteMarkets().includes(m)) repaintQuotes();
  }
}
async function pollPublished(kind,manual=false) {
  if (webQuotes.snapshotPending[kind] || Date.now()-(webQuotes.snapshotAt[kind]||0)<(manual?3000:300000)) return;
  webQuotes.snapshotPending[kind]=true;webQuotes.snapshotAt[kind]=Date.now();
  try {
    const p=await fetchQuoteData('data/'+kind+'.json?t='+Math.floor(Date.now()/10000));
    if (!p||!Array.isArray(p.rows)) return;
    if (kind.startsWith('rankings-')) {
      const m=kind.slice(-2), prev=webQuotes.base[m];
      if(p.market!==m||p.rows.length!==50||new Set(p.rows.map(r=>r.symbol)).size!==50||!p.rows.every(r=>providerKey(m,r.symbol)&&r.marketCap>0&&r.price>0&&Number.isFinite(r.changePct)))return;
      if((p.quoteDate||'')<(prev.quoteDate||'')||((p.quoteDate||'')===(prev.quoteDate||'')&&(p.retrievedAt||'')<=(prev.retrievedAt||'')))return;
      webQuotes.base[m]=p;mergeQuotes(m);
    } else {
      if(p.tradeDate<market[kind].tradeDate||!p.rows.every(r=>typeof r.symbol==='string'&&(kind==='dragon'?Array.isArray(r.buySeats)&&Array.isArray(r.sellSeats):Number.isInteger(r.streak))))return;
      market[kind]=p;
    }
    repaintQuotes();
  } catch { /* The embedded published snapshot remains usable offline. */ }
  finally {webQuotes.snapshotPending[kind]=false;}
}
function tickQuotes(manual=false) {
  if (!webQuotes.enabled||document.hidden) return;
  for (const m of activeQuoteMarkets()) {
    pollQuotes(m,manual);
    pollPublished('rankings-'+m,manual);
  }
  if (state.page==='dragon'||state.page==='leaders') pollPublished(state.page,manual);
}
function quoteStrip() {
  if (!webQuotes.enabled||!['home','ranks','sectors'].includes(state.page))return '';
  return '<div class="quote-strip"><div><strong id="quoteStatus">读取行情中</strong><span id="quoteMoment"></span></div><button type="button" data-act="refreshQuotes">刷新行情</button></div>';
}
function updateQuoteStrip() {
  const label=document.getElementById('quoteStatus');if(!label)return;
  const group=state.page==='sectors',m=group?'US':state.market;
  const board=ranks[m],target=group?marketEtfs.map(o=>o[0]):board.rows.map(r=>r.symbol);
  const feed=webQuotes.status[m], matched=target.filter(s=>feed?.has(s)&&(group||entryMap.get(m+':'+s)?.item.stamp===feed.get(s).stamp));
  const stamps=group?target.map(s=>webQuotes.current.US.get(s)?.stamp).filter(Boolean).sort():[];
  const last=group?stamps[stamps.length-1]:board.lastStamp;
  const prefix=group?'市场 ETF':m==='CN'?'A 股':'美股';
  const inWindow=routineHours(m),interval=inWindow?'15 秒':'60 秒';
  let status=webQuotes.pending[m]?'读取中':feed===null?'连接失败，保留已有数据':feed===undefined?'等待读取':matched.length+' / '+target.length+' 返回报价';
  label.textContent=prefix+' · '+status;
  const zone=m==='CN'?'北京时间':'美东时间';
  const wallTime=s=>Date.parse(s.replace(' ','T')+'Z');
  const delayed=last&&inWindow&&wallTime(quoteClocks[m].format(new Date()))-wallTime(last)>120000;
  const timeLabel=delayed?'源端报价较早 · ':!inWindow?'常规交易时段外 · ':'';
  document.getElementById('quoteMoment').textContent=(last?timeLabel+'最近报价 '+last+' '+zone:group?'尚未收到 ETF 报价':'榜单快照 '+(board.quoteDate||''))+' · '+interval+' 自动刷新';
  const btn=document.querySelector('[data-act="refreshQuotes"]');if(btn)btn.disabled=Boolean(webQuotes.pending[m]);
}
function etfQuotesPanel() {
  if(!webQuotes.enabled)return '';
  const items=marketEtfs.map(([s,name])=>{
    const q=webQuotes.current.US.get(s);
    return button('detail','benchmark:'+s,'<strong>'+esc(name)+'</strong><small>'+esc(s)+'</small><b class="'+tone(q?.changePct)+'">'+pct(q?.changePct)+'</b>','etf-tile');
  }).join('');
  return '<section class="panel etf-panel">'+sectionTitle('globe','美股上市 ETF 行情')+'<div class="etf-grid">'+items+'</div><div class="rankfoot">按基金交易价格计算涨跌幅，各基金报价时间可在详情查看。</div></section>';
}
function startQuotes() {
  if(!webQuotes.enabled)return;
  webQuotes.base={CN:ranks.CN,US:ranks.US};
  tickQuotes();
  webQuotes.timer=setInterval(()=>tickQuotes(),5000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)tickQuotes(true);});
  window.addEventListener('online',()=>tickQuotes(true));
}
