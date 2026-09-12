const DEFAULT_BASE_URL = 'https://api.payzu.processamento.com/v1';

function baseUrl(){
  return String(process.env.PAYZU_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/,'');
}
function tokenFor(type='deposit'){
  if(type==='withdraw'){
    return String(process.env.PAYZU_WITHDRAW_TOKEN || '').trim();
  }
  return String(process.env.PAYZU_DEPOSIT_TOKEN || '').trim();
}
function requireToken(type='deposit'){
  const t=tokenFor(type);
  if(!t){
    const envName=type==='withdraw'?'PAYZU_WITHDRAW_TOKEN':'PAYZU_DEPOSIT_TOKEN';
    throw new Error(`${envName} não configurado na Vercel.`);
  }
  return t;
}
async function payzuFetch(path, options={}){
  const tokenType=options.tokenType==='withdraw'?'withdraw':'deposit';
  const t=requireToken(tokenType);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(), Number(options.timeoutMs||20000));
  try{
    const res=await fetch(baseUrl()+path,{
      method:options.method||'GET',
      headers:{
        'Authorization':`Bearer ${t}`,
        'Content-Type':'application/json',
        'Accept':'application/json',
        ...(options.headers||{})
      },
      body: options.body===undefined ? undefined : JSON.stringify(options.body),
      signal:controller.signal
    });
    const raw=await res.text();
    let data={};
    try{ data=raw?JSON.parse(raw):{}; }catch{ data={message:raw}; }
    if(!res.ok){
      const err=new Error(data.message||data.error||`PayZu retornou HTTP ${res.status}.`);
      err.status=res.status;
      err.requestId=data.requestId||null;
      err.errorCode=data.errorCode||null;
      err.details=data;
      throw err;
    }
    return data;
  }catch(err){
    if(err && err.name==='AbortError') throw new Error('Tempo esgotado ao conectar com a PayZu.');
    throw err;
  }finally{
    clearTimeout(timer);
  }
}
function publicBaseUrl(req){
  const proto=String(req.headers['x-forwarded-proto']||'https').split(',')[0].trim();
  const host=String(req.headers['x-forwarded-host']||req.headers.host||'puffpod.com.br').split(',')[0].trim();
  return `${proto}://${host}`;
}
function webhookUrl(req){
  const secret=String(process.env.PAYZU_WEBHOOK_TOKEN||'').trim();
  if(!secret) throw new Error('PAYZU_WEBHOOK_TOKEN não configurado na Vercel.');
  return `${publicBaseUrl(req)}/api/payzu-webhook?token=${encodeURIComponent(secret)}`;
}
function normalizePixType(v){
  const x=String(v||'').trim().toLowerCase();
  if(x==='random') return 'evp';
  return ['cpf','cnpj','phone','email','evp'].includes(x)?x:'';
}
module.exports={payzuFetch,publicBaseUrl,webhookUrl,normalizePixType,tokenFor};
