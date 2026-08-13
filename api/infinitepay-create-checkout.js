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
    const {orderId,subtotal_cents,cashback_cents,cep,name,email,phone,number,complement}=req.body||{};
    const subtotal=Number(subtotal_cents);
    const cashback=Math.max(0,Number(cashback_cents)||0);
    if(!orderId || !/^PP-[A-Z0-9-]+$/i.test(String(orderId))) return res.status(400).json({error:'Código do pedido inválido.'});
    if(!Number.isInteger(subtotal)||subtotal<100) return res.status(400).json({error:'Subtotal inválido.'});

    const delivery=await quoteDelivery(cep,subtotal);
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

    const upstream=await fetch('https://api.checkout.infinitepay.io/links',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    const raw=await upstream.text();
    let data; try{data=JSON.parse(raw);}catch{data={message:raw||'Resposta inválida da InfinitePay'};}
    if(!upstream.ok) return res.status(upstream.status).json({error:data.error||data.message||'Não foi possível criar o checkout da InfinitePay.',details:data});
    if(!data.url) return res.status(502).json({error:'A InfinitePay não retornou a URL de pagamento.'});

    return res.status(201).json({url:data.url,calculated:{subtotal_cents:subtotal,delivery_fee_cents:delivery.feeCents,cashback_cents:cashback,total_cents:total,delivery}});
  }catch(err){
    console.error('infinitepay-create-checkout error',err);
    return res.status(err.status||500).json({error:err.message||'Falha interna ao criar pagamento.'});
  }
};
