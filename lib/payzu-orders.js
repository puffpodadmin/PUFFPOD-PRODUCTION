async function processPaidOrder(db,admin,orderId,event){
  const orderRef=db.collection('orders').doc(String(orderId));
  await db.runTransaction(async tx=>{
    const os=await tx.get(orderRef);
    if(!os.exists) throw new Error('Pedido não encontrado.');
    const order=os.data()||{};
    const expected=Math.round(Number(order.total||0)*100);
    const received=Math.round(Number(event.amount||0)*100);
    if(expected>0 && received>0 && expected!==received){
      throw new Error(`Valor divergente no pagamento: esperado ${expected}, recebido ${received}.`);
    }

    // Idempotência
    if(order.paymentStatus==='paid') return;

    tx.set(orderRef,{
      status:'paid',
      paymentStatus:'paid',
      paymentMethod:'payzu',
      paidAt:admin.firestore.FieldValue.serverTimestamp(),
      payzu:{
        ...(order.payzu||{}),
        transactionId:String(event.id||order.payzu?.transactionId||''),
        status:'COMPLETED',
        amount:Number(event.amount||order.total||0),
        endToEndId:event.endToEndId||null,
        paidAt:event.paidAt||null,
        verifiedAt:admin.firestore.FieldValue.serverTimestamp()
      }
    },{merge:true});

    // Cashback
    if(order.uid && !order.cashbackProcessed){
      const userRef=db.collection('users').doc(order.uid);
      const us=await tx.get(userRef);
      if(us.exists){
        const current=Number(us.data().cashback||0);
        const used=Math.min(Number(order.cashbackUsed||0),current);
        const earned=Math.round(Math.max(0,Number(order.subtotal||0)-used)*0.01*100)/100;
        tx.set(userRef,{
          cashback:Math.max(0,Math.round((current-used+earned)*100)/100)
        },{merge:true});
        tx.set(orderRef,{
          cashbackUsed:used,
          cashbackEarned:earned,
          cashbackProcessed:true
        },{merge:true});
      }
    }

    // Comissão de indicação
    if(!order.referralCommissionProcessed){
      const referral=order.referral||{};
      const referrerUid=String(referral.referrerUid||'');
      if(!referrerUid){
        tx.set(orderRef,{referralCommissionProcessed:true,referralCommissionAmount:0},{merge:true});
      }else{
        const referrerRef=db.collection('users').doc(referrerUid);
        const rs=await tx.get(referrerRef);
        if(rs.exists){
          const percent=Number(rs.data().referralCommissionPercent||0);
          if([10,15,20].includes(percent)){
            const base=Number(order.subtotal||0);
            const amount=Math.round(base*percent)/100;
            tx.set(referrerRef,{
              referralEarningsTotal:admin.firestore.FieldValue.increment(amount),
              referralAvailable:admin.firestore.FieldValue.increment(amount),
              referralSalesCount:admin.firestore.FieldValue.increment(1),
              referralLastEarningAt:admin.firestore.FieldValue.serverTimestamp()
            },{merge:true});
            tx.set(orderRef,{
              referralCommissionProcessed:true,
              referralCommissionStatus:'credited',
              referralCommissionAmount:amount,
              referralCommissionPercent:percent,
              referralCommissionBase:base,
              referralCommissionCreditedAt:admin.firestore.FieldValue.serverTimestamp()
            },{merge:true});
          }else{
            tx.set(orderRef,{referralCommissionStatus:'waiting_rate'},{merge:true});
          }
        }else{
          tx.set(orderRef,{
            referralCommissionProcessed:true,
            referralCommissionAmount:0,
            referralCommissionStatus:'referrer_not_found'
          },{merge:true});
        }
      }
    }
  });
}

async function settleReferralWithdrawal(db,admin,withdrawalRef,payzuData){
  await db.runTransaction(async tx=>{
    const ws=await tx.get(withdrawalRef);
    if(!ws.exists) return;
    const w=ws.data()||{};
    if(w.status==='paid') return;
    if(w.status!=='processing' && w.status!=='pending') return;
    const userRef=db.collection('users').doc(w.uid);
    tx.set(withdrawalRef,{
      status:'paid',
      paidAt:admin.firestore.FieldValue.serverTimestamp(),
      payzuStatus:'COMPLETED',
      payzuEndToEndId:payzuData.endToEndId||null,
      payzuPaidAt:payzuData.paidAt||null
    },{merge:true});
    tx.set(userRef,{
      referralPending:admin.firestore.FieldValue.increment(-Number(w.amount||0)),
      referralWithdrawn:admin.firestore.FieldValue.increment(Number(w.amount||0))
    },{merge:true});
  });
}

module.exports={processPaidOrder,settleReferralWithdrawal};
