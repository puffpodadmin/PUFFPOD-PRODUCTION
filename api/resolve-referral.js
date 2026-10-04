const { getAdmin } = require('../lib/firebase-admin');

// Endpoint único de indicação (resolver código + vincular indicado), para
// não passar do limite de 12 funções serverless do plano Hobby da Vercel.
//
// Por que existe: a regra de segurança do Firestore só deixa cada usuário
// ler/escrever o PRÓPRIO documento em /users, então o navegador não consegue
// buscar o indicador pelo código nem incrementar o contador dele. Aqui isso
// é feito com o Admin SDK.
//
//   { action:'resolve', code, excludeUid? }      -> { valid, uid, code, name }
//   { action:'link', referrerUid } + Bearer token -> incrementa referralInvitedCount
function normalizeReferralCode(value){
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
}

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try{
    const body = req.body || {};
    const admin = getAdmin();
    const db = admin.firestore();

    if(body.action === 'link'){
      const auth = String(req.headers.authorization || '');
      if(!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Sessão não encontrada.' });
      const decoded = await admin.auth().verifyIdToken(auth.slice(7));
      const referrerUid = String(body.referrerUid || '');
      if(!referrerUid || referrerUid === decoded.uid) return res.status(400).json({ error: 'Indicador inválido.' });

      // Só conta se o próprio usuário realmente está vinculado a esse indicador.
      const me = await db.collection('users').doc(decoded.uid).get();
      if(!me.exists || me.data().referredByUid !== referrerUid || me.data().referralCounted) {
        return res.status(200).json({ ok: true, skipped: true });
      }
      const referrerRef = db.collection('users').doc(referrerUid);
      const referrerSnap = await referrerRef.get();
      if(!referrerSnap.exists || !referrerSnap.data().referralEnabled){
        return res.status(200).json({ ok: true, skipped: true });
      }
      await referrerRef.set({ referralInvitedCount: admin.firestore.FieldValue.increment(1) }, { merge: true });
      await me.ref.set({ referralCounted: true }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    const code = normalizeReferralCode(body.code);
    if(!code) return res.status(200).json({ valid: false });
    const qs = await db.collection('users').where('referralCode', '==', code).limit(1).get();
    if(qs.empty) return res.status(200).json({ valid: false });

    const doc = qs.docs[0];
    const d = doc.data() || {};
    const excludeUid = String(body.excludeUid || '');
    if(!d.referralEnabled || (excludeUid && doc.id === excludeUid)){
      return res.status(200).json({ valid: false });
    }
    return res.status(200).json({ valid: true, uid: doc.id, code, name: d.name || '' });
  }catch(err){
    console.error('resolve-referral', err);
    return res.status(500).json({ error: 'Não foi possível processar a indicação agora.' });
  }
};
