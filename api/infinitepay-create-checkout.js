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
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
  if(!r.ok) return 0;
  const doc=await r.json();
  const f=(doc.fields||{}).cashback||{};
  const value=Number(f.doubleValue ?? f.integerValue ?? 0);
  return Math.max(0,Math.round(value*100));
}

function publicBaseUrl(req){
  const proto=(req.headers['x-forwarded-proto']||'https').split(',')[0].trim();
  const host=(req.headers['x-forwarded-host']||req.headers.host||'puffpod.com.br').split(',')[0].trim();
  return `${proto}://${host}`;
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
      items:[{
        quantity:1,
        price:total,
        description:`Pedido Puffpod ${String(orderId).slice(0,80)}`
      }]
    };

    if(!payload.customer.phone_number || payload.customer.phone_number==='+55') delete payload.customer.phone_number;
    if(!payload.customer.email) delete payload.customer.email;
    if(!payload.customer.name) delete payload.customer.name;

    const endpoints=['https://api.checkout.infinitepay.io/links','https://api.infinitepay.io/invoices/public/checkout/links'];
    let upstream=null,data=null,lastNetworkError=null,usedEndpoint=null;
    for(const endpoint of endpoints){
      const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),15000);
      try{
        const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'Puffpod/1.0'},body:JSON.stringify(payload),signal:controller.signal});
        const raw=await r.text(); let parsed; try{parsed=JSON.parse(raw);}catch{parsed={message:raw||'Resposta inválida da InfinitePay'};}
        if(r.ok){upstream=r;data=parsed;usedEndpoint=endpoint;break;}
        if(r.status>=400 && r.status<500 && r.status!==404 && r.status!==405){return res.status(r.status).json({error:parsed.error||parsed.message||'A InfinitePay recusou os dados do checkout.',details:parsed});}
        lastNetworkError=new Error(parsed.error||parsed.message||('HTTP '+r.status));
      }catch(err){lastNetworkError=err;}
      finally{clearTimeout(timeout);}
    }
    if(!upstream){console.error('InfinitePay connection failed',lastNetworkError);return res.status(502).json({error:'Não foi possível conectar à InfinitePay. Confira se o Checkout Integrado está habilitado e tente novamente.',code:'INFINITEPAY_CONNECTION_FAILED'});}
    if(!data.url) return res.status(502).json({error:'A InfinitePay respondeu, mas não retornou a URL de pagamento.'});

    return res.status(201).json({url:data.url,providerEndpoint:usedEndpoint,calculated:{subtotal_cents:subtotal,delivery_fee_cents:delivery.feeCents,cashback_cents:cashback,total_cents:total,delivery}});
  }catch(err){
    console.error('infinitepay-create-checkout error',err);
    return res.status(err.status||500).json({error:err.message||'Falha interna ao criar pagamento.'});
  }
};
