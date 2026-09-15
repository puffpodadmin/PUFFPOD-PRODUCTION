const { getAdmin } = require('../lib/firebase-admin');
const { payzuFetch, webhookUrl, normalizePixType } = require('../lib/payzu');
const { settleReferralWithdrawal } = require('../lib/payzu-orders');

function cleanPixKey(v){return String(v||'').trim().slice(0,180);}
function withdrawalsEnabled(){
  return String(process.env.PAYZU_WITHDRAWALS_ENABLED||'').toLowerCase()==='true';
}

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    if(!withdrawalsEnabled()){
      return res.status(503).json({error:'Os saques PayZu ainda não foram liberados. Configure PAYZU_WITHDRAWALS_ENABLED=true após validar a whitelist de IP.'});
    }

    const authHeader=String(req.headers.authorization||'');
    if(!authHeader.startsWith('Bearer ')) return res.status(401).json({error:'Faça login para solicitar o saque.'});
    const admin=getAdmin(),db=admin.firestore(),decoded=await admin.auth().verifyIdToken(authHeader.slice(7));

    const pixType=normalizePixType(req.body&&req.body.pixType);
    const pixKey=cleanPixKey(req.body&&req.body.pixKey);
    if(!pixType||!pixKey) return res.status(400).json({error:'Informe uma chave Pix válida.'});

    const minWithdrawal=Math.max(1,Number(process.env.PAYZU_MIN_WITHDRAWAL||5));
    const userRef=db.collection('users').doc(decoded.uid);
    const withdrawalRef=db.collection('referralWithdrawals').doc();
    let amount=0,userData={};

    await db.runTransaction(async tx=>{
      const snap=await tx.get(userRef);
      if(!snap.exists) throw new Error('Cadastro não encontrado.');
      userData=snap.data()||{};
      if(!userData.referralEnabled) throw new Error('Seu programa de indicação não está ativo.');
      amount=Math.floor((Number(userData.referralAvailable||0)+Number.EPSILON)*100)/100;
      if(amount<minWithdrawal) throw new Error(`O saque mínimo é R$ ${minWithdrawal.toFixed(2).replace('.',',')}.`);
      tx.set(withdrawalRef,{
        uid:decoded.uid,
        userName:userData.name||decoded.name||'',
        userEmail:userData.email||decoded.email||'',
        amount,pixType,pixKey,
        status:'processing',
        createdAt:admin.firestore.FieldValue.serverTimestamp(),
        paymentProvider:'payzu',
        mode:'automatic'
      });
      tx.update(userRef,{
        referralAvailable:admin.firestore.FieldValue.increment(-amount),
        referralPending:admin.firestore.FieldValue.increment(amount),
        referralLastWithdrawalAt:admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const clientReference=`REFWD-${withdrawalRef.id}`.slice(0,64);
    try{
      const data=await payzuFetch('/withdraw',{
        method:'POST',
        tokenType:'withdraw',
        body:{
          amount:Number(amount.toFixed(2)),
          pixKey,
          pixType,
          callbackUrl:webhookUrl(req),
          clientReference,
          description:'Saque de comissão Puffpod'
        }
      });

      await withdrawalRef.set({
        status:String(data.status||'PENDING').toUpperCase()==='COMPLETED'?'processing':'pending',
        payzuTransactionId:String(data.id||''),
        payzuClientReference:clientReference,
        payzuStatus:String(data.status||'PENDING'),
        payzuServiceFeeCharged:Number(data.serviceFeeCharged||0),
        payzuCreatedAt:admin.firestore.FieldValue.serverTimestamp()
      },{merge:true});

      if(String(data.status||'').toUpperCase()==='COMPLETED'){
        await settleReferralWithdrawal(db,admin,withdrawalRef,data);
      }

      return res.status(200).json({
        ok:true,
        withdrawalId:withdrawalRef.id,
        transactionId:data.id||null,
        amount,
        status:String(data.status||'PENDING'),
        message:String(data.status||'').toUpperCase()==='COMPLETED'?'Pix enviado com sucesso.':'Saque enviado para processamento pela PayZu.'
      });
    }catch(payzuErr){
      // Se a PayZu rejeitar antes de criar a transação, devolve o saldo.
      await db.runTransaction(async tx=>{
        const ws=await tx.get(withdrawalRef);
        if(!ws.exists) return;
        const w=ws.data()||{};
        if(w.status==='paid'||w.status==='failed') return;
        tx.set(withdrawalRef,{
          status:'failed',
          failedAt:admin.firestore.FieldValue.serverTimestamp(),
          payzuError:payzuErr.message||'Falha PayZu',
          payzuRequestId:payzuErr.requestId||null,
          payzuErrorCode:payzuErr.errorCode||null
        },{merge:true});
        tx.set(userRef,{
          referralPending:admin.firestore.FieldValue.increment(-amount),
          referralAvailable:admin.firestore.FieldValue.increment(amount)
        },{merge:true});
      });
      throw payzuErr;
    }
  }catch(err){
    console.error('referral-withdraw-payzu',{
      message:err.message,requestId:err.requestId,errorCode:err.errorCode
    });
    const status=err.status&&err.status<500?err.status:400;
    return res.status(status).json({
      error:err.message||'Não foi possível solicitar o saque.',
      requestId:err.requestId||null,
      errorCode:err.errorCode||null
    });
  }
};
