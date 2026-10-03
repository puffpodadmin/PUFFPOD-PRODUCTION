function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function brl(v){ return 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }

function buildOrderTelegramMessage(orderId, order){
  const items = Array.isArray(order.items) ? order.items : [];
  const itemsText = items
    .map(it => `• ${Math.max(1,parseInt(it.qty,10)||1)}x ${esc(it.name)} — ${brl((Number(it.price)||0)*Math.max(1,parseInt(it.qty,10)||1))}`)
    .join('\n') || '—';
  const d = order.delivery || {};
  const addressLines = [
    [d.street, d.number].filter(Boolean).join(', '),
    d.complement,
    d.neighborhood,
    [d.city, d.state].filter(Boolean).join(' / '),
    d.cep ? `CEP ${d.cep}` : ''
  ].filter(Boolean);
  const address = addressLines.length ? esc(addressLines.join('\n')) : 'Endereço não informado';

  const lines = [
    `💸 <b>Nova venda paga</b> — ${esc(orderId)}`,
    '',
    `<b>Cliente:</b> ${esc(order.name || '—')}`,
    `<b>Telefone:</b> ${esc(order.phone || '—')}`,
    `<b>E-mail:</b> ${esc(order.email || '—')}`,
    '',
    `<b>Itens:</b>`,
    itemsText,
    '',
    `<b>Entrega:</b>`,
    address,
    '',
    `<b>Subtotal:</b> ${brl(order.subtotal)}`,
    `<b>Entrega:</b> ${brl(d.fee)}`
  ];
  if(Number(order.cashbackUsed) > 0) lines.push(`<b>Cashback usado:</b> -${brl(order.cashbackUsed)}`);
  lines.push(`<b>Total pago:</b> ${brl(order.total)}`);
  return lines.join('\n');
}

async function processPaidOrder(db,admin,orderId,event){
  const { sendTelegramMessage } = require('./telegram');
  const orderRef=db.collection('orders').doc(String(orderId));
  let orderForNotification=null;
  let alreadyPaid=false;

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
    if(order.paymentStatus==='paid'){ alreadyPaid=true; return; }

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

    // Lê os produtos comprados (para dar baixa no estoque) — também precisa
    // acontecer antes de qualquer gravação na transação.
    const items=Array.isArray(order.items)?order.items:[];
    const stockReads=[];
    for(const it of items){
      if(!it || !it.id) continue;
      const ref=db.collection('products').doc(String(it.id));
      const snap=await tx.get(ref);
      stockReads.push({ref,item:it,snap});
    }

    orderForNotification={...order,total:received>0?received/100:order.total};

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
    if(userRef && userSnap && userSnap.exists){
        const current=Number(userSnap.data().cashback||0);
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

    // Baixa automática de estoque: só mexe nos produtos em que o admin já
    // definiu uma quantidade (campo stockQty existe no doc). Produtos no
    // modo manual (sem stockQty) continuam controlados só pelo toggle "Em falta".
    stockReads.forEach(({ref,item,snap})=>{
      if(!snap.exists) return;
      const data=snap.data()||{};
      if(data.stockQty==null) return;
      const currentQty=Math.max(0,Number(data.stockQty)||0);
      const orderedQty=Math.max(1,parseInt(item.qty,10)||1);
      const newQty=Math.max(0,currentQty-orderedQty);
      tx.set(ref,{stockQty:newQty,outOfStock:newQty<=0},{merge:true});
    });
  });

  if(alreadyPaid || !orderForNotification) return;

  // Aviso no Telegram é best-effort: se falhar (bot não configurado, rede,
  // etc.) não deve derrubar a confirmação do pagamento, que já foi gravada.
  try{
    await sendTelegramMessage(buildOrderTelegramMessage(String(orderId), orderForNotification));
  }catch(e){
    console.error('telegram notify (payzu-orders)', e.message);
  }
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
