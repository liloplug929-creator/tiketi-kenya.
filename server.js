require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const baseUrl = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'tiketi.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'organizer', status TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, organizer_id INTEGER NOT NULL, title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '', venue TEXT NOT NULL, county TEXT NOT NULL DEFAULT '',
 event_date TEXT NOT NULL, price_kes INTEGER NOT NULL DEFAULT 0, capacity INTEGER NOT NULL DEFAULT 100,
 image_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(organizer_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, buyer_name TEXT NOT NULL,
 buyer_email TEXT NOT NULL, phone TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL,
 total_kes INTEGER NOT NULL, commission_kes INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 merchant_request_id TEXT, checkout_request_id TEXT, mpesa_receipt TEXT, ticket_code TEXT UNIQUE,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at TEXT,
 FOREIGN KEY(event_id) REFERENCES events(id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const defaultCommission = String(Math.max(0, Math.min(30, Number(process.env.DEFAULT_COMMISSION_PERCENT || 5))));
db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('commission_percent',?)").run(defaultCommission);

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(session({
  store: new SQLiteStore({ db: path.basename(process.env.SESSION_DB_PATH || 'sessions.sqlite'), dir: path.dirname(process.env.SESSION_DB_PATH || dbPath) }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 12 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function currentUser(req) {
 if (!req.session.userId) return null;
 return db.prepare('SELECT id,name,email,role,status FROM users WHERE id=?').get(req.session.userId) || null;
}
function requireAuth(req,res,next) { const u=currentUser(req); if(!u) return res.status(401).json({error:'Please sign in first.'}); req.user=u; next(); }
function requireAdmin(req,res,next) { const u=currentUser(req); if(!u || u.role!=='admin') return res.status(403).json({error:'Admin access required.'}); req.user=u; next(); }
function requireApprovedOrganizer(req,res,next) { const u=currentUser(req); if(!u) return res.status(401).json({error:'Please sign in first.'}); if(u.role!=='admin' && (u.role!=='organizer' || u.status!=='approved')) return res.status(403).json({error:'Your organizer account must be approved first.'}); req.user=u; next(); }
function safeEvent(row) { return row ? {...row, available: Math.max(0, row.capacity - (row.sold || 0))} : row; }
function setting(key) { return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; }

async function ensureAdmin() {
 const email=(process.env.ADMIN_EMAIL||'').trim().toLowerCase(); const password=process.env.ADMIN_PASSWORD||'';
 if (!email || !password || password.startsWith('replace-with')) { console.warn('Admin account not seeded: set ADMIN_EMAIL and a strong ADMIN_PASSWORD in environment.'); return; }
 const exists=db.prepare('SELECT id FROM users WHERE email=?').get(email);
 if (!exists) {
  const hash=await bcrypt.hash(password,12);
  db.prepare("INSERT INTO users(name,email,password_hash,role,status) VALUES(?,?,?,'admin','approved')").run('Astrokeed',email,hash);
  console.log('Initial admin account created from environment.');
 }
}

app.get('/api/health',(req,res)=>res.json({ok:true,app:'Astrokeed Tiketi Kenya'}));
app.get('/api/me',(req,res)=>res.json({user:currentUser(req)}));
app.post('/api/register', async (req,res)=>{
 try {
  const name=String(req.body.name||'').trim(); const email=String(req.body.email||'').trim().toLowerCase(); const password=String(req.body.password||'');
  if(name.length<2 || !/^\S+@\S+\.\S+$/.test(email) || password.length<10) return res.status(400).json({error:'Enter your name, a valid email and a password of at least 10 characters.'});
  const hash=await bcrypt.hash(password,12);
  db.prepare("INSERT INTO users(name,email,password_hash,role,status) VALUES(?,?,?,'organizer','pending')").run(name,email,hash);
  res.json({ok:true,message:'Organizer application received. An administrator must approve your account before you can publish events.'});
 } catch(e) { res.status(e.code==='SQLITE_CONSTRAINT_UNIQUE'?409:500).json({error:e.code==='SQLITE_CONSTRAINT_UNIQUE'?'That email is already registered.':'Could not create account.'}); }
});
app.post('/api/login',async(req,res)=>{
 const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||'');
 const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
 if(!user || !(await bcrypt.compare(password,user.password_hash))) return res.status(401).json({error:'Email or password is incorrect.'});
 req.session.userId=user.id;
 res.json({ok:true,user:{id:user.id,name:user.name,email:user.email,role:user.role,status:user.status}});
});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get('/api/events',(req,res)=>{
 const rows=db.prepare(`SELECT e.*,u.name AS organizer_name, COALESCE((SELECT SUM(quantity) FROM orders o WHERE o.event_id=e.id AND o.status='paid'),0) AS sold
 FROM events e JOIN users u ON u.id=e.organizer_id WHERE e.status='published' ORDER BY e.event_date ASC`).all();
 res.json({events:rows.map(safeEvent)});
});
app.get('/api/events/:id',(req,res)=>{
 const row=db.prepare(`SELECT e.*,u.name AS organizer_name, COALESCE((SELECT SUM(quantity) FROM orders o WHERE o.event_id=e.id AND o.status='paid'),0) AS sold FROM events e JOIN users u ON u.id=e.organizer_id WHERE e.id=? AND e.status='published'`).get(Number(req.params.id));
 if(!row) return res.status(404).json({error:'Event not found.'}); res.json({event:safeEvent(row)});
});
app.post('/api/events',requireApprovedOrganizer,(req,res)=>{
 const {title,description,venue,county,event_date,image_url}=req.body;
 const price=Number(req.body.price_kes),capacity=Number(req.body.capacity);
 if(!String(title||'').trim()||!String(venue||'').trim()||!String(event_date||'').trim()||!Number.isInteger(price)||price<0||!Number.isInteger(capacity)||capacity<1||capacity>100000) return res.status(400).json({error:'Enter an event title, venue, date, valid price and capacity.'});
 const status=req.user.role==='admin'?'published':'draft';
 const result=db.prepare('INSERT INTO events(organizer_id,title,description,venue,county,event_date,price_kes,capacity,image_url,status) VALUES(?,?,?,?,?,?,?,?,?,?)').run(req.user.id,String(title).trim(),String(description||'').trim(),String(venue).trim(),String(county||'').trim(),String(event_date),price,capacity,String(image_url||'').trim(),status);
 res.json({ok:true,id:result.lastInsertRowid,message:status==='published'?'Event published.':'Event saved as draft; admin approval is required before it appears publicly.'});
});
app.get('/api/my/events',requireApprovedOrganizer,(req,res)=>{
 const events=db.prepare(`SELECT e.*, COALESCE((SELECT SUM(quantity) FROM orders o WHERE o.event_id=e.id AND o.status='paid'),0) AS sold FROM events e WHERE (?='admin' OR e.organizer_id=?) ORDER BY e.created_at DESC`).all(req.user.role,req.user.id);
 res.json({events:events.map(safeEvent)});
});
app.patch('/api/admin/events/:id/status',requireAdmin,(req,res)=>{
 const status=String(req.body.status||''); if(!['draft','published','cancelled'].includes(status)) return res.status(400).json({error:'Invalid status.'});
 const result=db.prepare('UPDATE events SET status=? WHERE id=?').run(status,Number(req.params.id)); if(!result.changes) return res.status(404).json({error:'Event not found.'}); res.json({ok:true});
});

function mpesaConfigured(){ return ['MPESA_CONSUMER_KEY','MPESA_CONSUMER_SECRET','MPESA_SHORTCODE','MPESA_PASSKEY'].every(k=>process.env[k] && !process.env[k].startsWith('your-')); }
function mpesaHost(){ return process.env.MPESA_ENV==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke'; }
function timestampNow(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
async function mpesaToken(){ const auth=Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64'); const r=await fetch(`${mpesaHost()}/oauth/v1/generate?grant_type=client_credentials`,{headers:{Authorization:`Basic ${auth}`}}); const data=await r.json(); if(!r.ok||!data.access_token) throw new Error(data.errorMessage||'Could not authenticate with Daraja.'); return data.access_token; }
app.post('/api/checkout',async(req,res)=>{
 try {
  const eventId=Number(req.body.event_id), quantity=Number(req.body.quantity), name=String(req.body.buyer_name||'').trim(), email=String(req.body.buyer_email||'').trim(), phoneRaw=String(req.body.phone||'').replace(/[\s+()-]/g,'');
  const phone=phoneRaw.startsWith('0')?'254'+phoneRaw.slice(1):phoneRaw;
  if(!Number.isInteger(quantity)||quantity<1||quantity>10||name.length<2||!/^\S+@\S+\.\S+$/.test(email)||!/^254[17]\d{8}$/.test(phone)) return res.status(400).json({error:'Enter name, valid email, Kenyan M-Pesa number and quantity from 1 to 10.'});
  const event=db.prepare(`SELECT e.*, COALESCE((SELECT SUM(quantity) FROM orders o WHERE o.event_id=e.id AND o.status='paid'),0) sold FROM events e WHERE id=? AND status='published'`).get(eventId);
  if(!event) return res.status(404).json({error:'Event is not available.'});
  if(event.capacity-event.sold<quantity) return res.status(400).json({error:'Not enough tickets remain.'});
  const total=event.price_kes*quantity, commission=event.price_kes===0?0:Math.round(total*Number(setting('commission_percent')||5)/100);
  if(event.price_kes===0) {
   const ticketCode=crypto.randomBytes(8).toString('hex').toUpperCase();
   const freeOrder=db.prepare("INSERT INTO orders(event_id,buyer_name,buyer_email,phone,quantity,unit_price,total_kes,commission_kes,status,mpesa_receipt,ticket_code,paid_at) VALUES(?,?,?,?,?,?,0,0,'paid','FREE',?,CURRENT_TIMESTAMP)").run(eventId,name,email,phone,quantity,event.price_kes,ticketCode);
   return res.json({ok:true,message:'Free ticket claimed.',order_id:freeOrder.lastInsertRowid});
  }
  if(!mpesaConfigured()) return res.status(503).json({error:'M-Pesa is not connected yet. The site owner must add Daraja credentials before payments can be accepted.'});
  const order=db.prepare('INSERT INTO orders(event_id,buyer_name,buyer_email,phone,quantity,unit_price,total_kes,commission_kes,status) VALUES(?,?,?,?,?,?,?,?,\'pending\')').run(eventId,name,email,phone,quantity,event.price_kes,total,commission);
  const token=await mpesaToken(), timestamp=timestampNow(), shortcode=process.env.MPESA_SHORTCODE, password=Buffer.from(`${shortcode}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
  const payload={BusinessShortCode:shortcode,Password:password,Timestamp:timestamp,TransactionType:process.env.MPESA_TRANSACTION_TYPE||'CustomerPayBillOnline',Amount:total,PartyA:phone,PartyB:shortcode,PhoneNumber:phone,CallBackURL:`${baseUrl}/api/mpesa/callback`,AccountReference:`TIKETI${order.lastInsertRowid}`,TransactionDesc:`Tickets ${event.title}`.slice(0,100)};
  const r=await fetch(`${mpesaHost()}/mpesa/stkpush/v1/processrequest`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)}); const data=await r.json();
  if(!r.ok||data.ResponseCode!=='0') { db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(order.lastInsertRowid); return res.status(502).json({error:data.errorMessage||data.ResponseDescription||'M-Pesa could not start the payment. Check Daraja setup.'}); }
  db.prepare('UPDATE orders SET merchant_request_id=?,checkout_request_id=? WHERE id=?').run(data.MerchantRequestID,data.CheckoutRequestID,order.lastInsertRowid);
  res.json({ok:true,message:'Check your phone and enter your M-Pesa PIN to approve the payment. Tickets are issued only after payment confirmation.',order_id:order.lastInsertRowid});
 } catch(e) { console.error('Checkout error:',e.message); res.status(502).json({error:'Payment request failed. Please try again or contact support.'}); }
});
app.post('/api/mpesa/callback',(req,res)=>{
 try {
  const callback=req.body?.Body?.stkCallback; if(!callback?.CheckoutRequestID) return res.json({ResultCode:0,ResultDesc:'Received'});
  const order=db.prepare('SELECT * FROM orders WHERE checkout_request_id=?').get(callback.CheckoutRequestID);
  if(!order) return res.json({ResultCode:0,ResultDesc:'Received'});
  if(Number(callback.ResultCode)===0) {
   const meta={}; for(const item of (callback.CallbackMetadata?.Item||[])) meta[item.Name]=item.Value;
   const receipt=String(meta.MpesaReceiptNumber||''); const amount=Number(meta.Amount||0); const phone=String(meta.PhoneNumber||'');
   // Confirm callback amount and phone match the pending order before marking it paid.
   if(amount===order.total_kes && phone===order.phone) {
    const ticketCode=crypto.randomBytes(8).toString('hex').toUpperCase();
    db.prepare("UPDATE orders SET status='paid',mpesa_receipt=?,ticket_code=?,paid_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(receipt,ticketCode,order.id);
   } else { console.error('M-Pesa callback did not match amount/phone for order',order.id); }
  } else { db.prepare("UPDATE orders SET status='failed' WHERE id=? AND status='pending'").run(order.id); }
  res.json({ResultCode:0,ResultDesc:'Received'});
 } catch(e) { console.error('Callback error:',e.message); res.json({ResultCode:0,ResultDesc:'Received'}); }
});
app.get('/api/orders/:id/status',(req,res)=>{
 const order=db.prepare(`SELECT o.id,o.status,o.total_kes,o.quantity,o.ticket_code,o.mpesa_receipt,e.title,e.event_date,e.venue FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=?`).get(Number(req.params.id));
 if(!order) return res.status(404).json({error:'Order not found.'}); res.json({order});
});
app.get('/api/ticket/:code/qr.png',async(req,res)=>{
 const order=db.prepare(`SELECT o.ticket_code,o.status,o.id,e.title,e.event_date,e.venue FROM orders o JOIN events e ON e.id=o.event_id WHERE o.ticket_code=?`).get(String(req.params.code||''));
 if(!order||order.status!=='paid') return res.status(404).send('Ticket not found or payment not confirmed.');
 const payload=JSON.stringify({ticket:order.ticket_code,order:order.id,event:order.title,date:order.event_date,venue:order.venue});
 res.type('png'); QRCode.toFileStream(res,payload,{width:360,margin:2});
});
app.get('/api/ticket/:code',(req,res)=>{
 const order=db.prepare(`SELECT o.id,o.buyer_name,o.buyer_email,o.quantity,o.total_kes,o.status,o.ticket_code,o.mpesa_receipt,o.created_at,e.title,e.event_date,e.venue,e.county FROM orders o JOIN events e ON e.id=o.event_id WHERE o.ticket_code=?`).get(String(req.params.code||''));
 if(!order||order.status!=='paid') return res.status(404).json({error:'Ticket not found or payment not confirmed.'}); res.json({ticket:order});
});

app.get('/api/admin/summary',requireAdmin,(req,res)=>{
 const stats={events:db.prepare('SELECT COUNT(*) n FROM events').get().n,paid_orders:db.prepare("SELECT COUNT(*) n FROM orders WHERE status='paid'").get().n,revenue_kes:db.prepare("SELECT COALESCE(SUM(total_kes),0) n FROM orders WHERE status='paid'").get().n,commission_kes:db.prepare("SELECT COALESCE(SUM(commission_kes),0) n FROM orders WHERE status='paid'").get().n,pending_organizers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='organizer' AND status='pending'").get().n};
 const organizers=db.prepare("SELECT id,name,email,status,created_at FROM users WHERE role='organizer' ORDER BY created_at DESC").all();
 const events=db.prepare(`SELECT e.*,u.name organizer_name,COALESCE((SELECT SUM(quantity) FROM orders o WHERE o.event_id=e.id AND o.status='paid'),0) sold FROM events e JOIN users u ON u.id=e.organizer_id ORDER BY e.created_at DESC`).all();
 const orders=db.prepare(`SELECT o.id,o.buyer_name,o.buyer_email,o.phone,o.quantity,o.total_kes,o.commission_kes,o.status,o.mpesa_receipt,o.ticket_code,o.created_at,e.title event_title FROM orders o JOIN events e ON e.id=o.event_id ORDER BY o.created_at DESC LIMIT 100`).all();
 res.json({stats,organizers,events:events.map(safeEvent),orders,commission_percent:Number(setting('commission_percent')||5)});
});
app.post('/api/admin/organizers/:id/approve',requireAdmin,(req,res)=>{const result=db.prepare("UPDATE users SET status='approved' WHERE id=? AND role='organizer'").run(Number(req.params.id)); if(!result.changes)return res.status(404).json({error:'Organizer not found.'});res.json({ok:true});});
app.post('/api/admin/organizers/:id/reject',requireAdmin,(req,res)=>{const result=db.prepare("UPDATE users SET status='rejected' WHERE id=? AND role='organizer'").run(Number(req.params.id)); if(!result.changes)return res.status(404).json({error:'Organizer not found.'});res.json({ok:true});});
app.post('/api/admin/commission',requireAdmin,(req,res)=>{const n=Number(req.body.percent);if(!Number.isFinite(n)||n<0||n>30)return res.status(400).json({error:'Commission must be between 0% and 30%.'});db.prepare("INSERT INTO settings(key,value) VALUES('commission_percent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));res.json({ok:true,commission_percent:n});});
app.get('/api/admin/export.csv',requireAdmin,(req,res)=>{
 const rows=db.prepare(`SELECT o.id,o.buyer_name,o.buyer_email,o.phone,o.quantity,o.total_kes,o.commission_kes,o.status,o.mpesa_receipt,o.ticket_code,o.created_at,e.title event_title FROM orders o JOIN events e ON e.id=o.event_id ORDER BY o.created_at DESC`).all();
 const fields=['id','buyer_name','buyer_email','phone','quantity','total_kes','commission_kes','status','mpesa_receipt','ticket_code','created_at','event_title'];
 const csv=[fields.join(','),...rows.map(r=>fields.map(k=>'"'+String(r[k]??'').replace(/"/g,'""')+'"').join(','))].join('\r\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="tiketi-orders.csv"');res.send(csv);
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
ensureAdmin().then(()=>app.listen(PORT,()=>console.log(`Astrokeed Tiketi Kenya listening on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
