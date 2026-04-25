const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const config = require('./config.js');

class ProgressWebSocketServer {
  constructor(server) {
    this.wss = new WebSocket.Server({ server });
    this.clients = new Map(); // 存储用户连接: Map<userId, Set<WebSocket>>
    
    this.wss.on('connection', (ws, req) => {
      // 从 URL 参数获取用户 token
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get('token');
        
        if (!token) {
          ws.close(4001, '缺少认证token');
          return;
        }
        
        // 验证 token
        const user = this.verifyToken(token);
        if (!user) {
          ws.close(4003, '无效token');
          return;
        }
        
        // 存储连接
        const userId = user.userId;
        if (!this.clients.has(userId)) {
          this.clients.set(userId, new Set());
        }
        this.clients.get(userId).add(ws);
        
        console.log(`[WebSocket] 用户 ${user.username} 连接成功`);
        
        // 监听断开连接
        ws.on('close', () => {
          this.handleClientDisconnect(userId, ws);
        });
        
        ws.on('error', (error) => {
          console.error(`[WebSocket] 连接错误:`, error);
          this.handleClientDisconnect(userId, ws);
        });
      } catch (error) {
        console.error('[WebSocket] 连接处理错误:', error);
        ws.close(4000, '连接处理失败');
      }
    });
  }
  
  verifyToken(token) {
    try {
      const user = jwt.verify(token, config.JWT_SECRET);
      return user;
    } catch (error) {
      return null;
    }
  }
  
  handleClientDisconnect(userId, ws) {
    const userClients = this.clients.get(userId);
    if (userClients) {
      userClients.delete(ws);
      if (userClients.size === 0) {
        this.clients.delete(userId);
        console.log(`[WebSocket] 用户ID ${userId} 所有连接已断开`);
      }
    }
  }
  
  // 向特定用户推送进度
  sendProgressToUser(userId, progressData) {
    const userClients = this.clients.get(userId);
    if (userClients) {
      const message = JSON.stringify({
        type: 'progress',
        data: progressData
      });
      
      // 发送给所有该用户的连接
      userClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      });
    }
  }
  
  // 广播消息给所有连接（调试用）
  broadcast(message) {
    this.wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }
}

module.exports = ProgressWebSocketServer;