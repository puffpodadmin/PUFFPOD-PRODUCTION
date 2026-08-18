const { getAdmin } = require('../lib/firebase-admin');
const { payzuFetch } = require('../lib/payzu');
const { processPaidOrder, settleReferralWithdrawal } = require('../lib/payzu-orders');

function validSecret(req){
  const expected=String(process.env.PAYZU_WEBHOOK_TOKEN||'').trim();
  const supplied=String((req.query&&req.query.token)||'');
  return !!expected && supplied===expected;
}

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(200).json({ok:true});
  if(!validSecret(req)) return res.status(401).json({ok:false,error:'Webhook não autorizado.'});

  try{
    const event=req.body||{};
    const admin=getAdmin(),db=admin.firestore();
    const txId=String(event.id||'');
    const type=String(event.type||'').toUpperCase();
    const status=String(event.status||'').toUpperCase();
    const clientReference=String(event.clientReference||'');

    if(type==='DEPOSIT' || clientReference.startsWith('PP-')){
      if(!txId) throw new Error('Callback PayZu sem ID da transação.');
      // Confirma diretamente na API PayZu para não confiar apenas no payload público.
      const verified=await payzuFetch(`/pix?id=${encodeURIComponent(txId)}`,{tokenType:'deposit'});
      if(String(verified.status||'').toUpperCase()==='COMPLETED'){
        const orderId=String(verified.clientReference||clientReference||'');
        if(!orderId) throw new Error('Callback sem clientReference do pedido.');
        await processPaidOrder(db,admin,orderId,verified);
      }
    }

    if(type==='WITHDRAW' || clientReference.startsWith('REFWD-')){
      let snap=null;
      if(txId){
        snap=await db.collection('referralWithdrawals').where('payzuTransactionId','==',txId).limit(1).get();
      }
      if((!snap||snap.empty) && clientReference){
        snap=await db.collection('referralWithdrawals').where('payzuClientReference','==',clientReference).limit(1).get();
      }
      if(snap&&!snap.empty){
        const ref=snap.docs[0].ref;
        let verified=event;
        // Se a whitelist de saques permitir consulta, verificamos também via API.
        try{
          if(txId) verified=await payzuFetch(`/withdraw?id=${encodeURIComponent(txId)}`,{tokenType:'withdraw'});
        }catch(e){
          console.warn('PayZu withdraw verify fallback',e.message,e.errorCode||'',e.requestId||'');
        }
        if(String(verified.status||status).toUpperCase()==='COMPLETED'){
          await settleReferralWithdrawal(db,admin,ref,verified);
        }else{
          await ref.set({
            payzuStatus:String(verified.status||status||''),
            payzuLastWebhookAt:admin.firestore.FieldValue.serverTimestamp()
          },{merge:true});
        }
      }
    }

    return res.status(200).json({ok:true});
  }catch(err){
    console.error('payzu-webhook',err);
    // PayZu reenvia callbacks; 500 faz retry.
    return res.status(500).json({ok:false,error:err.message||'Falha ao processar callback.'});
  }
};
