import fs from 'fs';
import https from 'https';

const OUT_PATH = 'data/sentiment.json';
const CFTC_URL = 'https://www.cftc.gov/dea/newcot/FinFutWk.txt';

// Market substrings to look for (add/remove as needed)
// We normalize dashes & whitespace, compare uppercased.
const candidatePatterns = [
  'NASDAQ MINI - CHICAGO MERCANTILE EXCHANGE',
  'E-MINI NASDAQ-100',
  'MICRO E-MINI NASDAQ-100'
];

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

// Normalize: collapse whitespace, unify dashes, uppercase.
function norm(s){
  return s
    .replace(/[\u2012\u2013\u2014\u2212]/g,'-') // various dashes to hyphen
    .replace(/\s+/g,' ')
    .trim()
    .toUpperCase();
}

function toNumber(v){
  if(v == null) return 0;
  const cleaned = String(v).replace(/[,"]/g,'').replace(/\+/g,'').trim();
  const n = Number(cleaned);
  return isFinite(n) ? n : 0;
}

function toISO(md){
  if(!md) return md;
  if(/^\d{4}-\d{2}-\d{2}$/.test(md)) return md;
  // yymmdd (e.g. 250805)
  if(/^\d{6}$/.test(md)){
    const yy = md.slice(0,2);
    const mm = md.slice(2,4);
    const dd = md.slice(4,6);
    const year = Number(yy) > 70 ? '19'+yy : '20'+yy;
    return `${year}-${mm}-${dd}`;
  }
  if(/^\d{2}\/\d{2}\/\d{2,4}$/.test(md)){
    const [m,d,yr] = md.split('/');
    let y = yr;
    if(y.length===2){
      const n = Number(y);
      y = (n>70 ? '19':'20') + y;
    }
    return `${y}-${m}-${d}`;
  }
  return md;
}

// ------------- CSV Parsing -------------
function parseCSVLine(line){
  // Simple CSV parser with quoted fields
  const out = [];
  let cur = '';
  let inQuotes = false;
  for(let i=0;i<line.length;i++){
    const ch = line[i];
    if(ch === '"'){
      inQuotes = !inQuotes;
    } else if(ch === ',' && !inQuotes){
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(c=>c.trim());
}

// Column indices for the CSV (based on your sample)
// 0 market, 1 date_yymmdd, 2 date_iso, 7 open interest, 8 noncomm long, 9 noncomm short
const CSV_IDX_DATE_ISO = 2;
const CSV_IDX_NONCOMM_LONG = 8;
const CSV_IDX_NONCOMM_SHORT = 9;

function parseCSVRecord(line){
  const cols = parseCSVLine(line);
  if(cols.length < 10){
    throw new Error('CSV line too short to map Non-Comm columns');
  }
  const market = cols[0].replace(/^"|"$/g,'');
  const reportDate = toISO(cols[CSV_IDX_DATE_ISO] || cols[1]);
  const nonCommLong = toNumber(cols[CSV_IDX_NONCOMM_LONG]);
  const nonCommShort = toNumber(cols[CSV_IDX_NONCOMM_SHORT]);
  return { market, reportDate, nonCommLong, nonCommShort };
}

// ------------- Fixed-width Parsing (fallback) -------------
function parseFixedWidth(line){
  const parts = line.trim().split(/\s{2,}/);
  if(parts.length < 5){
    throw new Error('Unexpected fixed-width layout');
  }
  const market = parts[0];
  const dateToken = parts[1];
  // Heuristic for positions of Non-Comm Long/Short:
  // Try a few plausible pairs
  let nonCommLong = null, nonCommShort = null;
  for(const [iL,iS] of [[2,3],[3,4],[4,5],[5,6]]){
    const a = toNumber(parts[iL]);
    const b = toNumber(parts[iS]);
    if(a>0 || b>0){
      nonCommLong = a;
      nonCommShort = b;
      break;
    }
  }
  if(nonCommLong === null){
    throw new Error('Could not infer Non-Comm columns in fixed-width line');
  }
  return {
    market,
    reportDate: toISO(dateToken),
    nonCommLong,
    nonCommShort
  };
}

// ------------- Find Target Line -------------
function findTargetLine(lines){
  const normalizedLines = lines.map(l=>norm(l));
  for(const pattern of candidatePatterns){
    const p = norm(pattern);
    const idx = normalizedLines.findIndex(L=>L.includes(p));
    if(idx !== -1){
      return lines[idx];
    }
  }
  // Fuzzy fallback: any line with NASDAQ & MINI
  const idxFuzzy = normalizedLines.findIndex(L=>L.includes('NASDAQ') && L.includes('MINI'));
  if(idxFuzzy !== -1){
    console.log('Fuzzy matched (consider adding exact substring):', lines[idxFuzzy]);
    return lines[idxFuzzy];
  }
  // Diagnostics
  console.error('Did not find target line. Sample candidates:');
  normalizedLines
    .filter(L=>L.includes('NASDAQ') || L.includes('E-MINI'))
    .slice(0,8)
    .forEach(L=>console.error('> '+L));
  return null;
}

async function main(){
  const prev = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH,'utf8')) : null;

  const rawText = await fetchText(CFTC_URL);
  const lines = rawText.split(/\r?\n/).filter(l=>l.trim());

  const targetLine = findTargetLine(lines);
  if(!targetLine){
    throw new Error('Target market line not found in CFTC file');
  }

  let parsed;
  if(targetLine.includes(',')){
    parsed = parseCSVRecord(targetLine);
  } else {
    parsed = parseFixedWidth(targetLine);
  }

  const net = parsed.nonCommLong - parsed.nonCommShort;

  // Previous values for comparison if week changed
  let prevLong=null, prevShort=null, prevNet=null;
  if(prev?.cot?.weekEnding && prev.cot.weekEnding !== parsed.reportDate){
    for(const r of prev.cot.rows){
      if(r.label==='Non-Comm Long') prevLong = r.value;
      if(r.label==='Non-Comm Short') prevShort = r.value;
      if(r.label==='Non-Comm Net') prevNet = r.value;
    }
  }

  const cot = {
    weekEnding: parsed.reportDate,
    source: 'cftc-direct',
    instrument: parsed.market,
    rows: [
      {label:'Non-Comm Net', value: net, prev: prevNet, max: 500000},
      {label:'Non-Comm Long', value: parsed.nonCommLong, prev: prevLong, max: 600000},
      {label:'Non-Comm Short', value: parsed.nonCommShort, prev: prevShort, max: 600000}
    ]
  };

  const aaii = {
    weekEnding: parsed.reportDate,
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
  console.log('Parsed format:', targetLine.includes(',') ? 'CSV' : 'Fixed-width');
  console.log('Instrument:', cot.instrument);
  console.log('Non-Comm Long / Short / Net:', parsed.nonCommLong, parsed.nonCommShort, net);
}

main().catch(e=>{
  console.error('Sentiment build failed:', e.message);
  process.exit(1);
});
