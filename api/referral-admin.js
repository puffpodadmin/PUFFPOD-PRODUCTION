const { getAdmin } = require('../lib/firebase-admin');
const ADMIN_EMAIL='support.puffpod@gmail.com';
const VALID_RATES=[7,10,13,15,20];

function referralCodeFor(uid){
  const base=String(uid||'').replace(/[^a-zA-Z0-9]/g,'').slice(0,6).toUpperCase()||'PUFF';
  return `PP${base}${Math.floor(10+Math.random()*90)}`;
}

async function resolveUid(admin,body){
  if(body.uid) return String(body.uid);
  if(body.email){
    const rec=await admin.auth().getUserByEmail(String(body.email).trim().toLowerCase());
    return rec.uid;
  }
  throw Object.assign(new Error('Informe uid ou email do usuário.'),{status:400});
}

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const h=String(req.headers.authorization||''); if(!h.startsWith('Bearer ')) return res.status(401).json({error:'Não autorizado.'});
    const admin=getAdmin(); const decoded=await admin.auth().verifyIdToken(h.slice(7));
    if(String(decoded.email||'').toLowerCase()!==ADMIN_EMAIL) return res.status(403).json({error:'Acesso restrito ao administrador.'});
    const db=admin.firestore();
    const body=req.body||{};
    const action=body.action;

    // Ações sobre solicitações de saque de indicação (fluxo já existente)
    if(action==='markPaid'||action==='reject'){
      const withdrawalId=body.withdrawalId; if(!withdrawalId) return res.status(400).json({error:'Saque não informado.'});
      const wr=db.collection('referralWithdrawals').doc(String(withdrawalId));
      await db.runTransaction(async tx=>{
        const ws=await tx.get(wr); if(!ws.exists) throw new Error('Solicitação não encontrada.');
        const w=ws.data()||{}; if(w.status!=='pending') throw new Error('Este saque já foi processado.');
        const ur=db.collection('users').doc(w.uid); const us=await tx.get(ur); if(!us.exists) throw new Error('Usuário não encontrado.');
        const amount=Number(w.amount||0);
        if(action==='markPaid'){
          tx.update(wr,{status:'paid',paidAt:admin.firestore.FieldValue.serverTimestamp(),paidBy:decoded.email||ADMIN_EMAIL});
          tx.update(ur,{referralPending:admin.firestore.FieldValue.increment(-amount),referralWithdrawn:admin.firestore.FieldValue.increment(amount)});
        }else{
          tx.update(wr,{status:'rejected',rejectedAt:admin.firestore.FieldValue.serverTimestamp(),rejectedBy:decoded.email||ADMIN_EMAIL});
          tx.update(ur,{referralPending:admin.firestore.FieldValue.increment(-amount),referralAvailable:admin.firestore.FieldValue.increment(amount)});
        }
      });
      return res.status(200).json({ok:true});
    }

    // Libera o programa de indicação para um usuário (por uid ou e-mail)
    if(action==='enableReferral'){
      const rate=Number(body.referralCommissionPercent||10);
      if(!VALID_RATES.includes(rate)) return res.status(400).json({error:`Percentual inválido. Use um de: ${VALID_RATES.join(', ')}.`});
      const uid=await resolveUid(admin,body);
      const ur=db.collection('users').doc(uid);
      const us=await ur.get(); if(!us.exists) return res.status(404).json({error:'Usuário não encontrado.'});
      const code=us.data().referralCode||referralCodeFor(uid);
      await ur.set({
        referralEnabled:true,
        referralCode:code,
        referralCommissionPercent:rate,
        referralEnabledAt:admin.firestore.FieldValue.serverTimestamp()
      },{merge:true});
      return res.status(200).json({ok:true,uid,referralCode:code,referralCommissionPercent:rate});
    }

    // Credita saldo de teste em "ganhos com indicação" (uso interno para QA de saque)
    if(action==='grantTestBalance'){
      const amount=Math.round(Number(body.amount||0)*100)/100;
      if(!(amount>0)) return res.status(400).json({error:'Informe um valor de saldo maior que zero.'});
      const uid=await resolveUid(admin,body);
      const ur=db.collection('users').doc(uid);
      const us=await ur.get(); if(!us.exists) return res.status(404).json({error:'Usuário não encontrado.'});
      await ur.set({
        referralAvailable:admin.firestore.FieldValue.increment(amount),
        referralEarningsTotal:admin.firestore.FieldValue.increment(amount),
        referralTestCreditNote:`Saldo de teste de R$ ${amount.toFixed(2)} creditado por ${decoded.email} em ${new Date().toISOString()}`
      },{merge:true});
      return res.status(200).json({ok:true,uid,creditedAmount:amount});
    }

    return res.status(400).json({error:'Ação inválida.'});
  }catch(err){
    console.error('referral-admin',err);
    return res.status(err.status&&err.status<500?err.status:400).json({error:err.message||'Falha ao processar a solicitação.'});
  }
};
