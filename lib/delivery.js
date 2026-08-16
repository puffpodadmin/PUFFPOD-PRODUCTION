const CURITIBA = { lat: -25.4284, lon: -49.2733 };
const SURCHARGE_CENTS = 290;
const FREE_SHIPPING_CENTS = 25000;

function norm(value){
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

const ZONE_990 = new Set([
  'sao braz','santo inacio','orleans','santa felicidade','cascatinha'
].map(norm));

const ZONE_1490 = new Set([
  'butiatuvinha','sao joao','vista alegre','mossungue','campina do siqueira','lamenha pequena','pilarzinho','taboao',
  'merces','bigorrilho','bom retiro','sao francisco','centro civico','seminario','campo comprido','santa quiteria','batel',
  'centro','agua verde','vila izabel','portao','fazendinha','guaira','reboucas','parolin','ahu','sao lourenco'
].map(norm));

const ZONE_1790 = new Set([
  'juveve','cabral','alto da gloria','alto da rua xv','alto da xv','hugo lange','jardim social','jardim botanico','cristo rei','prado velho','boa vista','barreirinha',
  'fanny','lindoia','novo mundo','capao raso','pinheirinho',
  'taruma','capao da imbuia','cajuru','jardim das americas','guabirotuba',
  'bacacheri','tingui','atuba','santa candida','cachoeira','abranches',
  'cidade industrial','cidade industrial de curitiba','cic','augusta','sao miguel','riviera'
].map(norm));

const ZONE_1990 = new Set([
  'hauer','xaxim','boqueirao','uberaba','bairro alto','alto boqueirao','sitio cercado','ganchinho','umbara','tatuquara','campo de santana','caximba'
].map(norm));

function baseFeeForNeighborhood(neighborhood){
  const n = norm(neighborhood);
  if(ZONE_990.has(n)) return 990;
  if(ZONE_1490.has(n)) return 1490;
  if(ZONE_1790.has(n)) return 1790;
  if(ZONE_1990.has(n)) return 1990;
  return null;
}

function curitibaClockParts(date = new Date()){
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:'America/Sao_Paulo', weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(date).reduce((a,p)=>{a[p.type]=p.value;return a;},{});
  const day = parts.weekday;
  const minutes = Number(parts.hour)*60 + Number(parts.minute);
  return { day, minutes };
}

function isPeakNow(date = new Date()){
  const {day, minutes} = curitibaClockParts(date);
  const between = (a,b) => minutes >= a && minutes <= b;
  if(['Mon','Tue','Wed','Thu','Fri'].includes(day)) return between(11*60+30,13*60+30) || between(17*60,20*60+30);
  if(day === 'Sat') return between(11*60+30,14*60) || between(18*60,20*60+30);
  return false;
}

let weatherCache = { at:0, value:null };
async function getWeatherRisk(){
  if(weatherCache.value && Date.now() - weatherCache.at < 5*60*1000) return weatherCache.value;
  try{
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${CURITIBA.lat}&longitude=${CURITIBA.lon}&current=precipitation,rain,showers,weather_code,wind_gusts_10m&timezone=America%2FSao_Paulo`;
    const r = await fetch(url, { headers:{'Accept':'application/json'} });
    if(!r.ok) throw new Error('weather');
    const data = await r.json();
    const c = data.current || {};
    const code = Number(c.weather_code || 0);
    const precipitation = Number(c.precipitation || 0);
    const gust = Number(c.wind_gusts_10m || 0);
    const badCode = code === 45 || code === 48 || code >= 51;
    const bad = precipitation >= 0.2 || badCode || gust >= 40;
    const reasons = [];
    if(precipitation >= 0.2 || code >= 51) reasons.push('chuva');
    if(code === 45 || code === 48) reasons.push('neblina');
    if(gust >= 40) reasons.push('vento forte');
    weatherCache = { at:Date.now(), value:{bad, reasons, precipitation, gust, code} };
    return weatherCache.value;
  }catch(e){
    return {bad:false,reasons:[],unavailable:true};
  }
}

async function fetchJsonWithTimeout(url, ms=7000){
  const controller=new AbortController(); const t=setTimeout(()=>controller.abort(),ms);
  try{const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'Puffpod/1.0'},signal:controller.signal});if(!r.ok)throw new Error('HTTP '+r.status);return await r.json();}finally{clearTimeout(t);}
}
async function lookupCep(cep, fallbackAddress){
  const digits = String(cep || '').replace(/\D/g,'');
  if(digits.length !== 8) throw Object.assign(new Error('CEP inválido.'),{status:400});
  try{
    const data=await fetchJsonWithTimeout(`https://viacep.com.br/ws/${digits}/json/`);
    if(data.erro) throw Object.assign(new Error('CEP não encontrado.'),{status:404});
    return data;
  }catch(firstErr){
    try{
      const d=await fetchJsonWithTimeout(`https://brasilapi.com.br/api/cep/v1/${digits}`);
      return {cep:digits,logradouro:d.street||'',bairro:d.neighborhood||'',localidade:d.city||'',uf:d.state||''};
    }catch(secondErr){
      const f=fallbackAddress||{};
      if(String(f.neighborhood||'').trim() && String(f.city||'').trim() && String(f.state||'').trim()){
        return {cep:digits,logradouro:String(f.street||''),bairro:String(f.neighborhood||''),localidade:String(f.city||''),uf:String(f.state||'')};
      }
      const err=Object.assign(new Error('Não foi possível consultar o CEP agora. Tente novamente em alguns instantes.'),{status:502});
      err.cause=secondErr; throw err;
    }
  }
}

async function quoteDelivery(cep, subtotalCents, fallbackAddress){
  const address = await lookupCep(cep, fallbackAddress);
  if(norm(address.localidade) !== 'curitiba' || String(address.uf || '').toUpperCase() !== 'PR'){
    throw Object.assign(new Error('No momento, as entregas automáticas estão disponíveis apenas para Curitiba/PR.'),{status:422});
  }
  const baseFeeCents = baseFeeForNeighborhood(address.bairro);
  if(baseFeeCents == null){
    throw Object.assign(new Error(`Ainda não temos uma tarifa automática para o bairro ${address.bairro || 'informado'}. Fale com a Puffpod.`),{status:422});
  }
  const subtotal = Math.max(0, Number(subtotalCents) || 0);
  const freeShipping = subtotal >= FREE_SHIPPING_CENTS;
  const peak = isPeakNow();
  const weather = await getWeatherRisk();
  const surchargeActive = !freeShipping && (peak || weather.bad);
  const surchargeCents = surchargeActive ? SURCHARGE_CENTS : 0;
  const feeCents = freeShipping ? 0 : baseFeeCents + surchargeCents;
  const reasons = [];
  if(peak) reasons.push('horário de pico');
  if(weather.bad) reasons.push(weather.reasons.length ? `condição climática (${weather.reasons.join(', ')})` : 'condição climática desfavorável');
  return {
    address:{ cep:address.cep, street:address.logradouro || '', neighborhood:address.bairro || '', city:address.localidade || '', state:address.uf || '' },
    baseFeeCents, surchargeCents, feeCents, freeShipping, surchargeActive, reasons,
    peak, weatherBad:!!weather.bad
  };
}

module.exports = { quoteDelivery, FREE_SHIPPING_CENTS, SURCHARGE_CENTS };
