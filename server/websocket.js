const WebSocket = require('ws');
const { verifyToken } = require('./middlewares/auth');
const { isBvid } = require('./middlewares/validation');
const tasks = require('./services/taskStore');
class ProgressWebSocketServer {
  constructor(server) {
    this.wss=new WebSocket.Server({server,maxPayload:4096});
    // HTTP listen errors are also emitted by ws; handle both surfaces.
    this.wss.on('error',()=>console.error('[WebSocket] TRANSPORT_ERROR'));
    this.wss.on('connection',(ws,req)=>{
      try {
        const url=new URL(req.url,'http://localhost');
        ws.user=verifyToken(url.searchParams.get('token'));
        ws.bvid=url.searchParams.get('bvid');
        if (ws.bvid && !isBvid(ws.bvid)) { ws.close(4000,'Invalid bvid');return; }
      } catch { ws.close(4001,'Authentication required');return; }
      ws.isAlive=true;
      ws.on('pong',()=>{ws.isAlive=true;});
      ws.on('error',()=>{});
      ws.on('message',data=>{
        try {
          const message=JSON.parse(data.toString());
          if (message.type!=='subscribe'||!isBvid(message.bvid)) throw new Error();
          ws.bvid=message.bvid;
          this.replay(ws);
        } catch { ws.close(4000,'Invalid subscription'); }
      });
      this.replay(ws);
    });
    this.interval=setInterval(()=>{
      for(const ws of this.wss.clients) {
        if(!ws.isAlive) {ws.terminate();continue;}
        if(ws.user?.exp*1000<=Date.now()) {ws.close(4001,'Token expired');continue;}
        ws.isAlive=false;ws.ping();
      }
    },30000);
    this.interval.unref();
    this.wss.on('close',()=>clearInterval(this.interval));
  }
  replay(ws) {
    if(!ws.bvid)return; // Legacy unscoped sockets receive no progress; polling remains available.
    const task=tasks.latest(ws.user.userId,ws.bvid);
    if(task)ws.send(JSON.stringify({type:'progress',data:tasks.publicTask(task)}));
  }
  sendProgressToUser(userId,progress) {
    if(!progress)return;
    const message=JSON.stringify({type:'progress',data:progress});
    for(const ws of this.wss.clients) {
      if(ws.readyState===WebSocket.OPEN&&ws.user?.userId===userId&&ws.bvid===progress.bvid&&ws.user.exp*1000>Date.now())
        ws.send(message,()=>{});
    }
  }
  close() {clearInterval(this.interval);for(const ws of this.wss.clients)ws.terminate();this.wss.close();}
}
module.exports=ProgressWebSocketServer;
