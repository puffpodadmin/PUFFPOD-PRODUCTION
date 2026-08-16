const crypto = require('crypto');

const PROJECT_ID = 'puffpod-28a24';
const ADMIN_EMAIL = 'support.puffpod@gmail.com';
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache = { certs:null, expiresAt:0 };

function json(res, status, body){
  res.statusCode = status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
  res.end(JSON.stringify(body));
}

function b64urlDecode(str){
  str = String(str || '').replace(/-/g,'+').replace(/_/g,'/');
  while(str.length % 4) str += '=';
  return Buffer.from(str,'base64');
}

async function getGoogleCerts(){
  if(certCache.certs && Date.now() < certCache.expiresAt) return certCache.certs;
  const r = await fetch(CERTS_URL);
  if(!r.ok) throw new Error('Não foi possível obter certificados do Firebase.');
  const certs = await r.json();
  const cacheControl = r.headers.get('cache-control') || '';
  const m = cacheControl.match(/max-age=(\d+)/i);
  const maxAge = m ? Number(m[1]) : 3600;
  certCache = { certs, expiresAt:Date.now() + Math.max(60,maxAge-60)*1000 };
  return certs;
}

async function verifyFirebaseIdToken(token){
  const parts = String(token || '').split('.');
  if(parts.length !== 3) throw new Error('Token inválido.');
  const header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  if(header.alg !== 'RS256' || !header.kid) throw new Error('Token inválido.');
  const certs = await getGoogleCerts();
  const cert = certs[header.kid];
  if(!cert) throw new Error('Certificado não encontrado.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0]+'.'+parts[1]), cert, b64urlDecode(parts[2]));
  if(!ok) throw new Error('Assinatura inválida.');
  const now = Math.floor(Date.now()/1000);
  if(payload.exp <= now || payload.iat > now + 60) throw new Error('Token expirado.');
  if(payload.aud !== PROJECT_ID) throw new Error('Audience inválida.');
  if(payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new Error('Issuer inválido.');
  if(!payload.sub) throw new Error('Usuário inválido.');
  return payload;
}

function base32Decode(input){
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean=String(input||'').toUpperCase().replace(/[^A-Z2-7]/g,'');
  let bits='', out=[];
  for(const c of clean){
    const v=alphabet.indexOf(c);
    if(v<0) continue;
    bits += v.toString(2).padStart(5,'0');
  }
  for(let i=0;i+8<=bits.length;i+=8) out.push(parseInt(bits.slice(i,i+8),2));
  return Buffer.from(out);
}

function totp(secret, counter){
  const key=base32Decode(secret);
  const buf=Buffer.alloc(8);
  const hi=Math.floor(counter/0x100000000);
  const lo=counter>>>0;
  buf.writeUInt32BE(hi>>>0,0); buf.writeUInt32BE(lo,4);
  const h=crypto.createHmac('sha1',key).update(buf).digest();
  const offset=h[h.length-1]&0x0f;
  const n=((h[offset]&0x7f)<<24)|((h[offset+1]&0xff)<<16)|((h[offset+2]&0xff)<<8)|(h[offset+3]&0xff);
  return String(n%1000000).padStart(6,'0');
}

function safeEqual(a,b){
  const aa=Buffer.from(String(a)); const bb=Buffer.from(String(b));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}

module.exports = async function handler(req,res){
  if(req.method !== 'POST') return json(res,405,{error:'Method not allowed'});
  const secret=String(process.env.ADMIN_TOTP_SECRET || '').replace(/\s+/g,'').toUpperCase();
  if(!secret) return json(res,503,{error:'MFA administrativo ainda não foi configurado na Vercel.'});

  try{
    const authHeader=req.headers.authorization || '';
    if(!authHeader.startsWith('Bearer ')) return json(res,401,{error:'Sessão administrativa inválida.'});
    const claims=await verifyFirebaseIdToken(authHeader.slice(7));
    if(String(claims.email||'').toLowerCase() !== ADMIN_EMAIL) return json(res,403,{error:'Acesso negado.'});

    const action=String((req.body && req.body.action)||'verify');

    if(action === 'setup'){
      return json(res,403,{error:'A configuração por QR está desativada. O MFA existente continua válido.'});
    }

    const code=String((req.body && req.body.code)||'').replace(/\D/g,'');
    if(code.length!==6) return json(res,400,{error:'Código inválido.'});
    const counter=Math.floor(Date.now()/30000);
    const valid=[-1,0,1].some(w=>safeEqual(totp(secret,counter+w),code));
    if(!valid) return json(res,401,{error:'Código inválido ou expirado.'});
    return json(res,200,{ok:true});
  }catch(err){
    console.error('admin-mfa:',err);
    return json(res,401,{error:'Não foi possível validar a sessão administrativa.'});
  }
};
