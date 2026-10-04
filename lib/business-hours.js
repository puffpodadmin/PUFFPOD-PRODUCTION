// Horário de funcionamento da loja (horário de Brasília):
//   Segunda a quinta: 10:00 às 00:00 (meia-noite)
//   Sexta a domingo:  12:00 às 18:00
//
// Usado tanto no checkout (pra avisar o cliente e travar o botão de pagar)
// quanto aqui no servidor (pra recusar a criação do Pix fora do horário,
// já que o front pode ser contornado).
const TZ = 'America/Sao_Paulo';

const SCHEDULE = {
  weekday: { openMinutes: 10 * 60, closeMinutes: 24 * 60, label: 'das 10h às 00h' },   // seg a qui
  weekend: { openMinutes: 12 * 60, closeMinutes: 18 * 60, label: 'das 12h às 18h' }    // sex a dom
};

function saoPauloParts(date){
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  });
  const map = {};
  fmt.formatToParts(date || new Date()).forEach(p => { map[p.type] = p.value; });
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(map.hour);
  if(hour === 24) hour = 0; // alguns runtimes retornam "24" pra meia-noite
  return { dow: weekdayMap[map.weekday], hour, minute: Number(map.minute) };
}

function ruleForDay(dow){
  // segunda(1) a quinta(4) usa o horário "weekday"; sexta(5), sábado(6) e domingo(0) usa "weekend"
  return (dow >= 1 && dow <= 4) ? SCHEDULE.weekday : SCHEDULE.weekend;
}

function isOpenNow(date){
  const { dow, hour, minute } = saoPauloParts(date);
  const minutes = hour * 60 + minute;
  const rule = ruleForDay(dow);
  return minutes >= rule.openMinutes && minutes < rule.closeMinutes;
}

function scheduleMessage(){
  return 'Funcionamos de segunda a quinta das 10h às 00h, e de sexta a domingo das 12h às 18h (horário de Brasília).';
}

module.exports = { isOpenNow, saoPauloParts, scheduleMessage, TZ };
