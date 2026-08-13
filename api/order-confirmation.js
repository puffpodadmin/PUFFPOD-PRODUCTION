const nodemailer = require('nodemailer');

const PROJECT_ID = 'puffpod-28a24';
const STORE_EMAIL = 'support.puffpod@gmail.com';

function firestoreValue(field){
  if(!field || typeof field !== 'object') return null;
  if('stringValue' in field) return field.stringValue;
  if('booleanValue' in field) return field.booleanValue;
  if('integerValue' in field) return Number(field.integerValue);
  if('doubleValue' in field) return Number(field.doubleValue);
  if('timestampValue' in field) return field.timestampValue;
  return null;
}

async function getOrder(orderId, token){
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/orders/${encodeURIComponent(orderId)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if(!r.ok){
    const msg = await r.text();
    throw new Error(`Não foi possível validar o pedido no Firestore (${r.status}). ${msg.slice(0,180)}`);
  }
  const doc = await r.json();
  const f = doc.fields || {};
  return {
    email: firestoreValue(f.email),
    name: firestoreValue(f.name),
    phone: firestoreValue(f.phone),
    orderId: firestoreValue(f.orderId) || orderId,
    emailSent: !!firestoreValue(f.confirmationEmailSent),
    whatsappSent: !!firestoreValue(f.confirmationWhatsappSent)
  };
}

async function markConfirmationStatus(orderId, token, fields){
  const keys = Object.keys(fields);
  const masks = keys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const bodyFields = {};
  for(const [key,val] of Object.entries(fields)){
    if(typeof val === 'boolean') bodyFields[key] = { booleanValue: val };
    else if(val instanceof Date) bodyFields[key] = { timestampValue: val.toISOString() };
    else bodyFields[key] = { stringValue: String(val) };
  }
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/orders/${encodeURIComponent(orderId)}?${masks}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: bodyFields })
  });
  if(!r.ok) console.warn('Não foi possível marcar status de confirmação:', r.status, await r.text());
}

function normalizeBrazilPhone(phone){
  let digits = String(phone || '').replace(/\D/g,'');
  if(!digits) return '';
  if(digits.startsWith('55')) return digits;
  if(digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}

async function sendWhatsAppTemplate({to, firstName, orderId}){
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'pedido_confirmado';
  const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'pt_BR';
  const graphVersion = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
  if(!token || !phoneNumberId) throw new Error('WhatsApp Cloud API ainda não configurada na Vercel.');
  const recipient = normalizeBrazilPhone(to);
  if(!recipient) throw new Error('Pedido sem telefone válido para WhatsApp.');

  const components = [];
  const headerImageUrl = String(process.env.WHATSAPP_HEADER_IMAGE_URL || '').trim();
  if(headerImageUrl){
    components.push({
      type: 'header',
      parameters: [{
        type: 'image',
        image: { link: headerImageUrl }
      }]
    });
  }
  components.push({
    type: 'body',
    parameters: [
      { type: 'text', text: firstName },
      { type: 'text', text: orderId }
    ]
  });

  const payload = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components
    }
  };

  const r = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const raw = await r.text();
  let data; try{ data = JSON.parse(raw); } catch { data = {raw}; }
  if(!r.ok){
    const detail = data && data.error && (data.error.message || data.error.error_user_msg);
    throw new Error(detail || `Falha ao enviar WhatsApp (${r.status}).`);
  }
  return data;
}

async function verifyPaysurePaid(referenceCode){
  const ci = process.env.PAYSURE_CI;
  const cs = process.env.PAYSURE_CS;
  if(!ci || !cs) throw new Error('Credenciais Paysure não configuradas.');
  const upstream = await fetch('https://api.paysurebr.com/v1/pix/cashin/consult', {
    method: 'POST',
    headers: { ci, cs, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference_code: String(referenceCode) })
  });
  const raw = await upstream.text();
  let data; try { data = JSON.parse(raw); } catch { data = {}; }
  if(!upstream.ok) throw new Error(data.error || data.message || 'Falha ao validar pagamento na Paysure.');
  const cashin = data.cashin || {};
  const status = String(cashin.status || '').toLowerCase();
  const paid = status === 'paid' || (!!cashin.payment_date && status !== 'refunded');
  if(!paid) throw new Error('Pagamento ainda não está confirmado pela Paysure.');
  return cashin;
}

function moneyFromCents(cents){
  return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((Number(cents)||0)/100);
}

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const auth = String(req.headers.authorization || '');
    if(!auth.startsWith('Bearer ')) return res.status(401).json({error:'Sessão do pedido não encontrada.'});
    const token = auth.slice(7);
    const { orderId, reference_code } = req.body || {};
    if(!orderId || !reference_code) return res.status(400).json({error:'Pedido ou referência de pagamento ausente.'});

    const order = await getOrder(String(orderId), token);
    if(order.emailSent && order.whatsappSent) return res.status(200).json({ok:true, alreadySent:true, emailSent:true, whatsappSent:true});

    const cashin = await verifyPaysurePaid(reference_code);
    const firstName = String(order.name || 'cliente').trim().split(/\s+/)[0] || 'cliente';
    const amount = moneyFromCents(cashin.value_cents);
    let emailSent = order.emailSent;
    let whatsappSent = order.whatsappSent;
    const warnings = [];

    if(!emailSent){
      try{
        if(!order.email) throw new Error('Pedido sem e-mail para confirmação.');
        const appPassword = process.env.PUFFPOD_GMAIL_APP_PASSWORD;
        if(!appPassword) throw new Error('PUFFPOD_GMAIL_APP_PASSWORD não configurada na Vercel.');
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: STORE_EMAIL, pass: appPassword } });
        const subject = `Pagamento confirmado — Pedido ${order.orderId}`;
        const text = `Olá, ${firstName}!\n\nSeu pagamento foi confirmado com sucesso.\n\nPedido: ${order.orderId}\nValor pago: ${amount}\n\nSeu produto está a caminho. A Puffpod acompanhará a entrega até você.\n\nWhatsApp oficial Puffpod: (41) 99923-8366.\n\nPuffpod`;
        const html = `
          <div style="font-family:Arial,sans-serif;background:#061d2c;padding:28px;color:#eaf6fb">
            <div style="max-width:560px;margin:auto;background:#0b3550;border:1px solid #1d5573;border-radius:18px;padding:28px">
              <div style="font-size:12px;letter-spacing:2px;color:#48cae4;text-transform:uppercase">Puffpod</div>
              <h1 style="font-size:24px;margin:10px 0 16px">Pagamento confirmado ✓</h1>
              <p>Olá, <strong>${firstName}</strong>!</p>
              <p>Recebemos seu pagamento e seu produto <strong>está a caminho</strong>.</p>
              <div style="background:#06283d;border-radius:12px;padding:16px;margin:20px 0">
                <div style="color:#9ec0d8;font-size:12px">CÓDIGO DO PEDIDO</div>
                <div style="font-family:monospace;font-size:19px;color:#67e8f9;margin-top:6px">${order.orderId}</div>
                <div style="margin-top:12px;color:#cde6ef">Valor pago: <strong>${amount}</strong></div>
              </div>
              <p style="color:#9ec0d8">Guarde o código acima para acompanhar ou falar com nosso atendimento.</p>
              <p style="margin-top:24px">WhatsApp oficial Puffpod: <strong>(41) 99923-8366</strong></p>
            </div>
          </div>`;
        await transporter.sendMail({ from: `Puffpod <${STORE_EMAIL}>`, to: order.email, replyTo: STORE_EMAIL, subject, text, html });
        emailSent = true;
        await markConfirmationStatus(String(orderId), token, { confirmationEmailSent:true, confirmationEmailSentAt:new Date() });
      }catch(e){
        console.error('confirmation email error', e);
        warnings.push('E-mail: '+e.message);
      }
    }

    if(!whatsappSent){
      try{
        const waResult = await sendWhatsAppTemplate({to:order.phone, firstName, orderId:order.orderId});
        whatsappSent = true;
        const waMessageId = waResult && waResult.messages && waResult.messages[0] && waResult.messages[0].id;
        const waFields = { confirmationWhatsappSent:true, confirmationWhatsappSentAt:new Date() };
        if(waMessageId) waFields.confirmationWhatsappMessageId = waMessageId;
        await markConfirmationStatus(String(orderId), token, waFields);
      }catch(e){
        console.error('confirmation whatsapp error', e);
        warnings.push('WhatsApp: '+e.message);
      }
    }

    if(!emailSent && !whatsappSent){
      return res.status(502).json({error:'Pagamento confirmado, mas não foi possível enviar as notificações.', warnings});
    }
    return res.status(200).json({ok:true,emailSent,whatsappSent,warnings});
  }catch(err){
    console.error('order-confirmation error', err);
    return res.status(500).json({error:err.message || 'Falha ao enviar confirmação do pedido.'});
  }
};
