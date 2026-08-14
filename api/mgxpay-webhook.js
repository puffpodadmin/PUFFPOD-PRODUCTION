const crypto=require('crypto');
const {getAdmin}=require('../lib/firebase-admin');
const {markPaidAndProcess}=require('../lib/order-processing');
function safeEq(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
async function findOrder(db,event){
  const external=String(event.external_id||'').trim();
  if(external){const s=await db.collection('orders').doc(external).get();if(s.exists)return {ref:s.ref,snap:s};}
  const txid=String(event.transactionId||'').trim(); if(!txid)return null;
  const q=await db.collection('orders').where('mgxpay.transactionId','==',txid).limit(1).get();if(q.empty)return null;return {ref:q.docs[0].ref,snap:q.docs[0]};
}
async function finishWithdrawal(db,admin,event,withdrawalId){
  if(!withdrawalId)return;
  const ref=db.collection('referralWithdrawals').doc(String(withdrawalId));
  await db.runTransaction(async tx=>{
    const s=await tx.get(ref);if(!s.exists)return;const w=s.data()||{};if(w.status==='paid')return;
    const ok=event?.statusCode?.statusId===1;if(!ok){tx.set(ref,{status:'failed',providerEvent:event,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});return;}
    const userRef=db.collection('users').doc(String(w.uid));const us=await tx.get(userRef);if(!us.exists)return;
    const amount=Number(w.amount||0);
    tx.set(ref,{status:'paid',providerTransactionId:String(event.transactionId||''),paidAt:admin.firestore.FieldValue.serverTimestamp(),providerEvent:event},{merge:true});
    tx.set(userRef,{referralPending:admin.firestore.FieldValue.increment(-amount),referralWithdrawn:admin.firestore.FieldValue.increment(amount)},{merge:true});
  });
}
module.exports=async function handler(req,res){
  if(req.method!=='POST')return res.status(200).json({ok:true});
  try{
    const secret=String(process.env.MGXPAY_WEBHOOK_SECRET||'');if(!secret||!safeEq(req.query?.token,secret))return res.status(401).json({error:'Webhook não autorizado.'});
    const event=req.body||{},admin=getAdmin(),db=admin.firestore();
    if(String(event.transactionType||'').toUpperCase()==='PAYMENT'){
      await finishWithdrawal(db,admin,event,req.query?.withdrawalId);return res.status(200).json({ok:true});
    }
    if(String(event.status||'').toUpperCase()!=='PAID')return res.status(200).json({ok:true,ignored:true});
    const found=await findOrder(db,event);if(!found)return res.status(404).json({error:'Pedido não encontrado para esta transação.'});
    const order=found.snap.data()||{},expected=Math.round(Number(order.total||0)*100),received=Math.round(Number(event.amount||0)*100);
    if(expected>0&&received!==expected){console.error('MGXPay amount mismatch',{orderId:found.snap.id,expected,received,event});return res.status(400).json({error:'Valor do webhook não corresponde ao pedido.'});}
    const storedTx=String(order.mgxpay?.transactionId||''),eventTx=String(event.transactionId||'');if(storedTx&&eventTx&&storedTx!==eventTx)return res.status(400).json({error:'Transação não corresponde ao pedido.'});
    await markPaidAndProcess(found.snap.id,{transactionId:eventTx,status:'PAID',amount:Number(event.amount||0),externalId:event.external_id||null,webhookReceivedAt:admin.firestore.FieldValue.serverTimestamp()});
    return res.status(200).json({ok:true});
  }catch(err){console.error('mgxpay-webhook',err);return res.status(500).json({error:'Falha ao processar webhook.'});}
};
