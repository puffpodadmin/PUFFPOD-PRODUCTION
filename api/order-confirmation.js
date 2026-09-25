const { getAdmin } = require('../lib/firebase-admin');
const { sendPaymentConfirmedEmail } = require('../lib/mailer');

function normalizeBrazilPhone(phone){let d=String(phone||'').replace(/\D/g,'');if(!d)return'';if(d.startsWith('55'))return d;if(d.length===10||d.length===11)return'55'+d;return d;}
function money(v){return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v)||0);}

async function sendWhatsAppTemplate({to,firstName,orderId}){
  const token=process.env.WHATSAPP_ACCESS_TOKEN, phoneNumberId=process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName=process.env.WHATSAPP_TEMPLATE_NAME||'pedido_confirmado', languageCode=process.env.WHATSAPP_TEMPLATE_LANGUAGE||'pt_BR', graphVersion=process.env.WHATSAPP_GRAPH_VERSION||'v23.0';
  if(!token||!phoneNumberId) throw new Error('WhatsApp Cloud API ainda não configurada na Vercel.');
  const recipient=normalizeBrazilPhone(to); if(!recipient) throw new Error('Pedido sem telefone válido para WhatsApp.');
  const components=[]; const headerImageUrl=String(process.env.WHATSAPP_HEADER_IMAGE_URL||'').trim();
  if(headerImageUrl) components.push({type:'header',parameters:[{type:'image',image:{link:headerImageUrl}}]});
  components.push({type:'body',parameters:[{type:'text',text:firstName},{type:'text',text:orderId}]});
  const r=await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:recipient,type:'template',template:{name:templateName,language:{code:languageCode},components}})});
  const raw=await r.text();let data;try{data=JSON.parse(raw);}catch{data={raw};}
  if(!r.ok) throw new Error(data?.error?.message||data?.error?.error_user_msg||`Falha ao enviar WhatsApp (${r.status}).`);
  return data;
}

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const auth=String(req.headers.authorization||''); if(!auth.startsWith('Bearer ')) return res.status(401).json({error:'Sessão do pedido não encontrada.'});
    const admin=getAdmin(), decoded=await admin.auth().verifyIdToken(auth.slice(7)), db=admin.firestore();
    const orderId=String((req.body||{}).orderId||''); if(!orderId) return res.status(400).json({error:'Pedido ausente.'});
    const ref=db.collection('orders').doc(orderId), snap=await ref.get(); if(!snap.exists) return res.status(404).json({error:'Pedido não encontrado.'});
    const order=snap.data()||{}; if(order.uid&&order.uid!==decoded.uid) return res.status(403).json({error:'Pedido não pertence a esta sessão.'});
    if(order.paymentStatus!=='paid') return res.status(409).json({error:'Pagamento ainda não confirmado.'});
    const already=!!order.confirmationEmailSent&&!!order.confirmationWhatsappSent;
    if(already) return res.status(200).json({ok:true,alreadySent:true,emailSent:true,whatsappSent:true});

    const firstName=String(order.name||'cliente').trim().split(/\s+/)[0]||'cliente', amount=money(order.total);
    let emailSent=!!order.confirmationEmailSent, whatsappSent=!!order.confirmationWhatsappSent; const warnings=[];
    if(!emailSent){
      try{
        if(!order.email) throw new Error('Pedido sem e-mail para confirmação.');
        await sendPaymentConfirmedEmail({ to:order.email, name:order.name, orderId, amount:order.total });
        emailSent=true; await ref.set({confirmationEmailSent:true,confirmationEmailSentAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      }catch(e){console.error('confirmation email',e);warnings.push('E-mail: '+e.message);}
    }
    if(!whatsappSent){
      try{
        const wa=await sendWhatsAppTemplate({to:order.phone,firstName,orderId}); whatsappSent=true;
        await ref.set({confirmationWhatsappSent:true,confirmationWhatsappSentAt:admin.firestore.FieldValue.serverTimestamp(),confirmationWhatsappMessageId:wa?.messages?.[0]?.id||null},{merge:true});
      }catch(e){console.error('confirmation whatsapp',e);warnings.push('WhatsApp: '+e.message);}
    }
    if(!emailSent&&!whatsappSent) return res.status(502).json({error:'Pagamento confirmado, mas não foi possível enviar as notificações.',warnings});
    return res.status(200).json({ok:true,emailSent,whatsappSent,warnings});
  }catch(err){console.error('order-confirmation',err);return res.status(500).json({error:err.message||'Falha ao enviar confirmação.'});}
};
