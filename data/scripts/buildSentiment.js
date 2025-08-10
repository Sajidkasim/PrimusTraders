import fs from 'fs';
import https from 'https';

const API_KEY = process.env.BARCHART_API_KEY || '';
const SYMBOL = encodeURIComponent('E-mini NASDAQ-100');
const URL = `https://ondemand.websol.barchart.com/getCommitmentOfTraders.json?apikey=${API_KEY}&symbol=${SYMBOL}`;
const OUT_PATH = 'data/sentiment.json';

function fetchUrl(u){
  return new Promise((res,rej)=>{
    https.get(u,r=>{
      if(r.statusCode!==200){rej(new Error('HTTP '+r.statusCode));return;}
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d));
    }).on('error',rej);
  });
}
function num(v){const n=Number(v);return isFinite(n)?n:0;}

(async ()=>{
  const prev = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH,'utf8')) : null;

  let row;
  if(API_KEY){
    const raw = JSON.parse(await fetchUrl(URL));
    row = raw?.results?.[0];
    if(!row) throw new Error('No COT result from provider');
  } else if(prev?.cot){
    console.warn('No BARCHART_API_KEY; reusing previous snapshot.');
    row = {
      reportDate: prev.cot.weekEnding,
      nonCommLong: prev.cot.rows.find(r=>r.label==='Non-Comm Long')?.value,
      nonCommShort: prev.cot.rows.find(r=>r.label==='Non-Comm Short')?.value
    };
  } else {
    throw new Error('Missing API key and no previous data to reuse.');
  }

  const weekEnding = row.reportDate;
  const nonCommLong = num(row.nonCommLong);
  const nonCommShort = num(row.nonCommShort);
  const net = nonCommLong - nonCommShort;

  let prevLong=null, prevShort=null, prevNet=null;
  if(prev?.cot?.weekEnding && prev.cot.weekEnding !== weekEnding){
    for(const r of prev.cot.rows){
      if(r.label==='Non-Comm Long') prevLong=r.value;
      if(r.label==='Non-Comm Short') prevShort=r.value;
      if(r.label==='Non-Comm Net') prevNet=r.value;
    }
  }

  const cot = {
    weekEnding,
    source: API_KEY ? 'barchart' : (prev?.cot?.source || 'unknown'),
    instrument: 'NASDAQ-100 E-mini',
    rows: [
      {label:'Non-Comm Net', value:net, prev:prevNet, max:80000},
      {label:'Non-Comm Long', value:nonCommLong, prev:prevLong, max:180000},
      {label:'Non-Comm Short', value:nonCommShort, prev:prevShort, max:180000}
    ]
  };

  const aaii = {
    weekEnding,
    source: 'manual',
    data: [
      {label:'Bullish', pct:Number(process.env.AAII_BULLISH), prev:Number(process.env.AAII_BULLISH_PREV)},
      {label:'Neutral', pct:Number(process.env.AAII_NEUTRAL), prev:Number(process.env.AAII_NEUTRAL_PREV)},
      {label:'Bearish', pct:Number(process.env.AAII_BEARISH), prev:Number(process.env.AAII_BEARISH_PREV)}
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
})().catch(e=>{
  console.error('Sentiment build failed:', e.message);
  process.exit(1);
});
