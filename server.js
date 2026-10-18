const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Café Life Server running'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const players = new Map();
function broadcast(data, excludeId=null){
  const msg=JSON.stringify(data);
  wss.clients.forEach(c=>{
    if(c.readyState===1){
      if(excludeId && c.playerId===excludeId) return;
      c.send(msg);
    }
  });
}
wss.on('connection',(ws)=>{
  const id='p_'+Math.random().toString(36).slice(2,7);
  ws.playerId=id;
  ws.send(JSON.stringify({type:'init',id,players:Array.from(players.values())}));
  ws.on('message',(raw)=>{
    try{
      const data=JSON.parse(raw);
      if(data.type==='join'){
        const p={id,name:data.name||'Guest',x:0,y:0,z:0,rot:0};
        players.set(id,p);
        broadcast({type:'player:join',player:p},id);
      }
      if(data.type==='move'){
        const p=players.get(id);
        if(p){p.x=data.x;p.y=data.y;p.z=data.z;p.rot=data.rot;
        broadcast({type:'player:move',id,x:p.x,y:p.y,z:p.z,rot:p.rot},id);}
      }
    }catch(e){}
  });
  ws.on('close',()=>{
    players.delete(id);
    broadcast({type:'player:leave',id});
  });
});
const PORT=process.env.PORT||10000;
server.listen(PORT,()=>console.log('listening '+PORT));
