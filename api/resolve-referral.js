const { getAdmin } = require('../lib/firebase-admin');

// Resolve um código de indicação no servidor (via Admin SDK), porque o
// front-end não pode mais fazer isso direto no Firestore: a regra de
// segurança de /users só libera leitura do PRÓPRIO documento (ou do admin),
// então uma consulta `where('referralCode','==',code)` feita por um
// visitante não logado ou por um usuário comum sempre batia num
// "permission-denied" — e por isso `referredByUid`/`referredByCode` nunca
// eram gravados no cadastro de quem entrava pelo link de indicação (e pior
// ainda no login/cadastro via Google, que não passa pelo formulário de
// cadastro). Esse endpoint faz a mesma checagem só que com privilégios de
// admin, então funciona pra qualquer visitante, logado ou não.
function normalizeReferralCode(value){
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
}

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try{
    const code = normalizeReferralCode((req.body || {}).code);
    if(!code) return res.status(200).json({ valid: false });

    const admin = getAdmin();
    const db = admin.firestore();
    const qs = await db.collection('users').where('referralCode', '==', code).limit(1).get();
    if(qs.empty) return res.status(200).json({ valid: false });

    const doc = qs.docs[0];
    const d = doc.data() || {};
    const excludeUid = String((req.body || {}).excludeUid || '');
    if(!d.referralEnabled || (excludeUid && doc.id === excludeUid)){
      return res.status(200).json({ valid: false });
    }

    return res.status(200).json({
      valid: true,
      uid: doc.id,
      code,
      name: d.name || ''
    });
  }catch(err){
    console.error('resolve-referral', err);
    return res.status(500).json({ error: 'Não foi possível validar o código de indicação agora.' });
  }
};
