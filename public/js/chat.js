/* ===== STATE ===== */
let socket, roomId, username, password, myRole='member';
let replyTo=null, editingId=null, currentChannel='Ø¹Ø§Ù';
let mediaRecorder=null, audioChunks=[], recInterval=null, recSeconds=0;
let typingTimeout=null, decryptedCache={};
let dmPeer=null, dmMessages=[];
let channels=['Ø¹Ø§Ù'];
let memberAvatars={}, memberStatuses={};
let originalTitle=document.title;

/* ===== STICKERS ===== */
const STICKERS=[
  'ð','ð','ð¥º','ð','ð¤','ð','ð¥³','ð¡','ð»','ð','ð¥','âï¸','ð','â­','ð','ð®',
  'ðµ','ð¸','ð','â½','ð','ð','â','ð°','ð±','ð¶','ð¦','ð¸','ð¸','ðº','ð','ð',
  'ð','âï¸','ð ','ð¡','ð±','ð»','ð·','ð¬','â¤ï¸','ð','ðª','ð','ð¤','âï¸','ð','ð'
];

/* ===== NOTIFICATION ===== */
let tabFocused=true, unreadCount=0;
window.addEventListener('focus',()=>{ tabFocused=true; unreadCount=0; document.title=originalTitle; });
window.addEventListener('blur',()=>{ tabFocused=false; });

function playNotif(){
  try{const c=new AudioContext(),o=c.createOscillator(),g=c.createGain();
  o.connect(g);g.connect(c.destination);o.frequency.value=880;g.gain.value=0.15;
  o.start();o.stop(c.currentTime+0.15);}catch(e){}
}
function notifyNewMessage(sender,text){
  if(tabFocused) return;
  unreadCount++;
  document.title=`(${unreadCount}) Ø±Ø³Ø§ÙØ© Ø¬Ø¯ÙØ¯Ø© â ${originalTitle}`;
  playNotif();
  if('Notification' in window && Notification.permission==='granted'){
    new Notification(sender,{body:text||'Ø±Ø³Ø§ÙØ© Ø¬Ø¯ÙØ¯Ø©',icon:'ð'});
  }
}
if('Notification' in window && Notification.permission==='default'){
  Notification.requestPermission();
}

/* ===== AUTO DARK MODE ===== */
function checkAutoDark(){
  const mode=localStorage.getItem('autoDark_'+roomId);
  if(mode!=='on') return;
  const h=new Date().getHours();
  if(h>=18||h<6) document.documentElement.setAttribute('data-theme','dark');
  else document.documentElement.setAttribute('data-theme','light');
}
setInterval(()=>{ if(roomId) checkAutoDark(); },60000);

/* ===== AUTH ===== */
function switchTab(t){
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
  document.querySelector(`.tab:nth-child(${t==='create'?1:2})`).classList.add('active');
  document.getElementById('tab-'+t).classList.add('active');
}
async function createRoom(){
  const name=document.getElementById('create-name').value.trim();
  const user=document.getElementById('create-username').value.trim();
  const pass=document.getElementById('create-password').value;
  if(!name||!user) return showError('Ø£Ø¯Ø®Ù Ø§ÙØ§Ø³Ù ÙØ§Ø³Ù Ø§ÙÙØ³ØªØ®Ø¯Ù');
  try{
    const r=await fetch('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,username:user,password:pass||undefined})});
    const d=await r.json();
    if(!r.ok) return showError(d.error);
    enterRoom(d.roomId,d.inviteCode,user,pass);
  }catch(e){showError('Ø®Ø·Ø£ ÙÙ Ø§ÙØ§ØªØµØ§Ù');}
}
async function joinRoom(){
  const code=document.getElementById('join-code').value.trim();
  const user=document.getElementById('join-username').value.trim();
  const pass=document.getElementById('join-password').value;
  if(!code||!user) return showError('Ø£Ø¯Ø®Ù Ø§ÙÙÙØ¯ ÙØ§Ø³Ù Ø§ÙÙØ³ØªØ®Ø¯Ù');
  try{
    const r=await fetch('/api/rooms/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({inviteCode:code,username:user,password:pass||undefined})});
    const d=await r.json();
    if(!r.ok){
      if(d.requirePassword){document.getElementById('join-password').style.display='block';return showError('Ø§ÙØºØ±ÙØ© ÙØ­ÙÙØ© Ø¨ÙÙÙØ© Ø³Ø±');}
      return showError(d.error);
    }
    enterRoom(d.roomId,code,user,pass);
  }catch(e){showError('Ø®Ø·Ø£ ÙÙ Ø§ÙØ§ØªØµØ§Ù');}
}
function showError(m){document.getElementById('auth-error').textContent=m;}

/* ===== ENTER ROOM ===== */
function enterRoom(id,invite,user,pass){
  roomId=id; username=user; password=pass||'';
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('chat-screen').classList.add('active');
  document.getElementById('room-name').textContent='';
  originalTitle='ÙØ­Ø§Ø¯Ø«Ø© Ø®Ø§ØµØ© ÙØ´ÙØ±Ø©';
  /* restore settings */
  const savedAccent=localStorage.getItem('accent_'+roomId);
  if(savedAccent){document.documentElement.style.setProperty('--accent',savedAccent);document.documentElement.style.setProperty('--msg-own',savedAccent);}
  const savedTheme=localStorage.getItem('theme_'+roomId);
  if(savedTheme) document.documentElement.setAttribute('data-theme',savedTheme);
  const savedBg=localStorage.getItem('chatBg_'+roomId);
  if(savedBg){document.documentElement.style.setProperty('--chat-bg',`url(${savedBg})`);document.getElementById('bg-blur-row').style.display='flex';document.getElementById('bg-remove-row').style.display='flex';}
  const savedBlur=localStorage.getItem('chatBlur_'+roomId);
  if(savedBlur){document.documentElement.style.setProperty('--bg-blur',savedBlur+'px');document.getElementById('bg-blur').value=savedBlur;document.getElementById('blur-val').textContent=savedBlur;}
  const savedFont=localStorage.getItem('fontSize_'+roomId)||'14';
  document.documentElement.style.setProperty('--font-size',savedFont+'px');
  document.getElementById('font-size-slider').value=savedFont;
  document.getElementById('font-size-val').textContent=savedFont;
  const savedBubble=localStorage.getItem('bubbleStyle_'+roomId)||'default';
  document.documentElement.setAttribute('data-bubble',savedBubble);
  document.getElementById('bubble-style-select').value=savedBubble;
  const savedAutoDark=localStorage.getItem('autoDark_'+roomId)||'off';
  document.getElementById('auto-dark-select').value=savedAutoDark;
  checkAutoDark();
  connectSocket(invite);
}

/* ===== SOCKET ===== */
function connectSocket(invite){
  socket=io();
  socket.emit('join-room',{roomId,username,inviteCode:invite,password:password||undefined});

  socket.on('room-info',d=>{
    document.getElementById('room-name').textContent=d.name;
    originalTitle=d.name+' â ÙØ­Ø§Ø¯Ø«Ø© Ø®Ø§ØµØ©';
    document.title=originalTitle;
    myRole=d.role;
    if(d.disappearingMinutes) document.getElementById('disappearing-select').value=d.disappearingMinutes;
    document.getElementById('lock-btn').textContent=d.locked?'ÙØªØ­':'ÙÙÙ';
    document.getElementById('invite-code-display').textContent=invite||'';
    if(d.channels&&d.channels.length) channels=d.channels; else channels=['Ø¹Ø§Ù'];
    renderChannels();
  });

  socket.on('messages',async msgs=>{
    const container=document.getElementById('messages');
    container.innerHTML='';
    for(const m of msgs){ await appendMessage(m); }
    scrollBottom();
  });

  socket.on('new-message',async m=>{
    if(m.channel&&m.channel!==currentChannel) return;
    await appendMessage(m);
    scrollBottom();
    if(m.username!==username) notifyNewMessage(m.username,decryptedCache[m.id]||'');
    socket.emit('read-message',{roomId,messageId:m.id});
  });

  socket.on('message-deleted',d=>{
    const el=document.getElementById('msg-'+d.messageId);
    if(el){const body=el.querySelector('.msg-body');if(body){body.innerHTML='<span class="deleted-msg">ð« ØªÙ Ø­Ø°Ù ÙØ°Ù Ø§ÙØ±Ø³Ø§ÙØ©</span>';const acts=el.querySelector('.msg-actions');if(acts)acts.remove();}}
  });

  socket.on('message-edited',async d=>{
    const el=document.getElementById('msg-'+d.messageId);
    if(!el) return;
    const body=el.querySelector('.msg-body');
    if(!body) return;
    const txt=await decryptText(d.encrypted_content,d.iv);
    decryptedCache[d.messageId]=txt;
    body.innerHTML=renderMsgContent(txt,d.message_type);
    let ed=el.querySelector('.msg-edited');
    if(!ed){ed=document.createElement('span');ed.className='msg-edited';body.after(ed);}
    ed.textContent=' (ÙØ¹Ø¯ÙÙØ©)';
  });

  socket.on('reaction-updated',d=>{
    const el=document.getElementById('msg-'+d.messageId);
    if(!el) return;
    let rc=el.querySelector('.msg-reactions');
    if(!rc){rc=document.createElement('div');rc.className='msg-reactions';el.appendChild(rc);}
    rc.innerHTML='';
    if(d.reactions){
      const parsed=typeof d.reactions==='string'?JSON.parse(d.reactions):d.reactions;
      for(const[emoji,users] of Object.entries(parsed)){
        if(!users.length) continue;
        const b=document.createElement('span');
        b.className='reaction-badge'+(users.includes(username)?' own':'');
        b.textContent=emoji+' '+users.length;
        b.onclick=()=>socket.emit('react-message',{roomId,messageId:d.messageId,emoji});
        rc.appendChild(b);
      }
    }
  });

  socket.on('user-typing',d=>{
    if(d.username===username) return;
    document.getElementById('typing-indicator').textContent=d.username+' ÙÙØªØ¨...';
    clearTimeout(window._typClear);
    window._typClear=setTimeout(()=>{document.getElementById('typing-indicator').textContent='';},2500);
  });

  socket.on('message-read',d=>{
    updateReadUI(d.messageId,d.readBy);
  });

  socket.on('online-users',d=>{
    document.getElementById('online-count').textContent=d.count+' ÙØªØµÙ';
  });

  socket.on('poll-created',d=>{ appendPollMessage(d); scrollBottom(); });

  socket.on('poll-updated',d=>{
    const el=document.getElementById('poll-'+d.pollId);
    if(el) renderPollInPlace(el,d);
  });

  socket.on('pinned-updated',()=>{});

  socket.on('members-update',d=>{
    if(d.members) window._membersCache=d.members;
    d.members.forEach(m=>{
      if(m.avatar_emoji) memberAvatars[m.username]=m.avatar_emoji;
      if(m.status) memberStatuses[m.username]=m.status;
    });
  });

  socket.on('avatar-updated',d=>{ memberAvatars[d.username]=d.avatar; });
  socket.on('status-updated',d=>{ memberStatuses[d.username]=d.status; });

  socket.on('channel-created',d=>{
    if(!channels.includes(d.name)) channels.push(d.name);
    renderChannels();
  });
  socket.on('channel-deleted',d=>{
    channels=channels.filter(c=>c!==d.name);
    if(currentChannel===d.name){ currentChannel='Ø¹Ø§Ù'; switchChannel('Ø¹Ø§Ù'); }
    renderChannels();
  });

  socket.on('dm-message',d=>{
    if(dmPeer&&(d.sender===dmPeer||d.receiver===dmPeer)){
      appendDmMsg(d);
    }
  });
  socket.on('dm-read',d=>{});

  socket.on('scheduled-sent',d=>{ loadScheduled(); });
  socket.on('error',d=>{ alert(d.message); });
}

/* ===== CHANNELS ===== */
function renderChannels(){
  const ct=document.getElementById('channel-tabs');
  ct.innerHTML='';
  channels.forEach(ch=>{
    const tab=document.createElement('div');
    tab.className='channel-tab'+(ch===currentChannel?' active':'');
    tab.innerHTML=ch;
    if(ch!=='Ø¹Ø§Ù'&&(myRole==='admin'||myRole==='moderator')){
      const del=document.createElement('span');del.className='ch-delete';del.textContent='â';
      del.onclick=e=>{e.stopPropagation();deleteChannel(ch);};
      tab.appendChild(del);
    }
    tab.onclick=()=>switchChannel(ch);
    ct.appendChild(tab);
  });
}
function switchChannel(ch){
  currentChannel=ch;
  renderChannels();
  loadMessages();
}
function showCreateChannel(){ document.getElementById('channel-modal').style.display='flex'; }
function createChannel(){
  const name=document.getElementById('channel-name-input').value.trim();
  if(!name) return;
  socket.emit('create-channel',{roomId,name});
  document.getElementById('channel-name-input').value='';
  closeModal('channel-modal');
}
function deleteChannel(name){
  if(!confirm('Ø­Ø°Ù Ø§ÙÙÙØ§Ø© "'+name+'"Ø')) return;
  socket.emit('delete-channel',{roomId,name});
}

/* ===== LOAD MESSAGES ===== */
function loadMessages(){
  document.getElementById('messages').innerHTML='';
  fetch(`/api/rooms/${roomId}/messages?channel=${encodeURIComponent(currentChannel)}&username=${encodeURIComponent(username)}`)
    .then(r=>r.json()).then(async msgs=>{
      for(const m of msgs) await appendMessage(m);
      scrollBottom();
    });
}

/* ===== CRYPTO ===== */
async function encryptText(text){
  const enc=new TextEncoder();
  const keyMaterial=await crypto.subtle.importKey('raw',enc.encode(password||roomId),'PBKDF2',false,['deriveKey']);
  const salt=enc.encode(roomId);
  const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:310000,hash:'SHA-256'},keyMaterial,{name:'AES-GCM',length:256},false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(text));
  return{encrypted:btoa(String.fromCharCode(...new Uint8Array(ct))),iv:btoa(String.fromCharCode(...iv))};
}
async function decryptText(encrypted,iv){
  try{
    if(!encrypted||!iv) return '[Ø±Ø³Ø§ÙØ© ÙØ´ÙØ±Ø©]';
    let cipherB64=encrypted;
    if(cipherB64.startsWith('encrypted:')) cipherB64=cipherB64.slice(10);
    if(cipherB64.startsWith('ciphertext:')) cipherB64=cipherB64.slice(11);
    const enc=new TextEncoder();
    const keyMaterial=await crypto.subtle.importKey('raw',enc.encode(password||roomId),'PBKDF2',false,['deriveKey']);
    const salt=enc.encode(roomId);
    const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:310000,hash:'SHA-256'},keyMaterial,{name:'AES-GCM',length:256},false,['decrypt']);
    const ctBuf=Uint8Array.from(atob(cipherB64),c=>c.charCodeAt(0));
    const ivBuf=Uint8Array.from(atob(iv),c=>c.charCodeAt(0));
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:ivBuf},key,ctBuf);
    return new TextDecoder().decode(plain);
  }catch(e){return '[ÙØ´Ù ÙÙ Ø§ÙØªØ´ÙÙØ±]';}
}

/* ===== RENDER MESSAGE ===== */
function renderMsgContent(text,type){
  if(type==='sticker') return `<span class="sticker-msg">${escHtml(text)}</span>`;
  if(type==='image') return `<img src="${escHtml(text)}" onclick="window.open(this.src)" alt="ØµÙØ±Ø©">`;
  if(type==='video') return `<video src="${escHtml(text)}" controls></video>`;
  if(type==='voice') return `<audio src="${escHtml(text)}" controls></audio>`;
  if(type==='file'){
    try{
      const f=JSON.parse(text);
      return `<a class="file-attachment" href="${escHtml(f.url)}" target="_blank" download="${escHtml(f.name)}">
        <span class="file-icon">${getFileIcon(f.name)}</span>
        <span class="file-info"><span class="file-name">${escHtml(f.name)}</span><span class="file-size">${formatFileSize(f.size)}</span></span>
      </a>`;
    }catch(e){ return escHtml(text); }
  }
  /* text processing */
  let h=escHtml(text);
  /* spoiler */
  h=h.replace(/\|\|(.+?)\|\|/g,'<span class="spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');
  /* bold / italic */
  h=h.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>');
  h=h.replace(/\*(.+?)\*/g,'<i>$1</i>');
  /* links + preview */
  h=h.replace(/(https?:\/\/[^\s<]+)/g,(url)=>{
    return `<a href="${url}" target="_blank" style="color:inherit;text-decoration:underline">${url}</a>` +
      `<a class="link-preview" href="${url}" target="_blank"><span class="link-preview-title">ð Ø±Ø§Ø¨Ø· Ø®Ø§Ø±Ø¬Ù</span><span class="link-preview-url">${url.length>60?url.slice(0,60)+'...':url}</span></a>`;
  });
  h=h.replace(/\n/g,'<br>');
  return h;
}

function getFileIcon(name){
  const ext=(name.split('.').pop()||'').toLowerCase();
  const icons={'pdf':'ð','doc':'ð','docx':'ð','xls':'ð','xlsx':'ð','ppt':'ð½ï¸','pptx':'ð½ï¸','zip':'ð¦','rar':'ð¦','7z':'ð¦','txt':'ð','csv':'ð'};
  return icons[ext]||'ð';
}
function formatFileSize(bytes){
  if(!bytes) return '';
  if(bytes<1024) return bytes+' B';
  if(bytes<1048576) return (bytes/1024).toFixed(1)+' KB';
  return (bytes/1048576).toFixed(1)+' MB';
}

function escHtml(t){
  const d=document.createElement('div');d.textContent=t;return d.innerHTML;
}

function statusDot(s){
  const dots={available:'ð¢',busy:'ð´',dnd:'â',away:'ð¡'};
  return dots[s]||'';
}

async function appendMessage(m){
  const container=document.getElementById('messages');
  /* system messages */
  if(m.message_type==='system'){
    const d=document.createElement('div');d.className='system-msg';d.id='msg-'+m.id;
    let txt=await decryptText(m.encrypted_content,m.iv);
    decryptedCache[m.id]=txt;
    d.textContent=txt;
    container.appendChild(d);
    return;
  }
  /* poll */
  if(m.message_type==='poll'){
    const txt=await decryptText(m.encrypted_content,m.iv);
    decryptedCache[m.id]=txt;
    try{
      const pData=JSON.parse(txt);
      appendPollMessage({...pData,id:m.id,pollId:pData.pollId||m.id,username:m.username,timestamp:m.timestamp});
    }catch(e){}
    return;
  }

  const isOwn=m.username===username;
  const div=document.createElement('div');
  div.className='message '+(isOwn?'own':'other');
  div.id='msg-'+m.id;

  const txt=await decryptText(m.encrypted_content,m.iv);
  decryptedCache[m.id]=txt;

  /* header */
  const hdr=document.createElement('div');hdr.className='msg-header';
  const avatar=memberAvatars[m.username]||'';
  if(avatar) hdr.innerHTML+=`<span class="msg-avatar">${avatar}</span>`;
  const st=memberStatuses[m.username];
  if(st) hdr.innerHTML+=`<span class="msg-status-dot">${statusDot(st)}</span>`;
  if(!isOwn) hdr.innerHTML+=`<span class="msg-sender">${escHtml(m.username)}</span>`;
  const time=new Date(m.timestamp).toLocaleTimeString('ar',{hour:'2-digit',minute:'2-digit'});
  hdr.innerHTML+=`<span class="msg-time">${time}</span>`;
  div.appendChild(hdr);

  /* reply ref */
  if(m.reply_to){
    const ref=document.createElement('div');ref.className='msg-reply-ref';
    ref.textContent=decryptedCache[m.reply_to]?'â© '+decryptedCache[m.reply_to].slice(0,60):'â© Ø±Ø³Ø§ÙØ©';
    ref.onclick=()=>{const t=document.getElementById('msg-'+m.reply_to);if(t){t.scrollIntoView({behavior:'smooth'});t.style.outline='2px solid var(--accent)';setTimeout(()=>t.style.outline='',1500);}};
    div.appendChild(ref);
  }

  /* body */
  const body=document.createElement('div');body.className='msg-body';
  body.innerHTML=renderMsgContent(txt,m.message_type);
  div.appendChild(body);

  /* edited */
  if(m.edited){
    const ed=document.createElement('span');ed.className='msg-edited';ed.textContent=' (ÙØ¹Ø¯ÙÙØ©)';
    div.appendChild(ed);
  }

  /* actions */
  const acts=document.createElement('div');acts.className='msg-actions';
  acts.innerHTML=`
    <button onclick="startReply(${m.id})" title="Ø±Ø¯">â©</button>
    <button onclick="showReactionPicker(event,${m.id})" title="ØªÙØ§Ø¹Ù">ð</button>
    ${isOwn&&m.message_type==='text'?`<button onclick="startEdit(${m.id})" title="ØªØ¹Ø¯ÙÙ">âï¸</button>`:''}
    <button onclick="showDeleteModal(${m.id},${isOwn})" title="Ø­Ø°Ù">ðï¸</button>
    ${myRole==='admin'||myRole==='moderator'?`<button onclick="pinMessage(${m.id})" title="ØªØ«Ø¨ÙØª">ð</button>`:''}
  `;
  div.appendChild(acts);

  /* reactions */
  if(m.reactions){
    const rc=document.createElement('div');rc.className='msg-reactions';
    const parsed=typeof m.reactions==='string'?JSON.parse(m.reactions):m.reactions;
    for(const[emoji,users] of Object.entries(parsed)){
      if(!users.length) continue;
      const b=document.createElement('span');
      b.className='reaction-badge'+(users.includes(username)?' own':'');
      b.textContent=emoji+' '+users.length;
      b.onclick=()=>socket.emit('react-message',{roomId,messageId:m.id,emoji});
      rc.appendChild(b);
    }
    div.appendChild(rc);
  }

  /* read receipts (own messages) */
  if(isOwn){
    const rd=document.createElement('div');rd.className='msg-read';
    const readBy=m.read_by?JSON.parse(m.read_by):[];
    const isRead=readBy.some(u=>u!==username);
    rd.innerHTML=`<span class="read-checks ${isRead?'read':''}">ââ</span>`;
    div.appendChild(rd);
  }

  container.appendChild(div);
}

function updateReadUI(msgId,readBy){
  const el=document.getElementById('msg-'+msgId);
  if(!el) return;
  const rd=el.querySelector('.msg-read');
  if(!rd) return;
  const isRead=(readBy||[]).some(u=>u!==username);
  rd.innerHTML=`<span class="read-checks ${isRead?'read':''}">ââ</span>`;
}

/* ===== SEND MESSAGE ===== */
async function sendMessage(){
  const input=document.getElementById('msg-input');
  const text=input.value.trim();
  if(!text) return;
  const{encrypted,iv}=await encryptText(text);
  socket.emit('send-message',{
    roomId,encrypted_content:'encrypted:'+encrypted,iv,
    message_type:'text',reply_to:replyTo,edit_id:editingId,
    channel:currentChannel
  });
  input.value='';
  input.style.height='auto';
  cancelReply();
}

function handleKeyDown(e){
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}
  /* typing indicator */
  if(!typingTimeout){socket.emit('typing',{roomId});}
  clearTimeout(typingTimeout);
  typingTimeout=setTimeout(()=>{typingTimeout=null;},2000);
}
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px';}

/* ===== REPLY / EDIT ===== */
function startReply(id){
  replyTo=id; editingId=null;
  document.getElementById('reply-bar').style.display='flex';
  document.getElementById('reply-text').textContent='â© Ø§ÙØ±Ø¯ Ø¹ÙÙ: '+(decryptedCache[id]||'').slice(0,60);
  document.getElementById('msg-input').focus();
}
function startEdit(id){
  editingId=id; replyTo=null;
  document.getElementById('reply-bar').style.display='flex';
  document.getElementById('reply-text').textContent='âï¸ ØªØ¹Ø¯ÙÙ Ø§ÙØ±Ø³Ø§ÙØ©';
  document.getElementById('msg-input').value=decryptedCache[id]||'';
  document.getElementById('msg-input').focus();
}
function cancelReply(){
  replyTo=null; editingId=null;
  document.getElementById('reply-bar').style.display='none';
  document.getElementById('reply-text').textContent='';
}

/* ===== DELETE MESSAGE ===== */
let deleteTargetId=null, deleteIsOwn=false;
function showDeleteModal(id,isOwn){
  deleteTargetId=id; deleteIsOwn=isOwn;
  document.getElementById('delete-everyone-btn').style.display=isOwn?'block':'none';
  document.getElementById('delete-modal').style.display='flex';
}
function confirmDelete(type){
  if(!deleteTargetId) return;
  if(type==='me'){
    socket.emit('hide-message',{roomId,messageId:deleteTargetId});
    const el=document.getElementById('msg-'+deleteTargetId);
    if(el) el.remove();
  } else {
    socket.emit('delete-message',{roomId,messageId:deleteTargetId});
  }
  closeModal('delete-modal');
  deleteTargetId=null;
}

/* ===== REACTIONS ===== */
let reactionTargetId=null;
function showReactionPicker(e,id){
  reactionTargetId=id;
  const picker=document.getElementById('reactions-picker');
  picker.style.display='flex';
  picker.style.top=(e.clientY-50)+'px';
  picker.style.left=(e.clientX-100)+'px';
}
function addReaction(emoji){
  if(!reactionTargetId) return;
  socket.emit('react-message',{roomId,messageId:reactionTargetId,emoji});
  document.getElementById('reactions-picker').style.display='none';
  reactionTargetId=null;
}
document.addEventListener('click',e=>{
  if(!e.target.closest('.reactions-picker')&&!e.target.closest('.msg-actions')){
    document.getElementById('reactions-picker').style.display='none';
  }
  if(!e.target.closest('.sticker-picker')&&!e.target.closest('.icon-btn')){
    document.getElementById('sticker-picker').style.display='none';
  }
});

/* ===== STICKERS ===== */
function showStickerPicker(){
  const picker=document.getElementById('sticker-picker');
  if(picker.style.display==='block'){picker.style.display='none';return;}
  const grid=document.getElementById('sticker-grid');
  grid.innerHTML='';
  STICKERS.forEach(s=>{
    const item=document.createElement('span');
    item.className='sticker-item';
    item.textContent=s;
    item.onclick=()=>sendSticker(s);
    grid.appendChild(item);
  });
  picker.style.display='block';
}
async function sendSticker(emoji){
  const{encrypted,iv}=await encryptText(emoji);
  socket.emit('send-message',{roomId,encrypted_content:'encrypted:'+encrypted,iv,message_type:'sticker',channel:currentChannel});
  document.getElementById('sticker-picker').style.display='none';
}

/* ===== SEARCH ===== */
function toggleSearch(){
  const sb=document.getElementById('search-bar');
  if(sb.style.display==='none'){sb.style.display='flex';document.getElementById('search-input').focus();}
  else{sb.style.display='none';document.getElementById('search-input').value='';loadMessages();}
}
function searchMessages(){
  const q=document.getElementById('search-input').value.toLowerCase();
  document.querySelectorAll('.message,.system-msg').forEach(el=>{
    const id=el.id.replace('msg-','');
    const txt=(decryptedCache[id]||'').toLowerCase();
    el.style.display=(!q||txt.includes(q))?'':'none';
  });
}

/* ===== FILE UPLOAD ===== */
async function handleImageUpload(e){
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=async()=>{
    const{encrypted,iv}=await encryptText(reader.result);
    socket.emit('send-message',{roomId,encrypted_content:'encrypted:'+encrypted,iv,message_type:'image',channel:currentChannel});
  };
  reader.readAsDataURL(file);
  e.target.value='';
}
async function handleVideoUpload(e){
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=async()=>{
    const{encrypted,iv}=await encryptText(reader.result);
    socket.emit('send-message',{roomId,encrypted_content:'encrypted:'+encrypted,iv,message_type:'video',channel:currentChannel});
  };
  reader.readAsDataURL(file);
  e.target.value='';
}
async function handleFileUpload(e){
  const file=e.target.files[0]; if(!file) return;
  if(file.size>25*1024*1024){alert('Ø§ÙØ­Ø¯ Ø§ÙØ£ÙØµÙ 25MB');return;}
  const reader=new FileReader();
  reader.onload=async()=>{
    const payload=JSON.stringify({name:file.name,size:file.size,url:reader.result});
    const{encrypted,iv}=await encryptText(payload);
    socket.emit('send-message',{roomId,encrypted_content:'encrypted:'+encrypted,iv,message_type:'file',channel:currentChannel});
  };
  reader.readAsDataURL(file);
  e.target.value='';
}

/* ===== VOICE RECORDING ===== */
function toggleRecording(){
  if(mediaRecorder&&mediaRecorder.state==='recording'){
    mediaRecorder.stop(); return;
  }
  navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
    audioChunks=[];
    mediaRecorder=new MediaRecorder(stream);
    mediaRecorder.ondataavailable=e=>audioChunks.push(e.data);
    mediaRecorder.onstop=async()=>{
      stream.getTracks().forEach(t=>t.stop());
      clearInterval(recInterval);
      document.getElementById('recording-indicator').style.display='none';
      document.getElementById('voice-btn').textContent='ð¤';
      const blob=new Blob(audioChunks,{type:'audio/webm'});
      const reader=new FileReader();
      reader.onload=async()=>{
        const{encrypted,iv}=await encryptText(reader.result);
        socket.emit('send-message',{roomId,encrypted_content:'encrypted:'+encrypted,iv,message_type:'voice',channel:currentChannel});
      };
      reader.readAsDataURL(blob);
    };
    mediaRecorder.start();
    recSeconds=0;
    document.getElementById('recording-indicator').style.display='flex';
    document.getElementById('voice-btn').textContent='â¹ï¸';
    recInterval=setInterval(()=>{
      recSeconds++;
      const m=Math.floor(recSeconds/60), s=recSeconds%60;
      document.getElementById('rec-timer').textContent=m+':'+(s<10?'0':'')+s;
    },1000);
  }).catch(e=>{alert('ÙØ§ ÙÙÙÙ Ø§ÙÙØµÙÙ ÙÙÙÙÙØ±ÙÙÙÙ');});
}
function cancelRecording(){
  if(mediaRecorder&&mediaRecorder.state==='recording'){
    mediaRecorder.ondataavailable=null;
    mediaRecorder.onstop=()=>{};
    mediaRecorder.stop();
    clearInterval(recInterval);
    document.getElementById('recording-indicator').style.display='none';
    document.getElementById('voice-btn').textContent='ð¤';
  }
}

/* ===== POLLS ===== */
function showCreatePoll(){document.getElementById('poll-modal').style.display='flex';}
function addPollOption(){
  const c=document.getElementById('poll-options-container');
  const i=document.createElement('input');i.type='text';i.className='poll-option-input';
  i.placeholder='Ø§ÙØ®ÙØ§Ø± '+(c.children.length+1);
  c.appendChild(i);
}
async function submitPoll(){
  const q=document.getElementById('poll-question').value.trim();
  const opts=[...document.querySelectorAll('.poll-option-input')].map(i=>i.value.trim()).filter(Boolean);
  if(!q||opts.length<2) return alert('Ø£Ø¯Ø®Ù Ø§ÙØ³Ø¤Ø§Ù ÙØ®ÙØ§Ø±ÙÙ Ø¹ÙÙ Ø§ÙØ£ÙÙ');
  const{encrypted:eq,iv:eiv}=await encryptText(q);
  const encOpts=[];
  for(const o of opts){const{encrypted,iv}=await encryptText(o);encOpts.push({encrypted:'encrypted:'+encrypted,iv});}
  socket.emit('create-poll',{roomId,question:{encrypted:'encrypted:'+eq,iv:eiv},options:encOpts,channel:currentChannel});
  document.getElementById('poll-question').value='';
  document.querySelectorAll('.poll-option-input').forEach((i,idx)=>{if(idx>1)i.remove();else i.value='';});
  closeModal('poll-modal');
}
function showPolls(){
  document.getElementById('polls-list-modal').style.display='flex';
  document.getElementById('polls-list').innerHTML='Ø¬Ø§Ø±Ù Ø§ÙØªØ­ÙÙÙ...';
  fetch(`/api/rooms/${roomId}/polls`).then(r=>r.json()).then(async polls=>{
    const list=document.getElementById('polls-list');
    list.innerHTML='';
    if(!polls.length){list.textContent='ÙØ§ ØªÙØ¬Ø¯ Ø§Ø³ØªØ·ÙØ§Ø¹Ø§Øª';return;}
    for(const p of polls){
      const div=document.createElement('div');div.className='poll-container';
      const q=await decryptText(p.encrypted_question,p.question_iv);
      div.innerHTML=`<div class="poll-question">${escHtml(q)}</div>`;
      list.appendChild(div);
    }
  });
}

function appendPollMessage(p){
  const container=document.getElementById('messages');
  const div=document.createElement('div');
  div.className='message other';
  div.id='poll-'+p.pollId;
  renderPollInPlace(div,p);
  container.appendChild(div);
}
async function renderPollInPlace(el,p){
  const q=p.decryptedQuestion||await decryptText(p.question?.encrypted||p.encrypted_question,p.question?.iv||p.question_iv);
  let html=`<div class="poll-container"><div class="poll-question">ð ${escHtml(q)}</div>`;
  const totalVotes=(p.options||[]).reduce((s,o)=>{
    const v=typeof o.votes==='string'?JSON.parse(o.votes||'[]'):o.votes||[];
    return s+v.length;
  },0);
  for(let i=0;i<(p.options||[]).length;i++){
    const o=p.options[i];
    const optText=o.decryptedText||await decryptText(o.encrypted_text||o.encrypted,o.iv||o.option_iv);
    const votes=typeof o.votes==='string'?JSON.parse(o.votes||'[]'):o.votes||[];
    const pct=totalVotes?Math.round(votes.length/totalVotes*100):0;
    html+=`<div class="poll-option" onclick="votePoll('${p.pollId}',${o.id||i})">
      <span>${escHtml(optText)}</span>
      <div class="poll-bar"><div class="poll-bar-fill" style="width:${pct}%"></div></div>
      <span class="poll-votes">${votes.length} (${pct}%)</span>
    </div>`;
  }
  html+='</div>';
  el.innerHTML=html;
}
function votePoll(pollId,optionId){
  socket.emit('vote-poll',{roomId,pollId,optionId});
}

/* ===== SCHEDULE ===== */
function showScheduleDialog(){document.getElementById('schedule-modal').style.display='flex';}
async function submitSchedule(){
  const text=document.getElementById('schedule-text').value.trim();
  const time=document.getElementById('schedule-time').value;
  if(!text||!time) return alert('Ø£Ø¯Ø®Ù Ø§ÙÙØµ ÙØ§ÙÙÙØª');
  const{encrypted,iv}=await encryptText(text);
  socket.emit('schedule-message',{roomId,encrypted_content:'encrypted:'+encrypted,iv,send_at:new Date(time).toISOString(),channel:currentChannel});
  document.getElementById('schedule-text').value='';
  document.getElementById('schedule-time').value='';
  closeModal('schedule-modal');
}
function showScheduled(){
  document.getElementById('scheduled-list-modal').style.display='flex';
  loadScheduled();
}
function loadScheduled(){
  fetch(`/api/rooms/${roomId}/scheduled?username=${encodeURIComponent(username)}`).then(r=>r.json()).then(async list=>{
    const el=document.getElementById('scheduled-list');
    el.innerHTML='';
    if(!list.length){el.textContent='ÙØ§ ØªÙØ¬Ø¯ Ø±Ø³Ø§Ø¦Ù ÙØ¬Ø¯ÙÙØ©';return;}
    for(const s of list){
      const txt=await decryptText(s.encrypted_content,s.iv);
      const div=document.createElement('div');div.className='scheduled-item';
      div.innerHTML=`<div><strong>${escHtml(txt.slice(0,50))}</strong><br><small>${new Date(s.send_at).toLocaleString('ar')}</small></div>`;
      const btn=document.createElement('button');btn.textContent='Ø¥ÙØºØ§Ø¡';
      btn.onclick=()=>{socket.emit('cancel-scheduled',{roomId,messageId:s.id});div.remove();};
      div.appendChild(btn);
      el.appendChild(div);
    }
  });
}

/* ===== SETTINGS ===== */
function showSettings(){document.getElementById('settings-modal').style.display='flex';}
function showInvite(){document.getElementById('invite-modal').style.display='flex';}
function copyInvite(){
  navigator.clipboard.writeText(document.getElementById('invite-code-display').textContent);
}
function toggleLock(){socket.emit('toggle-lock',{roomId});}
function setDisappearing(){
  const val=document.getElementById('disappearing-select').value;
  socket.emit('set-disappearing',{roomId,minutes:parseInt(val)});
}
function toggleTheme(){
  const cur=document.documentElement.getAttribute('data-theme');
  const next=cur==='light'?'dark':'light';
  document.documentElement.setAttribute('data-theme',next);
  localStorage.setItem('theme_'+roomId,next);
}
function setChatBackground(e){
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>{
    document.documentElement.style.setProperty('--chat-bg',`url(${reader.result})`);
    localStorage.setItem('chatBg_'+roomId,reader.result);
    document.getElementById('bg-blur-row').style.display='flex';
    document.getElementById('bg-remove-row').style.display='flex';
  };
  reader.readAsDataURL(file);
}
function updateBlur(v){
  document.documentElement.style.setProperty('--bg-blur',v+'px');
  document.getElementById('blur-val').textContent=v;
  localStorage.setItem('chatBlur_'+roomId,v);
}
function removeChatBackground(){
  document.documentElement.style.setProperty('--chat-bg','none');
  localStorage.removeItem('chatBg_'+roomId);
  localStorage.removeItem('chatBlur_'+roomId);
  document.getElementById('bg-blur-row').style.display='none';
  document.getElementById('bg-remove-row').style.display='none';
  document.documentElement.style.setProperty('--bg-blur','0px');
}
function setAccentColor(c){
  document.documentElement.style.setProperty('--accent',c);
  document.documentElement.style.setProperty('--msg-own',c);
  localStorage.setItem('accent_'+roomId,c);
}
function setAvatar(emoji){
  socket.emit('set-avatar',{roomId,avatar:emoji});
  memberAvatars[username]=emoji;
}
function setMyStatus(s){
  socket.emit('set-status',{roomId,status:s});
  memberStatuses[username]=s;
}
function setFontSize(v){
  document.documentElement.style.setProperty('--font-size',v+'px');
  document.getElementById('font-size-val').textContent=v;
  localStorage.setItem('fontSize_'+roomId,v);
}
function setBubbleStyle(v){
  document.documentElement.setAttribute('data-bubble',v);
  localStorage.setItem('bubbleStyle_'+roomId,v);
}
function setAutoDark(v){
  localStorage.setItem('autoDark_'+roomId,v);
  checkAutoDark();
}

/* ===== MEMBERS ===== */
function showMembers(){
  document.getElementById('members-modal').style.display='flex';
  fetch(`/api/rooms/${roomId}/members`).then(r=>r.json()).then(d=>{
    const ml=document.getElementById('members-list');
    ml.innerHTML='';
    (d.members||[]).forEach(m=>{
      const div=document.createElement('div');div.className='member-item';
      const info=document.createElement('div');info.className='member-info';
      info.innerHTML=`
        <span class="member-avatar">${m.avatar_emoji||'ð¤'}</span>
        <div>
          <span class="member-name">${escHtml(m.username)} ${m.username===username?'(Ø£ÙØª)':''}</span>
          <span class="member-role">${m.role}</span>
          <span class="member-status">${statusDot(m.status||memberStatuses[m.username])} ${m.status||memberStatuses[m.username]||''}</span>
        </div>`;
      div.appendChild(info);
      if(myRole==='admin'&&m.username!==username){
        const acts=document.createElement('div');acts.className='member-actions';
        if(m.role==='member') acts.innerHTML+=`<button onclick="promoteUser('${m.username}','moderator')">ØªØ±ÙÙØ©</button>`;
        if(m.role==='moderator') acts.innerHTML+=`<button onclick="promoteUser('${m.username}','member')">ØªØ®ÙÙØ¶</button>`;
        acts.innerHTML+=`<button style="background:var(--warning)" onclick="kickUser('${m.username}')">Ø·Ø±Ø¯</button>`;
        acts.innerHTML+=`<button style="background:var(--danger)" onclick="banUser('${m.username}')">Ø­Ø¸Ø±</button>`;
        div.appendChild(acts);
      }
      ml.appendChild(div);
    });
    const bl=document.getElementById('banned-list');
    bl.innerHTML='';
    (d.banned||[]).forEach(b=>{
      const div=document.createElement('div');div.className='member-item';
      div.innerHTML=`<span>${escHtml(b.username)}</span>`;
      if(myRole==='admin'){
        const btn=document.createElement('button');btn.textContent='Ø±ÙØ¹ Ø§ÙØ­Ø¸Ø±';btn.style.width='auto';btn.style.padding='4px 10px';btn.style.fontSize='0.78em';
        btn.onclick=()=>socket.emit('unban-user',{roomId,username:b.username});
        div.appendChild(btn);
      }
      bl.appendChild(div);
    });
  });
}
function promoteUser(u,role){socket.emit('change-role',{roomId,targetUsername:u,role});}
function kickUser(u){socket.emit('kick-user',{roomId,targetUsername:u});}
function banUser(u){socket.emit('ban-user',{roomId,targetUsername:u});}

/* ===== DMs ===== */
function showDMs(){
  document.getElementById('dm-modal').style.display='flex';
  document.getElementById('dm-chat').style.display='none';
  document.getElementById('dm-close-btn').style.display='block';
  const list=document.getElementById('dm-user-list');
  list.innerHTML='';
  const members=window._membersCache||[];
  members.filter(m=>m.username!==username).forEach(m=>{
    const div=document.createElement('div');div.className='dm-user-item';
    div.innerHTML=`<span>${m.avatar_emoji||'ð¤'} ${escHtml(m.username)}</span>`;
    div.onclick=()=>openDmChat(m.username);
    list.appendChild(div);
  });
}
function openDmChat(peer){
  dmPeer=peer;
  document.getElementById('dm-user-list').style.display='none';
  document.getElementById('dm-close-btn').style.display='none';
  document.getElementById('dm-chat').style.display='flex';
  document.getElementById('dm-peer-name').textContent=peer;
  loadDmMessages();
}
function closeDmChat(){
  dmPeer=null;
  document.getElementById('dm-chat').style.display='none';
  document.getElementById('dm-user-list').style.display='flex';
  document.getElementById('dm-close-btn').style.display='block';
}
async function loadDmMessages(){
  const el=document.getElementById('dm-messages');
  el.innerHTML='';
  const res=await fetch(`/api/rooms/${roomId}/dms?username=${encodeURIComponent(username)}&peer=${encodeURIComponent(dmPeer)}`);
  const msgs=await res.json();
  for(const m of msgs) await appendDmMsg(m);
  el.scrollTop=el.scrollHeight;
  socket.emit('read-dm',{roomId,peer:dmPeer});
}
async function appendDmMsg(m){
  const el=document.getElementById('dm-messages');
  const div=document.createElement('div');
  div.className='dm-msg '+(m.sender===username?'own':'other');
  const txt=await decryptText(m.encrypted_content,m.iv);
  div.innerHTML=`<div>${escHtml(txt)}</div><div class="dm-time">${new Date(m.timestamp).toLocaleTimeString('ar',{hour:'2-digit',minute:'2-digit'})}</div>`;
  el.appendChild(div);
  el.scrollTop=el.scrollHeight;
}
async function sendDM(){
  const input=document.getElementById('dm-input');
  const text=input.value.trim();
  if(!text||!dmPeer) return;
  const{encrypted,iv}=await encryptText(text);
  socket.emit('send-dm',{roomId,receiver:dmPeer,encrypted_content:'encrypted:'+encrypted,iv});
  input.value='';
}

/* ===== PINNED ===== */
function pinMessage(id){socket.emit('pin-message',{roomId,messageId:id});}
function showPinned(){
  document.getElementById('pinned-modal').style.display='flex';
  fetch(`/api/rooms/${roomId}/pinned`).then(r=>r.json()).then(async pins=>{
    const list=document.getElementById('pinned-messages-list');
    list.innerHTML='';
    if(!pins.length){list.textContent='ÙØ§ ØªÙØ¬Ø¯ Ø±Ø³Ø§Ø¦Ù ÙØ«Ø¨ØªØ©';return;}
    for(const p of pins){
      const txt=await decryptText(p.encrypted_content,p.iv);
      const div=document.createElement('div');div.className='pinned-item';
      div.textContent='ð '+txt.slice(0,80);
      div.onclick=()=>{closeModal('pinned-modal');const t=document.getElementById('msg-'+p.id);if(t)t.scrollIntoView({behavior:'smooth'});};
      list.appendChild(div);
    }
  });
}

/* ===== AUDIT LOG ===== */
function showAuditLog(){
  document.getElementById('audit-modal').style.display='flex';
  fetch(`/api/rooms/${roomId}/audit`).then(r=>r.json()).then(logs=>{
    const list=document.getElementById('audit-list');
    list.innerHTML='';
    if(!logs.length){list.textContent='ÙØ§ ØªÙØ¬Ø¯ Ø£Ø­Ø¯Ø§Ø«';return;}
    logs.forEach(l=>{
      const div=document.createElement('div');div.className='audit-item';
      div.textContent=`${new Date(l.timestamp).toLocaleString('ar')} â ${l.username}: ${l.action} ${l.details||''}`;
      list.appendChild(div);
    });
  });
}

/* ===== HELPERS ===== */
function closeModal(id){document.getElementById(id).style.display='none';}
function scrollBottom(){const c=document.getElementById('messages');c.scrollTop=c.scrollHeight;}
function logout(){location.reload();}
