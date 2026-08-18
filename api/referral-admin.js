const { getAdmin } = require('../lib/firebase-admin');
const ADMIN_EMAIL='support.puffpod@gmail.com';

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const h=String(req.headers.authorization||''); if(!h.startsWith('Bearer ')) return res.status(401).json({error:'Não autorizado.'});
    const admin=getAdmin(); const decoded=await admin.auth().verifyIdToken(h.slice(7));
    if(String(decoded.email||'').toLowerCase()!==ADMIN_EMAIL) return res.status(403).json({error:'Acesso restrito ao administrador.'});
    const {action,withdrawalId}=req.body||{}; if(!withdrawalId) return res.status(400).json({error:'Saque não informado.'});
    const db=admin.firestore(); const wr=db.collection('referralWithdrawals').doc(String(withdrawalId));
    await db.runTransaction(async tx=>{
      const ws=await tx.get(wr); if(!ws.exists) throw new Error('Solicitação não encontrada.');
      const w=ws.data()||{}; if(w.status!=='pending') throw new Error('Este saque já foi processado.');
      const ur=db.collection('users').doc(w.uid); const us=await tx.get(ur); if(!us.exists) throw new Error('Usuário não encontrado.');
      const amount=Number(w.amount||0);
      if(action==='markPaid'){
        tx.update(wr,{status:'paid',paidAt:admin.firestore.FieldValue.serverTimestamp(),paidBy:decoded.email||ADMIN_EMAIL});
        tx.update(ur,{referralPending:admin.firestore.FieldValue.increment(-amount),referralWithdrawn:admin.firestore.FieldValue.increment(amount)});
      }else if(action==='reject'){
        tx.update(wr,{status:'rejected',rejectedAt:admin.firestore.FieldValue.serverTimestamp(),rejectedBy:decoded.email||ADMIN_EMAIL});
        tx.update(ur,{referralPending:admin.firestore.FieldValue.increment(-amount),referralAvailable:admin.firestore.FieldValue.increment(amount)});
      }else throw new Error('Ação inválida.');
    });
    return res.status(200).json({ok:true});
  }catch(err){console.error('referral-admin',err);return res.status(400).json({error:err.message||'Falha ao processar saque.'});}
};
