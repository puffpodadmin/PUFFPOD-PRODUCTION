const { quoteDelivery } = require('../lib/delivery');
const { getAdmin } = require('../lib/firebase-admin');
const { payzuFetch, webhookUrl, publicBaseUrl } = require('../lib/payzu');
const activepayments = require('../lib/activepayments');
const QRCode = require('qrcode');
const { evaluateStore, loadStoreSettings, scheduleMessage } = require('../lib/business-hours');

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
    {
      const storeState=evaluateStore(await loadStoreSettings(getAdmin().firestore()));
      if(!storeState.open){
        const msg=storeState.reason==='paused'
          ? 'O atendimento foi pausado por hoje. Voltamos no próximo horário de atendimento.'
          : `Estamos fechados no momento. ${scheduleMessage()}`;
        return res.status(403).json({error:msg,closed:true});
      }
    }

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

    const cleanedName=cleanName(b.name);
    const email=String(b.email||'').trim().slice(0,180)||undefined;
    const amountReais=Number((total/100).toFixed(2));

    // Gateways: PayZu é o PRIMÁRIO e a ActivePayments o FALLBACK.
    // Para inverter a ordem sem mexer no código: GATEWAY_PRIMARY=activepayments (Vercel).
    const attemptActive=async()=>{
      if(!activepayments.isConfigured()) throw new Error('ActivePayments não configurada.');
      const whToken=String(process.env.ACTIVEPAYMENTS_WEBHOOK_TOKEN||process.env.PAYZU_WEBHOOK_TOKEN||'').trim();
      const postbackUrl=whToken?`${publicBaseUrl(req)}/api/payzu-webhook?gw=ap&token=${encodeURIComponent(whToken)}`:undefined;
      const c=await activepayments.createPixCharge({
        amount:amountReais,name:cleanedName.length>=3?cleanedName:'Cliente Puffpod',cpf:cpfDigits,email,
        phone:b.phone,reference:orderId,postbackUrl,expirationMinutes:15,info:`Pedido ${orderId} - Puffpod`
      });
      let qrBase64=c.qrCodeBase64;
      if(!qrBase64){
        try{ qrBase64=(await QRCode.toDataURL(c.qrCodeText,{margin:1,width:360})).replace(/^data:image\/png;base64,/,''); }catch(e){ qrBase64=''; }
      }
      return {gateway:'activepayments',pix:{id:c.id,status:c.status,amount:c.amount||amountReais,qrCodeText:c.qrCodeText,qrCodeBase64:qrBase64,qrCodeUrl:null,serviceFeeCharged:0}};
    };
    const attemptPayzu=async()=>{
      const callbackUrl=webhookUrl(req);
      const payload={
        amount:amountReais,
        generatedName:cleanedName,
        generatedDocument:cpfDigits,
        generatedEmail:email,
        callbackUrl,
        clientReference:orderId,
        expiresIn:900
      };
      Object.keys(payload).forEach(k=>payload[k]===undefined&&delete payload[k]);
      const data=await payzuFetch('/pix',{method:'POST',body:payload,tokenType:'deposit'});
      if(!data.id||!data.qrCodeText) throw new Error('A PayZu não retornou o QR Code da cobrança.');
      return {gateway:'payzu',pix:{id:String(data.id),status:String(data.status||'PENDING'),amount:Number(data.amount||amountReais),qrCodeText:String(data.qrCodeText),qrCodeBase64:data.qrCodeBase64||null,qrCodeUrl:data.qrCodeUrl||null,serviceFeeCharged:Number(data.serviceFeeCharged||0)}};
    };
    const activeFirst=String(process.env.GATEWAY_PRIMARY||'payzu').toLowerCase()==='activepayments';
    const order=activeFirst?[['activepayments',attemptActive],['payzu',attemptPayzu]]:[['payzu',attemptPayzu],['activepayments',attemptActive]];

    let pix=null, gateway=null, primaryError=null;
    for(let i=0;i<order.length;i++){
      const [name,fn]=order[i];
      try{
        const r=await fn();
        pix=r.pix; gateway=r.gateway; break;
      }catch(e){
        if(i===0){
          primaryError=e;
          console.error(`${name} create failed -> fallback`,{message:e.message,status:e.status});
        }else if(primaryError){
          console.error(`${name} (fallback) also failed`,{message:e.message,status:e.status});
          throw primaryError; // mostra o erro do gateway principal
        }else throw e;
      }
    }

    const gatewayInfo=gateway==='activepayments'
      ? {activepayments:{chargeId:pix.id,status:pix.status,amount:pix.amount,createdAt:admin.firestore.FieldValue.serverTimestamp()}}
      : {payzu:{transactionId:pix.id,status:pix.status,amount:pix.amount,serviceFeeCharged:pix.serviceFeeCharged,clientReference:orderId,qrCodeUrl:pix.qrCodeUrl,createdAt:admin.firestore.FieldValue.serverTimestamp()}};
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
      paymentMethod:gateway,
      gateway,
      ...(primaryError?{gatewayFallbackReason:String(primaryError.message||'').slice(0,200)}:{}),
      ...gatewayInfo
    },{merge:true});

    return res.status(200).json({
      ok:true,
      gateway,
      transactionId:String(pix.id),
      status:String(pix.status||'PENDING'),
      amount:Number(pix.amount||total/100),
      qrCodeText:String(pix.qrCodeText),
      qrCodeUrl:pix.qrCodeUrl||null,
      qrCodeBase64:pix.qrCodeBase64||null,
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
