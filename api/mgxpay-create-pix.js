const QRCode=require('../lib/qrcode');
const QRErrorCorrectLevel=require('../lib/qrcode/QRErrorCorrectLevel');
const { getAdmin }=require('../lib/firebase-admin');
const { quoteDelivery }=require('../lib/delivery');

function qrSvg(text){
  const qr=new QRCode(-1,QRErrorCorrectLevel.M); qr.addData(String(text)); qr.make();
  const n=qr.getModuleCount(),quiet=4,size=n+quiet*2; let path='';
  for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(qr.isDark(r,c))path+=`M${c+quiet} ${r+quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR Code Pix"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
function baseUrl(req){const proto=String(req.headers['x-forwarded-proto']||'https').split(',')[0].trim(),host=String(req.headers['x-forwarded-host']||req.headers.host||'puffpod.com.br').split(',')[0].trim();return `${proto}://${host}`;}
function digits(v){return String(v||'').replace(/\D/g,'');}

module.exports=async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  try{
    const clientId=String(process.env.MGXPAY_CLIENT_ID||'').trim(),clientSecret=String(process.env.MGXPAY_CLIENT_SECRET||'').trim(),webhookSecret=String(process.env.MGXPAY_WEBHOOK_SECRET||'').trim();
    if(!clientId||!clientSecret) return res.status(500).json({error:'Credenciais MGXPay não configuradas na Vercel.'});
    if(!webhookSecret) return res.status(500).json({error:'MGXPAY_WEBHOOK_SECRET não configurado na Vercel.'});
    const auth=String(req.headers.authorization||''); if(!auth.startsWith('Bearer '))return res.status(401).json({error:'Sessão do checkout não encontrada.'});
    const admin=getAdmin(),decoded=await admin.auth().verifyIdToken(auth.slice(7)),db=admin.firestore();
    const orderId=String(req.body?.orderId||'').trim(); if(!/^PP-[A-Z0-9-]+$/i.test(orderId))return res.status(400).json({error:'Código do pedido inválido.'});
    const ref=db.collection('orders').doc(orderId),snap=await ref.get(); if(!snap.exists)return res.status(404).json({error:'Pedido não encontrado.'});
    const order=snap.data()||{}; if(String(order.uid||'')!==decoded.uid)return res.status(403).json({error:'Este pedido não pertence à sua sessão.'});
    const subtotalCents=Math.round(Number(order.subtotal||0)*100); if(subtotalCents<100)return res.status(400).json({error:'Subtotal inválido.'});
    const address=order.delivery||{}; const delivery=await quoteDelivery(address.cep,subtotalCents,address);
    let cashbackCents=Math.max(0,Math.round(Number(order.cashbackUsed||0)*100));
    if(!order.isGuest&&cashbackCents>0){const us=await db.collection('users').doc(decoded.uid).get();const available=Math.round(Number(us.data()?.cashback||0)*100);cashbackCents=Math.min(cashbackCents,available);}else if(order.isGuest)cashbackCents=0;
    const totalCents=subtotalCents+delivery.feeCents-cashbackCents; if(totalCents<100)return res.status(400).json({error:'O total mínimo é R$ 1,00.'});
    const callback=`${baseUrl(req)}/api/mgxpay-webhook?token=${encodeURIComponent(webhookSecret)}`;
    const form=new URLSearchParams();
    form.set('client_id',clientId);form.set('client_secret',clientSecret);form.set('nome',String(order.name||'Cliente Puffpod').slice(0,120));form.set('cpf',digits(order.cpf).slice(0,14));form.set('valor',(totalCents/100).toFixed(2));form.set('descricao',`Pedido Puffpod ${orderId}`);form.set('urlnoty',callback);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    let upstream; try{upstream=await fetch('https://app.mgxpay.com.br/v3/pix/qrcode',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:form.toString(),signal:controller.signal});}finally{clearTimeout(timer);}
    const raw=await upstream.text();let data;try{data=JSON.parse(raw);}catch{data={message:raw};}
    if(!upstream.ok)return res.status(upstream.status).json({error:data?.message||'A MGXPay recusou a cobrança.',provider_status:upstream.status});
    if(!data?.transactionId||!data?.qrcode)return res.status(502).json({error:'A MGXPay respondeu sem transactionId ou QR Code.'});
    const transactionId=String(data.transactionId);
    await ref.set({total:totalCents/100,cashbackUsed:cashbackCents/100,delivery:{...address,baseFee:delivery.baseFeeCents/100,surcharge:delivery.surchargeCents/100,fee:delivery.feeCents/100,surchargeReasons:delivery.reasons||[]},paymentMethod:'mgxpay',paymentStatus:'pending',status:'pending_payment',mgxpay:{transactionId,status:String(data.status||'PENDING'),amount:Number(data.amount??totalCents/100),qrcode:String(data.qrcode),createdAt:admin.firestore.FieldValue.serverTimestamp()}},{merge:true});
    return res.status(201).json({transactionId,status:String(data.status||'PENDING'),amount:Number(data.amount??totalCents/100),qrcode:String(data.qrcode),qrSvg:qrSvg(data.qrcode),calculated:{subtotal_cents:subtotalCents,delivery_fee_cents:delivery.feeCents,cashback_cents:cashbackCents,total_cents:totalCents}});
  }catch(err){console.error('mgxpay-create-pix',err);return res.status(502).json({error:err.name==='AbortError'?'Tempo esgotado ao conectar com a MGXPay.':(err.message||'Falha ao gerar PIX na MGXPay.')});}
};
