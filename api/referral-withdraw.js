const { getAdmin } = require('../lib/firebase-admin');
const { sendWithdrawalRequestedEmail } = require('../lib/withdrawal-notify');
const { sendTelegramMessage } = require('../lib/telegram');

// Saque MANUAL: a solicitação fica "pending" e o admin faz o Pix por fora,
// depois marca como pago (ou estorna com justificativa) em
// Painel > Indicadores > Solicitações de saque (api/referral-admin.js).
const MIN_WITHDRAWAL = 30;
const PIX_TYPES = ['cpf','cnpj','email','phone','random'];
function cleanPixKey(v){ return String(v||'').trim().slice(0,180); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function money(v){ return 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
const PIX_LABEL = { cpf:'CPF', cnpj:'CNPJ', email:'E-mail', phone:'Telefone', random:'Chave aleatória' };

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const authHeader=String(req.headers.authorization||'');
    if(!authHeader.startsWith('Bearer ')) return res.status(401).json({error:'Faça login para solicitar o saque.'});
    const admin=getAdmin(),db=admin.firestore(),decoded=await admin.auth().verifyIdToken(authHeader.slice(7));

    const pixType=String((req.body&&req.body.pixType)||'').trim().toLowerCase();
    const pixKey=cleanPixKey(req.body&&req.body.pixKey);
    if(!PIX_TYPES.includes(pixType)||!pixKey) return res.status(400).json({error:'Informe uma chave Pix válida.'});

    const userRef=db.collection('users').doc(decoded.uid);
    const withdrawalRef=db.collection('referralWithdrawals').doc();
    let amount=0,userData={};

    await db.runTransaction(async tx=>{
      const snap=await tx.get(userRef);
      if(!snap.exists) throw new Error('Cadastro não encontrado.');
      userData=snap.data()||{};
      if(!userData.referralEnabled) throw new Error('Seu programa de indicação não está ativo.');
      amount=Math.floor((Number(userData.referralAvailable||0)+Number.EPSILON)*100)/100;
      if(amount<MIN_WITHDRAWAL) throw new Error('O saque mínimo é de R$ 30,00. Continue indicando para atingir o valor mínimo.');
      tx.set(withdrawalRef,{
        uid:decoded.uid,
        userName:userData.name||decoded.name||'',
        userEmail:userData.email||decoded.email||'',
        amount,pixType,pixKey,
        status:'pending',
        mode:'manual',
        createdAt:admin.firestore.FieldValue.serverTimestamp()
      });
      tx.update(userRef,{
        referralAvailable:admin.firestore.FieldValue.increment(-amount),
        referralPending:admin.firestore.FieldValue.increment(amount),
        referralLastWithdrawalAt:admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const name=userData.name||decoded.name||'';
    const toEmail=userData.email||decoded.email||'';

    // Avisos best-effort: não derrubam a solicitação se falharem.
    try{
      if(toEmail) await sendWithdrawalRequestedEmail({to:toEmail,name,amount,withdrawalId:withdrawalRef.id});
    }catch(e){ console.error('withdrawal requested email',e.message); }

    try{
      await sendTelegramMessage([
        '💰 <b>Nova solicitação de saque</b>',
        '',
        `<b>Quem pediu:</b> ${esc(name||toEmail||decoded.uid)}`,
        toEmail?`<b>E-mail:</b> ${esc(toEmail)}`:'',
        `<b>Valor:</b> ${esc(money(amount))}`,
        `<b>Chave Pix (${esc(PIX_LABEL[pixType]||pixType)}):</b> <code>${esc(pixKey)}</code>`,
        '',
        'Pague manualmente e marque como pago em Painel › Indicadores › Solicitações de saque.'
      ].filter(Boolean).join('\n'));
    }catch(e){ console.error('withdrawal telegram',e.message); }

    return res.status(200).json({
      ok:true,
      withdrawalId:withdrawalRef.id,
      amount,
      status:'pending',
      message:'Solicitação de saque enviada. Você receberá o Pix após a análise.'
    });
  }catch(err){
    console.error('referral-withdraw',err.message);
    return res.status(400).json({error:err.message||'Não foi possível solicitar o saque.'});
  }
};
