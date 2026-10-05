const nodemailer = require('nodemailer');

const STORE_EMAIL = 'support.puffpod@gmail.com';

function getTransporter(){
  const appPassword = process.env.PUFFPOD_GMAIL_APP_PASSWORD;
  if(!appPassword) throw new Error('PUFFPOD_GMAIL_APP_PASSWORD não configurada na Vercel.');
  return nodemailer.createTransport({ service: 'gmail', auth: { user: STORE_EMAIL, pass: appPassword } });
}

// Envia um e-mail da Puffpod com o visual padrão (cartão escuro) e, se
// `cardImage` for passado, embute essa imagem como a imagem principal do
// corpo do e-mail (via cid, sem precisar de hospedagem pública). Se não
// houver imagem, usa o `fallbackHtml` (ex: a caixa azul com texto simples).
async function sendBrandedEmail({ to, subject, text, introHtml, afterHtml, cardImage, imageFilename, fallbackHtml }){
  if(!to) throw new Error('E-mail do destinatário ausente.');
  const transporter = getTransporter();

  const attachments = cardImage ? [{ filename: imageFilename || 'puffpod.png', content: cardImage, cid: 'cardImage' }] : [];
  const imageHtml = cardImage
    ? `<img src="cid:cardImage" alt="${subject}" style="width:100%;max-width:560px;display:block;margin:0 auto;border-radius:16px">`
    : (fallbackHtml || '');

  const html = `<div style="font-family:Arial,sans-serif;background:#061d2c;padding:28px;color:#eaf6fb"><div style="max-width:560px;margin:auto;background:#0b3550;border:1px solid #1d5573;border-radius:18px;padding:28px">${introHtml || ''}${imageHtml}${afterHtml || ''}</div></div>`;

  await transporter.sendMail({
    from: `Puffpod <${STORE_EMAIL}>`,
    to,
    replyTo: STORE_EMAIL,
    subject,
    text,
    html,
    attachments
  });
}

module.exports = { sendBrandedEmail, STORE_EMAIL };
