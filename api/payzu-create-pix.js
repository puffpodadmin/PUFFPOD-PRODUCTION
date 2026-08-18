const { quoteDelivery } = require('../lib/delivery');
const { getAdmin } = require('../lib/firebase-admin');
const { payzuFetch, webhookUrl } = require('../lib/payzu');

async function verifiedSubtotalFromCatalog(db,items,submittedSubtotal){
  if(!Array.isArray(items)||!items.length) return submittedSubtotal;
  let total=0;
  for(const item of items){
    const qty=Math.max(1,Math.min(99,parseInt(item.qty,10)||1));
    let unit=Math.max(0,Number(item.price)||0);
    const id=String(item.id||'').trim();
    if(id){
      const snap=await db.collection('products').doc(id).get();
      if(snap.exists){
        const d=snap.data()||{};
        const regular=Number(d.price);
        const promo=Number(d.promotionPrice);
        if(d.promotionActive===true && Number.isFinite(promo)&&promo>0) unit=promo;
        else if(Number.isFinite(regular)&&regular>0) unit=regular;
      }
    }
    total += Math.round(unit*100)*qty;
  }
  return total>0?total:submittedSubtotal;
}
function cleanName(v){
  return String(v||'Cliente Puffpod').replace(/[^a-zA-ZÀ-ÿ\s]/g,' ').replace(/\s+/g,' ').trim().slice(0,120)||'Cliente Puffpod';
}

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const auth=String(req.headers.authorization||'');
    if(!auth.startsWith('Bearer ')) return res.status(401).json({error:'Sessão do checkout não encontrada.'});

    const admin=getAdmin(),db=admin.firestore();
    const decoded=await admin.auth().verifyIdToken(auth.slice(7));

    const b=req.body||{};
    const orderId=String(b.orderId||'');
    const submittedSubtotal=Number(b.subtotal_cents);
    const cashback=Math.max(0,Number(b.cashback_cents)||0);
    const cpfDigits=String(b.cpf||'').replace(/\D/g,'');

    if(!orderId||!/^PP-[A-Z0-9-]+$/i.test(orderId)) return res.status(400).json({error:'Código do pedido inválido.'});
    if(!Number.isInteger(submittedSubtotal)||submittedSubtotal<100) return res.status(400).json({error:'Subtotal inválido.'});
    if(![11,14].includes(cpfDigits.length)) return res.status(400).json({error:'CPF/CNPJ do pagador inválido.'});

    const subtotal=await verifiedSubtotalFromCatalog(db,b.items,submittedSubtotal);
    const delivery=await quoteDelivery(b.cep,subtotal,{street:b.street,neighborhood:b.neighborhood,city:b.city,state:b.state});

    let cashbackAvailableCents=0;
    const userSnap=await db.collection('users').doc(decoded.uid).get();
    if(userSnap.exists && !decoded.firebase?.sign_in_provider?.includes('anonymous')){
      cashbackAvailableCents=Math.max(0,Math.round(Number(userSnap.data().cashback||0)*100));
    }
    const maxCashback=Math.max(0,subtotal+delivery.feeCents-100);
    if(!Number.isInteger(cashback)||cashback>maxCashback||cashback>cashbackAvailableCents){
      return res.status(400).json({error:'Valor de cashback inválido ou saldo insuficiente.'});
    }

    const total=subtotal+delivery.feeCents-cashback;
    if(total<100) return res.status(400).json({error:'O total mínimo para Pix é R$ 1,00.'});

    const callbackUrl=webhookUrl(req);
    const payload={
      amount:Number((total/100).toFixed(2)),
      generatedName:cleanName(b.name),
      generatedDocument:cpfDigits,
      generatedEmail:String(b.email||'').trim().slice(0,180)||undefined,
      callbackUrl,
      clientReference:orderId,
      expiresIn:900
    };
    Object.keys(payload).forEach(k=>payload[k]===undefined&&delete payload[k]);

    const data=await payzuFetch('/pix',{method:'POST',body:payload,tokenType:'deposit'});
    if(!data.id||!data.qrCodeText) throw new Error('A PayZu não retornou o QR Code da cobrança.');

    await db.collection('orders').doc(orderId).set({
      uid:decoded.uid,
      total:total/100,
      subtotal:subtotal/100,
      cashbackUsed:cashback/100,
      delivery:{
        fee:delivery.feeCents/100,
        baseFee:delivery.baseFeeCents/100,
        surcharge:delivery.surchargeCents/100
      },
      status:'pending_payment',
      paymentStatus:'pending',
      paymentMethod:'payzu',
      payzu:{
        transactionId:String(data.id),
        status:String(data.status||'PENDING'),
        amount:Number(data.amount||total/100),
        serviceFeeCharged:Number(data.serviceFeeCharged||0),
        clientReference:orderId,
        qrCodeUrl:data.qrCodeUrl||null,
        createdAt:admin.firestore.FieldValue.serverTimestamp()
      }
    },{merge:true});

    return res.status(200).json({
      ok:true,
      transactionId:String(data.id),
      status:String(data.status||'PENDING'),
      amount:Number(data.amount||total/100),
      qrCodeText:String(data.qrCodeText),
      qrCodeUrl:data.qrCodeUrl||null,
      qrCodeBase64:data.qrCodeBase64||null,
      expiresIn:900,
      calculated:{
        subtotal_cents:subtotal,
        delivery_fee_cents:delivery.feeCents,
        cashback_cents:cashback,
        total_cents:total
      }
    });
  }catch(err){
    console.error('payzu-create-pix',{
      message:err.message,
      requestId:err.requestId,
      errorCode:err.errorCode,
      details:err.details
    });
    const fieldDetails=Array.isArray(err.details&&err.details.details)
      ? err.details.details.map(x=>`${x.field}: ${x.message}`).join(' | ')
      : null;
    return res.status(err.status&&err.status<500?err.status:502).json({
      error:fieldDetails ? `${err.message} — ${fieldDetails}` : (err.message||'Não foi possível gerar o Pix.'),
      requestId:err.requestId||null,
      errorCode:err.errorCode||null,
      payzuStatusCode:err.status||null
    });
  }
};
