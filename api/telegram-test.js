const { getAdmin } = require('../lib/firebase-admin');
const { sendTelegramMessage } = require('../lib/telegram');

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const auth=String(req.headers.authorization||'');
    if(!auth.startsWith('Bearer ')) return res.status(401).json({error:'Autenticação necessária.'});

    const admin=getAdmin();
    const decoded=await admin.auth().verifyIdToken(auth.slice(7));
    const email=String(decoded.email||'').toLowerCase();
    if(email!=='support.puffpod@gmail.com') return res.status(403).json({error:'Apenas o administrador pode executar o teste.'});

    const result=await sendTelegramMessage('✅ Puffpod conectado ao Telegram com sucesso! Os avisos de venda paga vão chegar por aqui.');
    if(result.skipped){
      return res.status(200).json({ ok:false, skipped:true, message:'TELEGRAM_BOT_TOKEN e/ou TELEGRAM_CHAT_ID não configurados na Vercel.' });
    }
    return res.status(200).json({ ok:true, message:'Mensagem de teste enviada. Confira o Telegram.' });
  }catch(err){
    console.error('telegram-test', err);
    return res.status(500).json({ ok:false, error: err.message || 'Falha ao enviar mensagem de teste.' });
  }
};
