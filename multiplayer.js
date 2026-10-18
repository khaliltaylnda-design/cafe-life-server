// Café Life - Multiplayer Phase 2
const SERVER_URL = "wss://cafe-life-server.onrender.com";
let socket, myId, myName, players = {};
let myPlayerMesh;

function initMultiplayer(name, playerMesh) {
  myName = name || "Guest_" + Math.floor(Math.random()*1000);
  myPlayerMesh = playerMesh;
  socket = new WebSocket(SERVER_URL);

  socket.onopen = () => {
    console.log("Connected to Café Server!");
    socket.send(JSON.stringify({ type: "join", name: myName }));
  };

  socket.onmessage = (e) => {
    const data = JSON.parse(e.data);
    
    if (data.type === "init") {
      myId = data.id;
      data.players.forEach(p => addOtherPlayer(p));
    }
    if (data.type === "player:join") {
      addOtherPlayer(data.player);
      showNotification(data.player.name + " دخل للمقهى ☕");
    }
    if (data.type === "player:move") {
      moveOtherPlayer(data);
    }
    if (data.type === "player:leave") {
      removeOtherPlayer(data.id);
    }
  };

  // ابعث موقعك كل 50ms
  setInterval(() => {
    if (!socket || socket.readyState !== 1 || !myPlayerMesh) return;
    socket.send(JSON.stringify({
      type: "move",
      x: myPlayerMesh.position.x,
      y: myPlayerMesh.position.y,
      z: myPlayerMesh.position.z,
      rot: myPlayerMesh.rotation.y
    }));
  }, 50);
}

function addOtherPlayer(p) {
  if (players[p.id] || p.id === myId) return;
  // هنا تنشئ شخصية للاعب الآخر - استعمل نفس الـ model متاعك
  // مثال بسيط: Box مؤقت
  const el = document.createElement('div');
  el.id = 'player-' + p.id;
  // لو عندك Three.js Scene، زيد Mesh هنا
  console.log("New player:", p.name);
  players[p.id] = p;
}

function moveOtherPlayer(data) {
  if (!players[data.id]) return;
  players[data.id].x = data.x;
  players[data.id].y = data.y;
  players[data.id].z = data.z;
}

function removeOtherPlayer(id) {
  delete players[id];
  const el = document.getElementById('player-' + id);
  if (el) el.remove();
}

function showNotification(text){
  // رسالة صغيرة فوق
  console.log(text);
}
