module.exports = async function handler(req, res){
  if(req.method === 'GET'){
    const mode = req.query && req.query['hub.mode'];
    const token = req.query && req.query['hub.verify_token'];
    const challenge = req.query && req.query['hub.challenge'];
    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

    if(mode === 'subscribe' && expected && token === expected){
      return res.status(200).send(String(challenge || ''));
    }
    return res.status(403).send('Forbidden');
  }

  if(req.method === 'POST'){
    try{
      const body = req.body || {};
      const entries = Array.isArray(body.entry) ? body.entry : [];
      for(const entry of entries){
        const changes = Array.isArray(entry.changes) ? entry.changes : [];
        for(const change of changes){
          if(change && change.field === 'messages'){
            const value = change.value || {};
            const statuses = Array.isArray(value.statuses) ? value.statuses : [];
            for(const status of statuses){
              console.log('WhatsApp status', {
                id: status.id,
                status: status.status,
                recipient_id: status.recipient_id,
                timestamp: status.timestamp,
                errors: status.errors || null
              });
            }
            const messages = Array.isArray(value.messages) ? value.messages : [];
            for(const message of messages){
              console.log('WhatsApp inbound message', {
                from: message.from,
                id: message.id,
                type: message.type,
                timestamp: message.timestamp
              });
            }
          }
        }
      }
      return res.status(200).json({received:true});
    }catch(err){
      console.error('whatsapp-webhook error', err);
      return res.status(200).json({received:true});
    }
  }

  return res.status(405).json({error:'Method not allowed'});
};
