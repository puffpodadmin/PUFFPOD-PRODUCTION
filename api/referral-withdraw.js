const { getAdmin } = require('../lib/firebase-admin');
function cleanPixType(v){return ['cpf','cnpj','email','phone','random'].includes(String(v||''))?String(v):'';}
function cleanPixKey(v){return String(v||'').trim().slice(0,180);}
function publicBaseUrl(req){const proto=(req.headers['x-forwarded-proto']||'https').split(',')[0].trim();const host=(req.headers['x-forwarded-host']||req.headers.host||'puffpod.com.br').split(',')[0].trim();return `${proto}://${host}`;}

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const authHeader=String(req.headers.authorization||''); if(!authHeader.startsWith('Bearer ')) return res.status(401).json({error:'Faça login para solicitar o saque.'});
    const admin=getAdmin(),db=admin.firestore(),decoded=await admin.auth().verifyIdToken(authHeader.slice(7));
    const pixType=cleanPixType(req.body&&req.body.pixType),pixKey=cleanPixKey(req.body&&req.body.pixKey); if(!pixType||!pixKey)return res.status(400).json({error:'Informe uma chave Pix válida.'});
    const userRef=db.collection('users').doc(decoded.uid),withdrawalRef=db.collection('referralWithdrawals').doc(); let amount=0,userData={};
    await db.runTransaction(async tx=>{const snap=await tx.get(userRef);if(!snap.exists)throw new Error('Cadastro não encontrado.');userData=snap.data()||{};if(!userData.referralEnabled)throw new Error('Seu programa de indicação não está ativo.');amount=Math.floor((Number(userData.referralAvailable||0)+Number.EPSILON)*100)/100;if(amount<5)throw new Error('O saque mínimo é R$ 5,00.');tx.set(withdrawalRef,{uid:decoded.uid,userName:userData.name||decoded.name||'',userEmail:userData.email||decoded.email||'',amount,pixType,pixKey,status:'processing',createdAt:admin.firestore.FieldValue.serverTimestamp(),gateway:'mgxpay'});tx.update(userRef,{referralAvailable:admin.firestore.FieldValue.increment(-amount),referralPending:admin.firestore.FieldValue.increment(amount),referralLastWithdrawalAt:admin.firestore.FieldValue.serverTimestamp()});});

    const clientId=String(process.env.MGXPAY_CLIENT_ID||'').trim(),clientSecret=String(process.env.MGXPAY_CLIENT_SECRET||'').trim(),webhookToken=String(process.env.MGXPAY_WEBHOOK_TOKEN||'').trim();
    if(!clientId||!clientSecret||!webhookToken) throw new Error('Credenciais/webhook da MGXPay não configurados.');
    const form=new URLSearchParams({client_id:clientId,client_secret:clientSecret,nome:String(userData.name||decoded.name||'Recebedor').slice(0,120),valor:amount.toFixed(2),chave_pix:pixKey,urlnoty:`${publicBaseUrl(req)}/api/mgxpay-webhook?token=${encodeURIComponent(webhookToken)}`});
    const r=await fetch('https://app.mgxpay.com.br/v3/pix/payment',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:form.toString()});
    const raw=await r.text();let data;try{data=JSON.parse(raw);}catch{data={message:raw};}
    if(!r.ok){
      await db.runTransaction(async tx=>{const ws=await tx.get(withdrawalRef);if(!ws.exists||ws.data().status!=='processing')return;tx.set(withdrawalRef,{status:'failed',error:data.message||`HTTP ${r.status}`,failedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});tx.set(userRef,{referralPending:admin.firestore.FieldValue.increment(-amount),referralAvailable:admin.firestore.FieldValue.increment(amount)},{merge:true});});
      return res.status(r.status).json({error:data.message||`MGXPay retornou HTTP ${r.status}.`});
    }
    const mgxTxId=String(data.transactionId||data[0]?.transactionId||'');
    await db.runTransaction(async tx=>{
      const ws=await tx.get(withdrawalRef); if(!ws.exists||ws.data().status!=='processing') return;
      tx.set(withdrawalRef,{status:'paid',mgxpayResponse:data,mgxpayTransactionId:mgxTxId||null,submittedAt:admin.firestore.FieldValue.serverTimestamp(),paidAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      tx.set(userRef,{referralPending:admin.firestore.FieldValue.increment(-amount),referralWithdrawn:admin.firestore.FieldValue.increment(amount)},{merge:true});
    });
    return res.status(200).json({ok:true,withdrawalId:withdrawalRef.id,amount,status:'paid'});
  }catch(err){console.error('referral-withdraw',err);return res.status(400).json({error:err.message||'Não foi possível solicitar o saque.'});}
};
