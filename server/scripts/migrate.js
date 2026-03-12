const db = require('../database/db'); // 💡 路径说明：引用上面的连接配置

console.log('正在检查数据库结构更新...');

try {
    // 检查是否已经有 points 字段
    const tableInfo = db.pragma('table_info(users)');
    const hasPoints = tableInfo.some(col => col.name === 'points');

    if (!hasPoints) {
        console.log('正在升级：为 users 表添加 points 字段...');
        db.prepare('ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0').run();
        console.log('✅ 升级成功！');
    } else {
        console.log('🙌 已经是最新版本，无需升级。');
    }
} catch (err) {
    console.error('❌ 迁移失败:', err);
} finally {
    process.exit(); // 执行完退出脚本
}