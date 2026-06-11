const express=require('express');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const app=express();
app.use(express.json({limit:'10mb'}));

const PASS=process.env.APP_PASSWORD||'sklad2026';
const SECRET=process.env.SESSION_SECRET||PASS+'_secret_salt';
const TOKEN=crypto.createHmac('sha256',SECRET).update(PASS).digest('hex');

function getCookie(req,name){
  const c=req.headers.cookie||'';
  const m=c.split(/;\s*/).find(x=>x.startsWith(name+'='));
  return m?decodeURIComponent(m.slice(name.length+1)):null;
}
function authed(req){return getCookie(req,'sklad_auth')===TOKEN;}

const LOGIN_HTML=`<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Вхід — Склад</title>
<style>*{box-sizing:border-box;margin:0;font-family:'Segoe UI',Arial,sans-serif}
body{background:#f4f6f8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.c{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:30px;max-width:360px;width:100%;box-shadow:0 2px 10px rgba(0,0,0,.06)}
h1{font-size:22px;text-align:center;margin-bottom:18px;color:#1e293b}
input{width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:8px;font-size:16px;margin-bottom:12px}
button{width:100%;padding:12px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
.err{color:#dc2626;font-size:14px;text-align:center;margin-bottom:10px;display:none}</style></head>
<body><div class="c"><h1>📦 Складський облік</h1>
<div class="err" id="err">Невірний пароль</div>
<input type="password" id="p" placeholder="Пароль" autofocus>
<button onclick="go()">Увійти</button></div>
<script>
async function go(){
  const r=await fetch('login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
  if(r.ok)location.href='./';
  else document.getElementById('err').style.display='block';
}
document.getElementById('p').addEventListener('keydown',e=>{if(e.key==='Enter')go();});
</script></body></html>`;

app.get('/login',(req,res)=>res.type('html').send(LOGIN_HTML));
app.post('/login',(req,res)=>{
  if((req.body&&req.body.password||'')===PASS){
    res.setHeader('Set-Cookie','sklad_auth='+TOKEN+'; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax');
    res.json({ok:true});
  }else res.status(401).json({ok:false});
});
app.get('/logout',(req,res)=>{res.setHeader('Set-Cookie','sklad_auth=; Path=/; Max-Age=0');res.redirect('login');});

app.use((req,res,next)=>{
  if(authed(req))return next();
  if(req.path.startsWith('/api/'))return res.status(401).json({error:'unauthorized'});
  return res.redirect('login');
});
app.use(express.static(path.join(__dirname,'public')));

/* ---------- сховище: Postgres (Railway) або локальний файл ---------- */
let pool=null;
const DB_URL=process.env.DATABASE_URL;
if(DB_URL){
  const {Pool}=require('pg');
  const noSsl=DB_URL.includes('.railway.internal')||DB_URL.includes('localhost')||DB_URL.includes('127.0.0.1');
  pool=new Pool({connectionString:DB_URL,ssl:noSsl?false:{rejectUnauthorized:false}});
}
const FILE=path.join(process.env.DATA_DIR||__dirname,'data.json');

async function init(){
  if(pool)await pool.query('CREATE TABLE IF NOT EXISTS sklad(key TEXT PRIMARY KEY, rev BIGINT NOT NULL, data JSONB NOT NULL)');
}
async function getStore(key){
  if(pool){
    const r=await pool.query('SELECT rev,data FROM sklad WHERE key=$1',[key]);
    return r.rows[0]?{rev:+r.rows[0].rev,data:r.rows[0].data}:null;
  }
  try{const j=JSON.parse(fs.readFileSync(FILE,'utf8'));return j[key]||null;}catch(e){return null;}
}
async function putStore(key,rev,data){
  if(pool){
    const cur=await getStore(key);
    if(!cur){
      if(+rev!==0)return{conflict:{rev:0,data:null}};
      await pool.query('INSERT INTO sklad(key,rev,data) VALUES($1,1,$2)',[key,data]);
      return{rev:1};
    }
    if(+cur.rev!==+rev)return{conflict:cur};
    const nr=+cur.rev+1;
    await pool.query('UPDATE sklad SET rev=$2,data=$3 WHERE key=$1',[key,nr,data]);
    return{rev:nr};
  }
  let j={};try{j=JSON.parse(fs.readFileSync(FILE,'utf8'));}catch(e){}
  const cur=j[key]||null;
  if(!cur&&+rev!==0)return{conflict:{rev:0,data:null}};
  if(cur&&+cur.rev!==+rev)return{conflict:cur};
  const nr=(cur?+cur.rev:0)+1;
  j[key]={rev:nr,data};
  fs.writeFileSync(FILE,JSON.stringify(j));
  return{rev:nr};
}

const STORES=['geo','volokno'];
app.get('/api/:store',async(req,res)=>{
  try{
    const s=req.params.store;
    if(!STORES.includes(s))return res.status(404).json({error:'unknown store'});
    res.json((await getStore(s))||{rev:0,data:null});
  }catch(e){res.status(500).json({error:e.message});}
});
app.put('/api/:store',async(req,res)=>{
  try{
    const s=req.params.store;
    if(!STORES.includes(s))return res.status(404).json({error:'unknown store'});
    const {rev,data}=req.body||{};
    if(!data||!data.items)return res.status(400).json({error:'bad data'});
    const out=await putStore(s,rev||0,data);
    if(out.conflict)return res.status(409).json(out.conflict);
    res.json({rev:out.rev});
  }catch(e){res.status(500).json({error:e.message});}
});

const PORT=process.env.PORT||3000;
init().then(()=>app.listen(PORT,()=>console.log('Sklad server on :'+PORT)))
.catch(e=>{console.error('DB init failed:',e);process.exit(1);});
