'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const server = require('../server')
const ranks = require('../miniprogram/data/rankings')
const feeds = [
  ['rankings-CN','rankings?market=CN',ranks.CN], ['rankings-US','rankings?market=US',ranks.US],
  ['dragon','dragon',require('../miniprogram/data/dragon')], ['leaders','leaders',require('../miniprogram/data/leaders')]
]
const dest = path.resolve(process.argv[2] || path.join(root,'_site'))
const dateOf = pack => pack.quoteDate || pack.tradeDate || pack.asOf
const escapeJson = obj => JSON.stringify(obj).replace(/</g,'\\u003c')

function valid(kind, pack) {
  if (!pack || !Array.isArray(pack.rows) || !/^\d{4}-\d{2}-\d{2}$/.test(dateOf(pack)) || !pack.source) return false
  if (kind.startsWith('rankings-')) return pack.market === kind.slice(-2) && pack.rows.length === 50 &&
    pack.rows.every(r => r.symbol && r.name && Number.isFinite(r.marketCap) && Number.isFinite(r.price) && Number.isFinite(r.changePct))
  return pack.rows.every(r => r.symbol && r.name && (kind === 'leaders' ? Number.isInteger(r.streak) : Array.isArray(r.buySeats) && Array.isArray(r.sellSeats)))
}
async function previous(kind) {
  const base = process.env.PREVIOUS_SITE
  if (!base) return null
  const response = await fetch(base.replace(/\/$/,'')+'/data/'+kind+'.json', { signal:AbortSignal.timeout(15000),cache:'no-store' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('无法核对已发布版本 '+kind+' '+response.status)
  const pack = await response.json()
  if (!valid(kind, pack)) throw new Error('已发布数据结构异常 '+kind)
  return pack
}
async function collect(port, [kind,route,bundled]) {
  const prior = await previous(kind)
  const baseline = prior && dateOf(prior)>=dateOf(bundled) ? prior : bundled
  let chosen = { ...baseline, status: baseline.status === 'snapshot' ? 'snapshot' : 'stale' }
  try {
    const r = await fetch('http://127.0.0.1:'+port+'/api/'+route,{signal:AbortSignal.timeout(35000)})
    if (!r.ok) throw new Error('HTTP '+r.status)
    const pack = await r.json()
    if (valid(kind,pack) && ['eod','updated','quote'].includes(pack.status) && dateOf(pack)>=dateOf(baseline)) chosen=pack
  } catch (error) { console.warn(kind+': '+error.message) }
  await fs.writeFile(path.join(dest,'data',kind+'.json'), JSON.stringify(chosen))
  console.log(kind, chosen.status, dateOf(chosen), chosen.rows.length)
  return chosen
}
async function main() {
  await fs.mkdir(path.join(dest,'data'),{recursive:true})
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  try {
    const [cn,us,dragon,leaders] = await Promise.all(feeds.map(feed=>collect(server.address().port, feed)))
    let html = await fs.readFile(path.join(root,'preview.html'),'utf8')
    html=html.replace(/(<script id="marketdata" type="application\/json">)([\s\S]*?)(<\/script>)/,(_,a,b,c)=>a+escapeJson({...JSON.parse(b),dragon,leaders})+c)
      .replace(/(<script id="rankdata" type="application\/json">)([\s\S]*?)(<\/script>)/,(_,a,b,c)=>a+escapeJson({CN:cn,US:us})+c)
      .replace('离线快照</span>','行情快照</span>')
    await fs.writeFile(path.join(dest,'index.html'),html)
    await fs.writeFile(path.join(dest,'.nojekyll'),'')
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)) }
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
