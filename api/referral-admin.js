const { getAdmin } = require('../lib/firebase-admin');
const ADMIN_EMAIL='support.puffpod@gmail.com';
const VALID_RATES=[7,10,13,15,20];

function referralCodeFor(uid){
  const base=String(uid||'').replace(/[^a-zA-Z0-9]/g,'').slice(0,6).toUpperCase()||'PUFF';
  return `PP${base}${Math.floor(10+Math.random()*90)}`;
}

async function resolveUidAndAuthUser(admin,body){
  if(body.uid){
    const rec=await admin.auth().getUser(String(body.uid));
    return rec;
  }
  if(body.email){
    const rec=await admin.auth().getUserByEmail(String(body.email).trim().toLowerCase());
    return rec;
  }
  throw Object.assign(new Error('Informe uid ou email do usuário.'),{status:400});
}

// Garante que o documento em /users/{uid} exista. Contas criadas direto no
// Firebase Auth (ex.: administrador cadastrado manualmente) nunca passam
// pelo ensureUserDoc do site e por isso não aparecem na aba "Usuários" nem
// conseguem ter o programa de indicação liberado.
async function ensureUserDoc(admin,db,authUser){
  const ref=db.collection('users').doc(authUser.uid);
  const snap=await ref.get();
  if(!snap.exists){
    await ref.set({
      name:authUser.displayName||'',
      email:authUser.email||'',
      cashback:0,
      provider:'manual',
      referralEnabled:false,
      referralCode:null,
      referralCommissionPercent:null,
      createdAt:admin.firestore.FieldValue.serverTimestamp()
    },{merge:true});
    return (await ref.get());
  }
  return snap;
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

    // Libera o programa de indicação para um usuário (por uid ou e-mail).
    // Cria o documento em /users/{uid} automaticamente se ele ainda não existir.
    if(action==='enableReferral'){
      const rate=Number(body.referralCommissionPercent||10);
      if(!VALID_RATES.includes(rate)) return res.status(400).json({error:`Percentual inválido. Use um de: ${VALID_RATES.join(', ')}.`});
      const authUser=await resolveUidAndAuthUser(admin,body);
      const us=await ensureUserDoc(admin,db,authUser);
      const ur=db.collection('users').doc(authUser.uid);
      const code=us.data().referralCode||referralCodeFor(authUser.uid);
      await ur.set({
        referralEnabled:true,
        referralCode:code,
        referralCommissionPercent:rate,
        referralEnabledAt:admin.firestore.FieldValue.serverTimestamp()
      },{merge:true});
      return res.status(200).json({ok:true,uid:authUser.uid,referralCode:code,referralCommissionPercent:rate});
    }

    // Credita saldo em "ganhos com indicação" (usado para testes de saque ou ajustes manuais)
    if(action==='creditReferralBalance'||action==='grantTestBalance'){
      const amount=Math.round(Number(body.amount||0)*100)/100;
      if(!(amount>0)) return res.status(400).json({error:'Informe um valor de saldo maior que zero.'});
      const authUser=await resolveUidAndAuthUser(admin,body);
      await ensureUserDoc(admin,db,authUser);
      const ur=db.collection('users').doc(authUser.uid);
      await ur.set({
        referralAvailable:admin.firestore.FieldValue.increment(amount),
        referralEarningsTotal:admin.firestore.FieldValue.increment(amount),
        referralLastEarningAt:admin.firestore.FieldValue.serverTimestamp(),
        referralLastManualCreditNote:`R$ ${amount.toFixed(2)} creditado manualmente por ${decoded.email} em ${new Date().toISOString()}`
      },{merge:true});
      return res.status(200).json({ok:true,uid:authUser.uid,creditedAmount:amount});
    }

    return res.status(400).json({error:'Ação inválida.'});
  }catch(err){
    console.error('referral-admin',err);
    return res.status(err.status&&err.status<500?err.status:400).json({error:err.message||'Falha ao processar a solicitação.'});
  }
};
