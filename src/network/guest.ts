/** Public CA + byte transport only. Policies, destination maps and secrets stay on the host. */
export const GUEST_NETWORK = String.raw`
const SBOX_NETWORK_AGENT_V1 = true;
const fs=require('node:fs'),net=require('node:net'),dgram=require('node:dgram');
const agentPath='/run/sbox/network/agent.pid';
fs.mkdirSync('/run/sbox/network',{recursive:true,mode:0o755});
try{const previous=Number(fs.readFileSync(agentPath,'utf8'));if(Number.isSafeInteger(previous)&&previous>1&&previous!==process.pid&&fs.readFileSync('/proc/'+previous+'/cmdline','utf8').includes('const SBOX_NETWORK_AGENT_V1 = true;')){process.kill(previous,'SIGTERM');for(let n=0;n<40&&fs.existsSync('/proc/'+previous);n++)await Bun.sleep(25);if(fs.existsSync('/proc/'+previous))process.kill(previous,'SIGKILL')}}catch{}
fs.writeFileSync(agentPath,String(process.pid),{mode:0o600});
let pending='',configured=false,next=0,queued=0,writing=false,closing=false,tunnel;
const sockets=new Map(),associations=new Map(),queries=new Map(),servers=[],output=[];
const emit=frame=>{if(closing)return;const line=JSON.stringify(frame)+'\n';queued+=line.length;if(queued>8*1024*1024){close();return}output.push(line);if(!writing){writing=true;drain()}};
async function drain(){try{while(output.length){const line=output.shift();await new Promise((resolve,reject)=>process.stdout.write(line,error=>error?reject(error):resolve()));queued-=line.length}}catch{close()}finally{writing=false}}
function sendChunk(id,socket){const data=socket.sboxPending;if(!data||socket.sboxOffset>=data.length){socket.sboxPending=undefined;socket.resume();return}const chunk=data.subarray(socket.sboxOffset,socket.sboxOffset+32768);socket.sboxOffset+=chunk.length;emit({type:'data',id,data:chunk.toString('base64')})}
function tracked(socket,id){sockets.set(id,socket);socket.pause();socket.setTimeout(120000,()=>socket.destroy());socket.on('data',data=>{socket.pause();if(data.length>2*1024*1024){socket.destroy();return}socket.sboxPending=data;socket.sboxOffset=0;sendChunk(id,socket)});socket.on('end',()=>emit({type:'end',id}));socket.on('error',()=>{});socket.on('close',()=>{sockets.delete(id);emit({type:'close',id})})}
function close(){if(closing)return;closing=true;for(const socket of sockets.values())socket.destroy();for(const entry of associations.values())entry.socket.close();for(const entry of queries.values())clearTimeout(entry.timer);for(const server of servers)try{server.close()}catch{};try{tunnel?.stdin.end()}catch{};try{if(fs.readFileSync(agentPath,'utf8')===String(process.pid))fs.unlinkSync(agentPath)}catch{};setTimeout(()=>process.exit(0),250);}
const listen=(server,port,host)=>new Promise((resolve,reject)=>{servers.push(server);server.once('error',reject);server.listen({port,host},()=>{server.off('error',reject);resolve()});server.on('error',close)});
function query(data,respond){if(queries.size>=128||data.length>4096)return;const id=String(++next);const timer=setTimeout(()=>queries.delete(id),5000);queries.set(id,{respond,timer});emit({type:'dns',id,data:Buffer.from(data).toString('base64')})}
function socks(socket){
  if(sockets.size+associations.size>=128){socket.destroy();return}let stage=0,buffer=Buffer.alloc(0);socket.setTimeout(15000,()=>socket.destroy());socket.on('error',()=>{});
  const parse=data=>{
    buffer=Buffer.concat([buffer,data]);if(buffer.length>131072){socket.destroy();return}
    if(stage===0){if(buffer.length<2)return;const count=buffer[1];if(buffer.length<2+count)return;if(buffer[0]!==5||!buffer.subarray(2,2+count).includes(0)){socket.end(Buffer.from([5,255]));return}socket.write(Buffer.from([5,0]));buffer=buffer.subarray(2+count);stage=1;}
    if(stage!==1||buffer.length<4)return;
    let host,offset;if(buffer[3]===1){if(buffer.length<10)return;host=[...buffer.subarray(4,8)].join('.');offset=8}else if(buffer[3]===3){if(buffer.length<5||buffer.length<7+buffer[4])return;offset=5+buffer[4];host=buffer.subarray(5,offset).toString('ascii')}else if(buffer[3]===4){if(buffer.length<22)return;host=Array.from({length:8},(_,i)=>buffer.readUInt16BE(4+i*2).toString(16)).join(':');offset=20}else{socket.destroy();return}
    if(buffer[0]!==5||buffer[2]!==0){socket.destroy();return}const cmd=buffer[1],port=buffer.readUInt16BE(offset),rest=buffer.subarray(offset+2);const id=String(++next);stage=2;socket.off('data',parse);socket.pause();
    if(cmd===1&&port){tracked(socket,id);socket.sboxHandshake=true;socket.sboxRemainder=rest;emit({type:'open',protocol:'tcp',id,host,port})}
    else if(cmd===3){
      socket.setTimeout(120000);const udp=dgram.createSocket('udp4');const entry={socket:udp,peer:undefined};associations.set(id,entry);udp.on('error',()=>socket.destroy());udp.on('message',(bytes,peer)=>{if(bytes.length>65507||peer.address!=='127.0.0.1')return;if(entry.peer&&entry.peer.port!==peer.port)return;socket.setTimeout(120000);entry.peer=peer;emit({type:'udp',id,data:bytes.toString('base64')})});
      udp.bind(0,'127.0.0.1',()=>{const reply=Buffer.from([5,0,0,1,127,0,0,1,0,0]);reply.writeUInt16BE(udp.address().port,8);socket.write(reply);socket.resume()});
      socket.on('close',()=>{associations.delete(id);udp.close();emit({type:'udp-close',id})});socket.on('data',()=>{});
    }else socket.end(Buffer.from([5,7,0,1,0,0,0,0,0,0]));
  };socket.on('data',parse);
}
async function configure(frame){
  fs.mkdirSync('/etc/sbox',{recursive:true,mode:0o755});fs.writeFileSync('/etc/sbox/network-ca.pem',frame.cert,{mode:0o644});let system='';try{system=fs.readFileSync('/etc/ssl/certs/ca-certificates.crt','utf8')}catch{}fs.writeFileSync('/etc/sbox/network-ca-bundle.pem',system+'\n'+frame.cert,{mode:0o644});
  fs.mkdirSync('/usr/local/share/ca-certificates',{recursive:true,mode:0o755});fs.writeFileSync('/usr/local/share/ca-certificates/sbox-network.crt',frame.cert,{mode:0o644});
  try{Bun.spawnSync(['update-ca-certificates'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',env:{PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}})}catch{}
  await listen(net.createServer(socket=>{if(sockets.size>=128){socket.destroy();return}const id=String(++next);tracked(socket,id);emit({type:'open',protocol:'http',id})}),18081,'127.0.0.1');
  await listen(net.createServer(socks),18082,'127.0.0.1');
  const dns=dgram.createSocket('udp4');servers.push(dns);dns.on('error',close);dns.on('message',(bytes,peer)=>query(bytes,reply=>dns.send(reply,peer.port,peer.address)));await new Promise((resolve,reject)=>{dns.once('error',reject);dns.bind(53,'127.0.0.53',resolve)});
  await listen(net.createServer(socket=>{let buffer=Buffer.alloc(0);socket.on('error',()=>{});socket.setTimeout(10000,()=>socket.destroy());socket.on('data',data=>{buffer=Buffer.concat([buffer,data]);if(buffer.length>8192){socket.destroy();return}while(buffer.length>=2){const size=buffer.readUInt16BE();if(size>4096){socket.destroy();return}if(buffer.length<2+size)return;const packet=buffer.subarray(2,2+size);buffer=buffer.subarray(2+size);query(packet,reply=>{if(socket.destroyed)return;const prefix=Buffer.alloc(2);prefix.writeUInt16BE(reply.length);socket.write(Buffer.concat([prefix,reply]))})}})}),53,'127.0.0.53');
  if(frame.transparent){
    tunnel=Bun.spawn(['bun','/run/sbox-network/transparent.js'],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}});
    void (async()=>{for await(const _ of tunnel.stderr){}})();void tunnel.exited.then(()=>close());
    const reader=tunnel.stdout.getReader();let state='';while(!state.includes('\n')){const part=await reader.read();if(part.done)throw new Error('Tunnel closed before ready');state+=Buffer.from(part.value).toString();if(state.length>8192)throw new Error('Invalid tunnel ready frame')};if(!JSON.parse(state.split('\n')[0]).ready)throw new Error('Tunnel failed');void(async()=>{while(!(await reader.read()).done){}})();
  }
  emit({type:'ready'});
}
function receive(frame){
  if(!configured){if(frame.type!=='configure'||typeof frame.cert!=='string'||frame.cert.length>65536)throw new Error('Invalid network setup');configured=true;void configure(frame).catch(()=>{emit({type:'error'});setTimeout(close,20)});return}
  if(frame.type==='shutdown'){close();return}
  if(frame.type==='dns'){const entry=queries.get(frame.id);if(entry){queries.delete(frame.id);clearTimeout(entry.timer);entry.respond(Buffer.from(frame.data,'base64'))}return}
  if(frame.type==='udp'){const entry=associations.get(frame.id);if(entry?.peer)entry.socket.send(Buffer.from(frame.data,'base64'),entry.peer.port,entry.peer.address);return}
  const socket=sockets.get(frame.id);if(!socket)return;
  if(frame.type==='opened'){if(socket.sboxHandshake){socket.write(Buffer.from([5,0,0,1,0,0,0,0,0,0]));socket.sboxHandshake=false;if(socket.sboxRemainder?.length){socket.sboxPending=socket.sboxRemainder;socket.sboxOffset=0;socket.sboxRemainder=undefined;sendChunk(frame.id,socket);return}}socket.resume()}
  else if(frame.type==='ack')sendChunk(frame.id,socket);
  else if(frame.type==='data'){const bytes=Buffer.from(frame.data,'base64');if(bytes.length>65536||socket.writableLength>1024*1024)throw new Error('Oversized network frame');socket.write(bytes,()=>emit({type:'ack',id:frame.id}))}
  else if(frame.type==='end')socket.end();else if(frame.type==='close'){if(socket.sboxHandshake)socket.end(Buffer.from([5,2,0,1,0,0,0,0,0,0]));else socket.destroy()}
}
process.stdin.on('data',data=>{try{pending+=data.toString();if(pending.length>256*1024)throw new Error('Oversized network input');let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);receive(JSON.parse(line))}}catch{close()}});
process.stdin.on('end',close);process.stdin.on('error',close);process.on('SIGTERM',close);process.on('SIGINT',close);
`;
