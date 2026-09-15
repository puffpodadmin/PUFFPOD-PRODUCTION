async function processPaidOrder(db,admin,orderId,event){
  const orderRef=db.collection('orders').doc(String(orderId));
  await db.runTransaction(async tx=>{
    const os=await tx.get(orderRef);
    if(!os.exists) throw new Error('Pedido não encontrado.');
    const order=os.data()||{};

    // Idempotência: o pedido em si só é marcado como pago uma vez, mas isso
    // NÃO pode impedir novas tentativas de creditar cashback/comissão caso a
    // primeira passada tenha falhado parcialmente (ex.: doc do usuário ainda
    // não existia). Cada etapa é controlada pela sua própria flag *Processed.
    const alreadyPaid=order.paymentStatus==='paid';

    // Só confirmamos aqui um Pix que a própria PayZu já retornou como
    // COMPLETED para o ID de transação exato deste pedido (isso é feito por
    // quem chama esta função). Por isso NÃO bloqueamos mais a confirmação
    // por uma diferença de valor: a PayZu pode aplicar uma tarifa de serviço
    // ou pequeno arredondamento no valor líquido devolvido, e travar aqui
    // deixava o pedido para sempre "aguardando pagamento" — sem cashback,
    // sem comissão de indicação e sem e-mail de confirmação. Qualquer
    // diferença fica registrada em amountMismatch apenas para auditoria.
    let amountMismatchCents=0;
    if(!alreadyPaid){
      const expected=Math.round(Number(order.total||0)*100);
      const received=Math.round(Number(event.amount||0)*100);
      if(expected>0 && received>0 && expected!==received){
        amountMismatchCents=received-expected;
        console.warn('PayZu amount mismatch (seguindo em frente)',{orderId,expected,received});
      }
    }

    // O Firestore exige que todas as leituras da transação aconteçam antes de
    // qualquer gravação. Carregamos usuário e indicador primeiro para que a
    // confirmação do Pix não fique presa em PENDING ao processar os créditos.
    let userRef=null,userSnap=null;
    if(order.uid && !order.cashbackProcessed){
      userRef=db.collection('users').doc(order.uid);
      userSnap=await tx.get(userRef);
    }
    const referral=order.referral||{};
    const referrerUid=String(referral.referrerUid||'');
    let referrerRef=null,referrerSnap=null;
    if(!order.referralCommissionProcessed && referrerUid){
      referrerRef=db.collection('users').doc(referrerUid);
      referrerSnap=await tx.get(referrerRef);
    }

    if(!alreadyPaid){
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
          verifiedAt:admin.firestore.FieldValue.serverTimestamp(),
          amountMismatchCents:amountMismatchCents||null
        }
      },{merge:true});
    }

    // Cashback: 1% do subtotal pago (R$ 1 a cada R$ 100 em compras). Não
    // exigimos mais que o documento do usuário já exista — se ainda não
    // existir, tratamos o saldo atual como 0 e criamos/atualizamos o campo
    // via merge, para nunca perder o crédito por uma corrida de cadastro.
    if(userRef && !order.cashbackProcessed){
        const current=Number(((userSnap&&userSnap.exists)?userSnap.data().cashback:0)||0);
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

    // Comissão de indicação
    if(!order.referralCommissionProcessed){
      if(!referrerUid){
        tx.set(orderRef,{referralCommissionProcessed:true,referralCommissionAmount:0},{merge:true});
      }else{
        if(referrerSnap && referrerSnap.exists){
          const percent=Number(referrerSnap.data().referralCommissionPercent||0);
          if([7,10,13,15,20].includes(percent)){
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
