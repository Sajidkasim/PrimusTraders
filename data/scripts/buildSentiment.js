import fs from 'fs';
import https from 'https';

const OUT_PATH = 'data/sentiment.json';
const TARGET_SUBSTRING = 'E-MINI NASDAQ-100 STOCK INDEX';
const CFTC_URL = 'https://www.cftc.gov/dea/newcot/FinFutWk.txt';

function fetchText(url){
  return new Promise((resolve,reject)=>{
    https.get(url,res=>{
      if(res.statusCode !== 200){
        reject(new Error('HTTP '+res.statusCode));
        return;
      }
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>resolve(data));
    }).on('error',reject);
  });
}

function toNumber(s){
  if(s==null) return 0;
  const n = Number(String(s).replace(/,/g,'').trim());
  return isFinite(n) ? n : 0;
}

function toISO(md){
  if(!/^\d{2}\/\d{2}\/\d{2,4}$/.test(md)) return md;
  const [m,d,yRaw] = md.split('/');
  let y = yRaw;
  if(y.length === 2){
    const yr = Number(y);
    y = (yr > 70 ? '19' : '20') + y;
  }
  return `${y}-${m}-${d}`;
}

function extractRow(lines){
  for(const line of lines){
    if(!line.includes(TARGET_SUBSTRING)) continue;
    const parts = line.trim().split(/\s{2,}/);
    if(parts.length < 5) continue;
    const market = parts[0];
    const reportDate = toISO(parts[1]);
    const nonCommLong = toNumber(parts[2]);
    const nonCommShort = toNumber(parts[3]);
    return { market, reportDate, nonCommLong, nonCommShort };
  }
  throw new Error('Target market line not found in CFTC file');
}

async function main(){
  const prev = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH,'utf8')) : null;

  const text = await fetchText(CFTC_URL);
  const lines = text.split(/\r?\n/).filter(l=>l.trim());
  const row = extractRow(lines);

  const net = row.nonCommLong - row.nonCommShort;

  let prevLong=null, prevShort=null, prevNet=null;
  if(prev?.cot?.weekEnding && prev.cot.weekEnding !== row.reportDate){
    for(const r of prev.cot.rows){
      if(r.label==='Non-Comm Long') prevLong = r.value;
      if(r.label==='Non-Comm Short') prevShort = r.value;
      if(r.label==='Non-Comm Net') prevNet = r.value;
    }
  }

  const cot = {
    weekEnding: row.reportDate,
    source: 'cftc-direct',
    instrument: row.market,
    rows: [
      {label:'Non-Comm Net', value:net, prev:prevNet, max:80000},
      {label:'Non-Comm Long', value:row.nonCommLong, prev:prevLong, max:180000},
      {label:'Non-Comm Short', value:row.nonCommShort, prev:prevShort, max:180000}
    ]
  };

  const aaii = {
    weekEnding: row.reportDate,
    source: 'manual',
    data: [
      {label:'Bullish', pct:Number(process.env.AAII_BULLISH)||0, prev:Number(process.env.AAII_BULLISH_PREV)||0},
      {label:'Neutral', pct:Number(process.env.AAII_NEUTRAL)||0, prev:Number(process.env.AAII_NEUTRAL_PREV)||0},
      {label:'Bearish', pct:Number(process.env.AAII_BEARISH)||0, prev:Number(process.env.AAII_BEARISH_PREV)||0}
    ]
  };

  const output = {
    cot,
    aaii,
    updated: new Date().toISOString(),
    version: 1
  };

  fs.mkdirSync('data',{recursive:true});
  fs.writeFileSync(OUT_PATH, JSON.stringify(output,null,2));
  console.log('Wrote', OUT_PATH);
}

main().catch(e=>{
  console.error('Sentiment build failed:', e.message);
  process.exit(1);
});
