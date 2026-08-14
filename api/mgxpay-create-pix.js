const { quoteDelivery } = require('../lib/delivery');
const { getAdmin } = require('../lib/firebase-admin');
const QRCode = require('qrcode');

function decodeUidFromToken(token){
  try{
    const part=String(token||'').split('.')[1];
    if(!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8')).sub || null;
  }catch(e){ return null; }
}

async function getCashbackBalanceCents(req){
  const h=String(req.headers.authorization||'');
  if(!h.startsWith('Bearer ')) return 0;
  const token=h.slice(7), uid=decodeUidFromToken(token);
  if(!uid) return 0;
  const url=`https://firestore.googleapis.com/v1/projects/puffpod-28a24/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  try{
    const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
    if(!r.ok) return 0;
    const doc=await r.json();
    const f=(doc.fields||{}).cashback||{};
    return Math.max(0,Math.round(Number(f.doubleValue ?? f.integerValue ?? 0)*100));
  }catch(e){ return 0; }
}

function publicBaseUrl(req){
  const proto=(req.headers['x-forwarded-proto']||'https').split(',')[0].trim();
  const host=(req.headers['x-forwarded-host']||req.headers.host||'puffpod.com.br').split(',')[0].trim();
  return `${proto}://${host}`;
}

module.exports = async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  const clientId=String(process.env.MGXPAY_CLIENT_ID||'').trim();
  const clientSecret=String(process.env.MGXPAY_CLIENT_SECRET||'').trim();
  const webhookToken=String(process.env.MGXPAY_WEBHOOK_TOKEN||'').trim();
  if(!clientId||!clientSecret) return res.status(500).json({error:'Credenciais MGXPay não configuradas na Vercel.'});
  if(!webhookToken) return res.status(500).json({error:'MGXPAY_WEBHOOK_TOKEN não configurada na Vercel.'});

  try{
    const {orderId,subtotal_cents,cashback_cents,cep,name,cpf,number,complement,street,neighborhood,city,state}=req.body||{};
    const subtotal=Number(subtotal_cents), cashback=Math.max(0,Number(cashback_cents)||0);
    const cpfDigits=String(cpf||'').replace(/\D/g,'');
    if(!orderId || !/^PP-[A-Z0-9-]+$/i.test(String(orderId))) return res.status(400).json({error:'Código do pedido inválido.'});
    if(!Number.isInteger(subtotal)||subtotal<100) return res.status(400).json({error:'Subtotal inválido.'});
    if(cpfDigits.length!==11 && cpfDigits.length!==14) return res.status(400).json({error:'CPF/CNPJ do pagador inválido.'});

    const delivery=await quoteDelivery(cep,subtotal,{street,neighborhood,city,state});
    const maxCashback=Math.max(0,subtotal+delivery.feeCents-100);
    if(!Number.isInteger(cashback)||cashback>maxCashback) return res.status(400).json({error:'Valor de cashback inválido.'});
    if(cashback>0){
      const available=await getCashbackBalanceCents(req);
      if(cashback>available) return res.status(403).json({error:'Saldo de cashback insuficiente ou sessão expirada.'});
    }
    const total=subtotal+delivery.feeCents-cashback;
    if(total<100) return res.status(400).json({error:'O total mínimo para pagamento é R$ 1,00.'});

    const form=new URLSearchParams();
    form.set('client_id',clientId);
    form.set('client_secret',clientSecret);
    form.set('nome',String(name||'Cliente Puffpod').trim().slice(0,120));
    form.set('cpf',cpfDigits);
    form.set('valor',(total/100).toFixed(2));
    form.set('descricao',`Pedido Puffpod ${String(orderId)}`.slice(0,180));
    form.set('urlnoty',`${publicBaseUrl(req)}/api/mgxpay-webhook?token=${encodeURIComponent(webhookToken)}`);

    const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),20000);
    let upstream;
    try{
      upstream=await fetch('https://app.mgxpay.com.br/v3/pix/qrcode',{
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
        body:form.toString(),signal:controller.signal
      });
    }finally{ clearTimeout(timeout); }
    const raw=await upstream.text(); let data; try{data=JSON.parse(raw);}catch(e){data={message:raw||'Resposta inválida da MGXPay'};}
    if(!upstream.ok) return res.status(upstream.status).json({error:data.message||data.error||`MGXPay retornou HTTP ${upstream.status}.`});
    if(!data.qrcode||!data.transactionId) return res.status(502).json({error:'A MGXPay não retornou QR Code ou transactionId.',details:data});

    let qrDataUrl=null;
    try{ qrDataUrl=await QRCode.toDataURL(String(data.qrcode),{width:460,margin:1,errorCorrectionLevel:'M'}); }catch(e){ console.error('QR render error',e); }

    try{
      const admin=getAdmin(), db=admin.firestore();
      await db.collection('orders').doc(String(orderId)).set({
        total:total/100,
        delivery:{fee:delivery.feeCents/100,baseFee:delivery.baseFeeCents/100,surcharge:delivery.surchargeCents/100},
        paymentMethod:'mgxpay',paymentStatus:'pending',status:'pending_payment',
        mgxpay:{transactionId:String(data.transactionId),status:String(data.status||'PENDING'),amount:Number(data.amount ?? total/100),createdAt:admin.firestore.FieldValue.serverTimestamp()}
      },{merge:true});
    }catch(e){ console.error('MGXPay order server update failed',e); }

    return res.status(200).json({
      success:true,transactionId:String(data.transactionId),status:String(data.status||'PENDING'),amount:Number(data.amount ?? total/100),qrcode:String(data.qrcode),qrDataUrl,
      calculated:{subtotal_cents:subtotal,delivery_fee_cents:delivery.feeCents,cashback_cents:cashback,total_cents:total}
    });
  }catch(err){
    console.error('mgxpay-create-pix',err);
    const msg=err&&err.name==='AbortError'?'Tempo esgotado ao conectar com a MGXPay.':(err.message||'Não foi possível gerar o PIX na MGXPay.');
    return res.status(502).json({error:msg});
  }
};
