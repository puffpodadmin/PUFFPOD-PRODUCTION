const { getAdmin } = require('../lib/firebase-admin');

// Chamado (best-effort, não bloqueia o cadastro) logo depois que um novo
// usuário é criado com um indicador válido. Só existe porque a regra de
// segurança do Firestore não deixa o navegador do usuário recém-cadastrado
// escrever/incrementar um campo no documento de OUTRA pessoa (o indicador)
// — então esse contador (quantas pessoas cada um indicou, mostrado no
// painel "Ganhos com indicação" e no admin) precisa ser atualizado aqui,
// com o Admin SDK.
module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try{
    const auth = String(req.headers.authorization || '');
    if(!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Sessão não encontrada.' });

    const admin = getAdmin();
    const decoded = await admin.auth().verifyIdToken(auth.slice(7));
    const referrerUid = String((req.body || {}).referrerUid || '');
    if(!referrerUid || referrerUid === decoded.uid) return res.status(400).json({ error: 'Indicador inválido.' });

    const db = admin.firestore();
    const referrerRef = db.collection('users').doc(referrerUid);
    const referrerSnap = await referrerRef.get();
    if(!referrerSnap.exists || !referrerSnap.data().referralEnabled){
      return res.status(200).json({ ok: true, skipped: true });
    }

    await referrerRef.set({
      referralInvitedCount: admin.firestore.FieldValue.increment(1)
    }, { merge: true });

    return res.status(200).json({ ok: true });
  }catch(err){
    console.error('link-referral', err);
    return res.status(500).json({ error: 'Falha ao vincular indicação.' });
  }
};
