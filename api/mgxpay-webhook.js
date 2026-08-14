const { getAdmin } = require('../lib/firebase-admin');

async function processPaidOrder(db,admin,orderId,event){
  const orderRef=db.collection('orders').doc(orderId);
  await db.runTransaction(async tx=>{
    const os=await tx.get(orderRef); if(!os.exists) throw new Error('Pedido não encontrado');
    const order=os.data()||{};
    const expected=Math.round(Number(order.total||0)*100), received=Math.round(Number(event.amount||0)*100);
    if(expected>0 && received!==expected) throw new Error(`Valor divergente: esperado ${expected}, recebido ${received}`);
    if(order.paymentStatus==='paid') return;
    tx.set(orderRef,{status:'paid',paymentStatus:'paid',paidAt:admin.firestore.FieldValue.serverTimestamp(),paymentMethod:'mgxpay',mgxpay:{...(order.mgxpay||{}),transactionId:String(event.transactionId||order.mgxpay?.transactionId||''),status:'PAID',amount:Number(event.amount||order.total||0),webhookReceivedAt:admin.firestore.FieldValue.serverTimestamp()}},{merge:true});

    if(order.uid && !order.cashbackProcessed){
      const userRef=db.collection('users').doc(order.uid); const us=await tx.get(userRef);
      if(us.exists){
        const current=Number(us.data().cashback||0), used=Math.min(Number(order.cashbackUsed||0),current), earned=Math.round(Math.max(0,Number(order.subtotal||0)-used)*0.01*100)/100;
        tx.set(userRef,{cashback:Math.max(0,Math.round((current-used+earned)*100)/100)},{merge:true});
        tx.set(orderRef,{cashbackUsed:used,cashbackEarned:earned,cashbackProcessed:true},{merge:true});
      }
    }

    if(!order.referralCommissionProcessed){
      const ref=order.referral||{}, referrerUid=String(ref.referrerUid||'');
      if(!referrerUid){tx.set(orderRef,{referralCommissionProcessed:true,referralCommissionAmount:0},{merge:true});}
      else{
        const rr=db.collection('users').doc(referrerUid), rs=await tx.get(rr);
        if(rs.exists){
          const percent=Number(rs.data().referralCommissionPercent||0);
          if([10,15,20].includes(percent)){
            const base=Number(order.subtotal||0), amount=Math.round(base*percent)/100;
            tx.set(rr,{referralEarningsTotal:admin.firestore.FieldValue.increment(amount),referralAvailable:admin.firestore.FieldValue.increment(amount),referralSalesCount:admin.firestore.FieldValue.increment(1),referralLastEarningAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
            tx.set(orderRef,{referralCommissionProcessed:true,referralCommissionStatus:'credited',referralCommissionAmount:amount,referralCommissionPercent:percent,referralCommissionBase:base,referralCommissionCreditedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
          }else tx.set(orderRef,{referralCommissionStatus:'waiting_rate'},{merge:true});
        }else tx.set(orderRef,{referralCommissionProcessed:true,referralCommissionAmount:0,referralCommissionStatus:'referrer_not_found'},{merge:true});
      }
    }
  });
}

async function processPayoutWebhook(db,admin,event){
  const txId=String(event.transactionId||''); if(!txId) return;
  const snap=await db.collection('referralWithdrawals').where('mgxpayTransactionId','==',txId).limit(1).get();
  if(snap.empty) return;
  const ref=snap.docs[0].ref, w=snap.docs[0].data()||{};
  const approved=Number(event.statusCode&&event.statusCode.statusId)===1 || /aprovado/i.test(String(event.statusCode&&event.statusCode.description||''));
  if(approved && w.status!=='paid'){
    const userRef=db.collection('users').doc(w.uid);
    await db.runTransaction(async tx=>{
      const ws=await tx.get(ref); if(!ws.exists||ws.data().status==='paid') return;
      tx.set(ref,{status:'paid',paidAt:admin.firestore.FieldValue.serverTimestamp(),mgxpayWebhook:event},{merge:true});
      tx.set(userRef,{referralPending:admin.firestore.FieldValue.increment(-Number(w.amount||0)),referralWithdrawn:admin.firestore.FieldValue.increment(Number(w.amount||0))},{merge:true});
    });
  }
}

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(200).json({ok:true});
  try{
    const expectedToken=String(process.env.MGXPAY_WEBHOOK_TOKEN||'').trim();
    const suppliedToken=String((req.query&&req.query.token)||'');
    if(!expectedToken||suppliedToken!==expectedToken) return res.status(401).json({ok:false,error:'Webhook não autorizado'});
    const event=req.body||{}; const admin=getAdmin(), db=admin.firestore();
    if(String(event.status||'').toUpperCase()==='PAID'){
      let orderId=String(event.external_id||'');
      if(!orderId && event.transactionId!=null){
        const qs=await db.collection('orders').where('mgxpay.transactionId','==',String(event.transactionId)).limit(1).get();
        if(!qs.empty) orderId=qs.docs[0].id;
      }
      if(!orderId) throw new Error('Não foi possível relacionar o transactionId da MGXPay a um pedido Puffpod.');
      await processPaidOrder(db,admin,orderId,event);
    } else if(String(event.transactionType||'').toUpperCase()==='PAYMENT'){ await processPayoutWebhook(db,admin,event); }
    console.log('MGXPay webhook processed',{status:event.status,external_id:event.external_id,transactionType:event.transactionType,transactionId:event.transactionId});
    return res.status(200).json({ok:true});
  }catch(err){console.error('mgxpay-webhook',err);return res.status(400).json({ok:false,error:err.message||'Falha ao processar webhook'});}
};
