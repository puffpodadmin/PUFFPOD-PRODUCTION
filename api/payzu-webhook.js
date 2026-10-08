const { getAdmin } = require('../lib/firebase-admin');
const { payzuFetch } = require('../lib/payzu');
const activepayments = require('../lib/activepayments');
const { processPaidOrder, settleReferralWithdrawal } = require('../lib/payzu-orders');

function validSecret(req){
  const expected=String(process.env.PAYZU_WEBHOOK_TOKEN||'').trim();
  const supplied=String((req.query&&req.query.token)||'');
  return !!expected && supplied===expected;
}

// O corpo bruto é necessário para validar a assinatura HMAC da ActivePayments.
async function readRawBody(req){
  if(typeof req.body==='string') return req.body;
  if(Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if(req.body && typeof req.body==='object' && !req.readable) return JSON.stringify(req.body);
  const chunks=[];
  for await(const c of req) chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

// Eventos da ActivePayments (charge.paid etc.). Nunca confiamos só no payload:
// confirmamos o status consultando a API da própria ActivePayments.
async function handleActivePayments(req,res,raw,event){
  const signature=req.headers['x-webhook-signature'];
  const okSignature=activepayments.verifySignature(raw,signature);
  if(!okSignature && !validSecret(req)) return res.status(401).json({ok:false,error:'Webhook não autorizado.'});
  const name=String(event.event||'');
  if(name==='ping' || !name.startsWith('charge.')) return res.status(200).json({ok:true});
  const admin=getAdmin(),db=admin.firestore();
  const d=event.data||event;
  const chargeId=String(d.chargeId||'');
  if(!chargeId) return res.status(200).json({ok:true});
  if(name==='charge.paid'){
    const c=await activepayments.getCharge(chargeId);
    if(c.paid){
      let orderId=String(d.externalReference||'');
      if(!orderId){
        const q=await db.collection('orders').where('activepayments.chargeId','==',chargeId).limit(1).get();
        if(!q.empty) orderId=q.docs[0].id;
      }
      if(!orderId) throw new Error('Callback ActivePayments sem pedido correspondente.');
      await processPaidOrder(db,admin,orderId,{gateway:'activepayments',id:c.id,amount:c.amount||Number(d.amount||0),endToEndId:d.endToEnd||null,paidAt:c.paidAt||d.paidAt||null});
    }
  }
  return res.status(200).json({ok:true});
}

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(200).json({ok:true});
  let raw='',event={};
  try{ raw=await readRawBody(req); event=raw?JSON.parse(raw):{}; }catch(e){ return res.status(400).json({ok:false,error:'Corpo inválido.'}); }

  try{
    if(req.headers['x-webhook-signature'] || (req.query&&req.query.gw==='ap') || /^charge\.|^ping$/.test(String(event.event||''))){
      return await handleActivePayments(req,res,raw,event);
    }
  }catch(err){
    console.error('activepayments-webhook',err);
    return res.status(500).json({ok:false,error:err.message||'Falha ao processar callback.'});
  }

  if(!validSecret(req)) return res.status(401).json({ok:false,error:'Webhook não autorizado.'});

  try{
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

// Desliga o parser automático para termos o corpo bruto (assinatura HMAC).
module.exports.config={api:{bodyParser:false}};
