const { getAdmin } = require('../lib/firebase-admin');
const { normalizePixType } = require('../lib/payzu');
const { sendWithdrawalRequestedEmail } = require('../lib/mailer');

function cleanPixKey(v){ return String(v||'').trim().slice(0,180); }

// Saque manual: fica pendente para o administrador conferir e realizar o
// Pix por fora, marcando como pago (ou estornando) direto no painel.
module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const authHeader=String(req.headers.authorization||'');
    if(!authHeader.startsWith('Bearer ')) return res.status(401).json({error:'Faça login para solicitar o saque.'});
    const admin=getAdmin(),db=admin.firestore(),decoded=await admin.auth().verifyIdToken(authHeader.slice(7));

    const pixType=normalizePixType(req.body&&req.body.pixType);
    const pixKey=cleanPixKey(req.body&&req.body.pixKey);
    if(!pixType||!pixKey) return res.status(400).json({error:'Informe uma chave Pix válida.'});

    const minWithdrawal=Math.max(10,Number(process.env.PAYZU_MIN_WITHDRAWAL||10));
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
        status:'pending',
        createdAt:admin.firestore.FieldValue.serverTimestamp(),
        mode:'manual'
      });
      tx.update(userRef,{
        referralAvailable:admin.firestore.FieldValue.increment(-amount),
        referralPending:admin.firestore.FieldValue.increment(amount),
        referralLastWithdrawalAt:admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // Melhor esforço: não falha a solicitação se o e-mail não sair.
    try{
      await sendWithdrawalRequestedEmail({
        to:userData.email||decoded.email,
        name:userData.name||decoded.name,
        amount,pixType,pixKey
      });
      await withdrawalRef.set({requestedEmailSent:true,requestedEmailSentAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    }catch(mailErr){
      console.error('withdrawal requested email',mailErr);
      await withdrawalRef.set({requestedEmailSent:false,requestedEmailError:mailErr.message||'Falha ao enviar e-mail.'},{merge:true});
    }

    return res.status(200).json({
      ok:true,
      withdrawalId:withdrawalRef.id,
      amount,
      status:'pending',
      message:'Saque em análise. Em breve estará disponível em sua conta corrente.'
    });
  }catch(err){
    console.error('referral-withdraw',err);
    const status=err.status&&err.status<500?err.status:400;
    return res.status(status).json({ error:err.message||'Não foi possível solicitar o saque.' });
  }
};
