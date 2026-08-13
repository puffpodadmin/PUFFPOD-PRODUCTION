const { getAdmin } = require('../lib/firebase-admin');

function cleanPixType(v){ return ['cpf','cnpj','email','phone','random'].includes(String(v||'')) ? String(v) : ''; }
function cleanPixKey(v){ return String(v||'').trim().slice(0,180); }

module.exports = async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const authHeader=String(req.headers.authorization||'');
    if(!authHeader.startsWith('Bearer ')) return res.status(401).json({error:'Faça login para solicitar o saque.'});
    const admin=getAdmin(); const db=admin.firestore();
    const decoded=await admin.auth().verifyIdToken(authHeader.slice(7));
    const pixType=cleanPixType(req.body&&req.body.pixType), pixKey=cleanPixKey(req.body&&req.body.pixKey);
    if(!pixType||!pixKey) return res.status(400).json({error:'Informe uma chave Pix válida.'});
    const userRef=db.collection('users').doc(decoded.uid); const withdrawalRef=db.collection('referralWithdrawals').doc();
    let amount=0;
    await db.runTransaction(async tx=>{
      const snap=await tx.get(userRef); if(!snap.exists) throw new Error('Cadastro não encontrado.');
      const u=snap.data()||{}; if(!u.referralEnabled) throw new Error('Seu programa de indicação não está ativo.');
      amount=Math.floor((Number(u.referralAvailable||0)+Number.EPSILON)*100)/100;
      if(amount<=0) throw new Error('Você não possui saldo disponível para saque.');
      tx.set(withdrawalRef,{uid:decoded.uid,userName:u.name||decoded.name||'',userEmail:u.email||decoded.email||'',amount,pixType,pixKey,status:'pending',createdAt:admin.firestore.FieldValue.serverTimestamp()});
      tx.update(userRef,{referralAvailable:admin.firestore.FieldValue.increment(-amount),referralPending:admin.firestore.FieldValue.increment(amount),referralLastWithdrawalAt:admin.firestore.FieldValue.serverTimestamp()});
    });
    return res.status(200).json({ok:true,withdrawalId:withdrawalRef.id,amount});
  }catch(err){console.error('referral-withdraw',err);return res.status(400).json({error:err.message||'Não foi possível solicitar o saque.'});}
};
