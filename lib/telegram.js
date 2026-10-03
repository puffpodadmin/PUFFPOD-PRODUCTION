// Envia mensagens para um chat/grupo do Telegram via Bot API.
// Configuração (variáveis de ambiente na Vercel):
//   TELEGRAM_BOT_TOKEN — token do bot, obtido com o @BotFather
//   TELEGRAM_CHAT_ID   — id do chat/grupo que deve receber os avisos
// Se as variáveis não estiverem configuradas, a função não lança erro —
// apenas avisa no log e segue (não deve travar o processamento do pedido).
async function sendTelegramMessage(text){
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if(!token || !chatId){
    console.warn('Telegram não configurado (defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID na Vercel).');
    return { skipped: true };
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  const raw = await res.text();
  let data = {};
  try{ data = raw ? JSON.parse(raw) : {}; }catch(e){ data = { description: raw }; }
  if(!res.ok || data.ok === false){
    throw new Error('Telegram: ' + (data.description || `HTTP ${res.status}`));
  }
  return data;
}

module.exports = { sendTelegramMessage };
