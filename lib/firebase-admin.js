const admin = require('firebase-admin');

function getAdmin(){
  if(admin.apps.length) return admin;
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if(!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON não configurada na Vercel.');
  let serviceAccount;
  try{ serviceAccount = JSON.parse(raw); }catch(e){ throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON inválida. Salve o JSON completo da conta de serviço.'); }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin;
}

module.exports = { getAdmin };
