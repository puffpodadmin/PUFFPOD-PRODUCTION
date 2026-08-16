const { getAdmin } = require('../lib/firebase-admin');
const nodemailer = require('nodemailer');
const STORE_EMAIL='support.puffpod@gmail.com';

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
        const appPassword=process.env.PUFFPOD_GMAIL_APP_PASSWORD; if(!appPassword) throw new Error('PUFFPOD_GMAIL_APP_PASSWORD não configurada na Vercel.');
        const transporter=nodemailer.createTransport({service:'gmail',auth:{user:STORE_EMAIL,pass:appPassword}});
        await transporter.sendMail({from:`Puffpod <${STORE_EMAIL}>`,to:order.email,replyTo:STORE_EMAIL,subject:`Pagamento confirmado — Pedido ${orderId}`,text:`Olá, ${firstName}!\n\nSeu pagamento foi confirmado com sucesso.\n\nPedido: ${orderId}\nValor pago: ${amount}\n\nSeu produto está a caminho.\n\nPuffpod`,html:`<div style="font-family:Arial,sans-serif;background:#061d2c;padding:28px;color:#eaf6fb"><div style="max-width:560px;margin:auto;background:#0b3550;border:1px solid #1d5573;border-radius:18px;padding:28px"><div style="font-size:12px;letter-spacing:2px;color:#48cae4;text-transform:uppercase">Puffpod</div><h1>Pagamento confirmado ✓</h1><p>Olá, <strong>${firstName}</strong>!</p><p>Recebemos seu pagamento com sucesso.</p><div style="background:#06283d;border-radius:12px;padding:16px"><div>CÓDIGO DO PEDIDO</div><div style="font-family:monospace;font-size:19px;color:#67e8f9">${orderId}</div><div style="margin-top:12px">Valor pago: <strong>${amount}</strong></div></div></div></div>`});
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
