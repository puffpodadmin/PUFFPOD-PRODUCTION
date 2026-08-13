const https = require('https');
const { quoteDelivery } = require('../lib/delivery');

function decodeUidFromToken(token){
  try{
    const part=String(token||'').split('.')[1];
    if(!part) return null;
    const json=Buffer.from(part.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');
    return JSON.parse(json).sub || null;
  }catch(e){ return null; }
}

async function getCashbackBalanceCents(req){
  const h=String(req.headers.authorization||'');
  if(!h.startsWith('Bearer ')) return 0;
  const token=h.slice(7), uid=decodeUidFromToken(token);
  if(!uid) return 0;
  const url=`https://firestore.googleapis.com/v1/projects/puffpod-28a24/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  try {
    const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
    if(!r.ok) return 0;
    const doc=await r.json();
    const f=(doc.fields||{}).cashback||{};
    const value=Number(f.doubleValue ?? f.integerValue ?? 0);
    return Math.max(0,Math.round(value*100));
  } catch { return 0; }
}

function publicBaseUrl(req){
  const proto=(req.headers['x-forwarded-proto']||'https').split(',')[0].trim();
  const host=(req.headers['x-forwarded-host']||req.headers.host||'puffpod.com.br').split(',')[0].trim();
  return `${proto}://${host}`;
}

function postJson(urlString, payload, timeoutMs=20000){
  return new Promise((resolve,reject)=>{
    const url=new URL(urlString);
    const body=Buffer.from(JSON.stringify(payload));
    const request=https.request({
      protocol:url.protocol,
      hostname:url.hostname,
      port:443,
      path:url.pathname+url.search,
      method:'POST',
      family:4,
      headers:{
        'Content-Type':'application/json',
        'Accept':'application/json',
        'Content-Length':body.length
      }
    }, response=>{
      let raw='';
      response.setEncoding('utf8');
      response.on('data',chunk=>raw+=chunk);
      response.on('end',()=>{
        let data;
        try{data=raw?JSON.parse(raw):{};}catch{data={message:raw||'Resposta inválida da InfinitePay'};}
        resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode||0,data,raw});
      });
    });
    request.setTimeout(timeoutMs,()=>request.destroy(new Error('Timeout ao conectar com a InfinitePay')));
    request.on('error',reject);
    request.write(body);
    request.end();
  });
}

function safeNetworkMessage(err){
  const code=err && err.code ? String(err.code) : '';
  if(code==='ENOTFOUND'||code==='EAI_AGAIN') return `Falha de DNS ao localizar a InfinitePay (${code}).`;
  if(code==='ETIMEDOUT') return 'Tempo esgotado ao conectar com a InfinitePay.';
  if(code==='ECONNRESET') return 'A conexão com a InfinitePay foi encerrada durante a solicitação.';
  return err && err.message ? String(err.message).slice(0,240) : 'Falha de conexão desconhecida.';
}

module.exports = async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  const handle=String(process.env.INFINITEPAY_HANDLE||'').replace(/^\$/,'').trim();
  if(!handle) return res.status(500).json({error:'INFINITEPAY_HANDLE não configurada na Vercel.'});

  try{
    const {orderId,subtotal_cents,cashback_cents,cep,name,email,phone,number,complement,street,neighborhood,city,state}=req.body||{};
    const subtotal=Number(subtotal_cents);
    const cashback=Math.max(0,Number(cashback_cents)||0);
    if(!orderId || !/^PP-[A-Z0-9-]+$/i.test(String(orderId))) return res.status(400).json({error:'Código do pedido inválido.'});
    if(!Number.isInteger(subtotal)||subtotal<100) return res.status(400).json({error:'Subtotal inválido.'});

    const delivery=await quoteDelivery(cep,subtotal,{street,neighborhood,city,state});
    const maxCashback=Math.max(0,subtotal+delivery.feeCents-100);
    if(!Number.isInteger(cashback)||cashback>maxCashback) return res.status(400).json({error:'Valor de cashback inválido.'});
    if(cashback>0){
      const available=await getCashbackBalanceCents(req);
      if(cashback>available) return res.status(403).json({error:'Saldo de cashback insuficiente ou sessão expirada.'});
    }

    const total=subtotal+delivery.feeCents-cashback;
    if(total<100) return res.status(400).json({error:'O total mínimo para pagamento é R$ 1,00.'});

    const base=publicBaseUrl(req);
    const payload={
      handle,
      redirect_url:`${base}/checkout.html?infinitepay_return=1`,
      webhook_url:`${base}/api/infinitepay-webhook`,
      order_nsu:String(orderId),
      customer:{
        name:String(name||'').trim().slice(0,120),
        email:String(email||'').trim().slice(0,180),
        phone_number:(()=>{const d=String(phone||'').replace(/\D/g,''); return d ? '+'+(d.startsWith('55')?d:'55'+d) : '';})()
      },
      address:{
        cep:String(cep||'').replace(/\D/g,'').slice(0,8),
        street:String(street||delivery.address?.street||'').trim().slice(0,160),
        neighborhood:String(neighborhood||delivery.address?.neighborhood||'').trim().slice(0,100),
        number:String(number||'').trim().slice(0,30),
        complement:String(complement||'').trim().slice(0,100)
      },
      items:[{quantity:1,price:total,description:`Pedido Puffpod ${String(orderId).slice(0,80)}`}]
    };
    if(!payload.customer.phone_number || payload.customer.phone_number==='+55') delete payload.customer.phone_number;
    if(!payload.customer.email) delete payload.customer.email;
    if(!payload.customer.name) delete payload.customer.name;
    if(!payload.address.cep) delete payload.address;

    // Endpoint atual oficial; o endpoint antigo fica apenas como fallback de compatibilidade.
    const endpoints=['https://api.checkout.infinitepay.io/links','https://api.infinitepay.io/invoices/public/checkout/links'];
    const attempts=[];
    for(const endpoint of endpoints){
      try{
        const result=await postJson(endpoint,payload,20000);
        attempts.push({endpoint,status:result.status});
        if(result.ok){
          if(!result.data || !result.data.url) return res.status(502).json({error:'A InfinitePay respondeu, mas não retornou a URL de pagamento.',provider_status:result.status});
          return res.status(201).json({url:result.data.url,providerEndpoint:endpoint,calculated:{subtotal_cents:subtotal,delivery_fee_cents:delivery.feeCents,cashback_cents:cashback,total_cents:total,delivery}});
        }
        // 4xx indica que a API foi alcançada e recusou o payload/configuração.
        if(result.status>=400&&result.status<500){
          const providerMessage=result.data?.error||result.data?.message||result.data?.detail||'A InfinitePay recusou a solicitação.';
          return res.status(result.status).json({error:String(providerMessage),provider_status:result.status,provider_details:result.data});
        }
        attempts[attempts.length-1].message=result.data?.message||result.data?.error||`HTTP ${result.status}`;
      }catch(err){
        attempts.push({endpoint,network_error:safeNetworkMessage(err),code:err?.code||null});
      }
    }
    console.error('InfinitePay connection failed',attempts);
    return res.status(502).json({
      error:'Não foi possível conectar à InfinitePay.',
      code:'INFINITEPAY_CONNECTION_FAILED',
      diagnostic:attempts,
      hint:'Se aparecer ENOTFOUND/EAI_AGAIN, é falha de DNS/rede. Se aparecer HTTP 5xx, a API da InfinitePay respondeu com indisponibilidade.'
    });
  }catch(err){
    console.error('infinitepay-create-checkout error',err);
    return res.status(err.status||500).json({error:err.message||'Falha interna ao criar pagamento.'});
  }
};
