# CyberBot

CyberBot 是一个基于 node-napcat-ts 开发的高性能 QQ 机器人框架，提供了丰富的插件系统和易用的 API 接口。

```
  .oooooo.                .o8                          oooooooooo.                .   
 d8P'  `Y8b              "888                          `888'   `Y8b             .o8   
888          oooo    ooo  888oooo.   .ooooo.  oooo d8b  888     888  .ooooo.  .o888oo 
888           `88.  .8'   d88' `88b d88' `88b `888""8P  888oooo888' d88' `88b   888   
888            `88..8'    888   888 888ooo888  888      888    `88b 888   888   888   
`88b    ooo     `888'     888   888 888    .o  888      888    .88P 888   888   888 . 
 `Y8bood8P'      .8'      `Y8bod8P' `Y8bod8P' d888b    o888bood8P'  `Y8bod8P'   "888" 
             .o..P'                                                                   
             `Y8P'                                                                    
```

## 特性

- 🚀 基于 TypeScript，提供完整的类型支持
- 🔌 强大的插件系统，支持热插拔
- 🎯 事件驱动架构，高性能且易于扩展
- 📝 详细的日志系统
- 🔒 支持主人和管理员权限管理
- ⏰ 内置 cron 定时任务支持
- 🛠 丰富的 API 工具集

## 安装

1. 确保你的系统已安装 Node.js (推荐 v16 或更高版本)

2. 下载项目并安装依赖：

```bash
npx cyberbot-core
```

根据交互步骤进行即可

3. 检查配置文件 `config.toml`：

```toml
[napcat]
baseUrl = "NapcatQQ WebSocket地址"
accessToken = "你在napcat设置的token"
throwPromise = false

    [napcat.reconnection]
    enable = true
    attempts = 5
    delay = 5000
    debug = false

[self]
master = [123456789] # 主人QQ号
admins = [] # 管理员QQ号列表

[plugins]
system = ['cmds'] # 系统插件列表
user = ['demo'] # 用户插件列表

[logger]
level = "info" # 日志级别
maxSize = "10m" # 日志文件最大大小
maxDays = 7 # 日志文件保存最大天数
```

## 使用方法

### 启动机器人

```bash
npm start
```

### 插件仓库 (下载插件)

`https://github.com/RicardaY/cyberbot-plugin.git`

### 插件开发

1. 在 `plugins` 目录下创建新的插件目录
2. 创建 `index.ts` 文件，使用以下模板：

```typescript
import { definePlugin, CyberPluginContext } from 'cyberbot-core';

export default definePlugin({
    name: '插件名称',
    version: '1.0.0',
    description: '插件描述',
    setup(ctx: CyberPluginContext) {
        // 注册消息处理器
        ctx.handle('message', async (e) => {
            if (e.raw_message === '你好') {
                await e.reply('世界，你好！');
            }
        });
        
        // 注册定时任务
        ctx.cron('0 * * * *', () => {
            console.log('每小时执行一次');
        });
    }
});
```

### 可用的上下文 API

- `ctx.sendPrivateMessage()`: 发送私聊消息
- `ctx.sendGroupMessage()`: 发送群消息
- `ctx.handle()`: 注册事件处理器
- `ctx.cron()`: 注册定时任务
- `ctx.isMaster()`: 检查是否为主人
- `ctx.isAdmin()`: 检查是否为管理员
- 更多 API 请参考源码文档

## 插件管理

- 启用插件：`ctx.plugin.onPlugin('插件名')`
- 禁用插件：`ctx.plugin.offPlugin('插件名')`
- 重载插件：`ctx.plugin.reloadPlugin('插件名')`
- 获取插件列表：`ctx.plugin.getPlugins()`

## 日志系统

日志文件保存在 `log` 目录下，按日期自动分割。

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License

## 致谢

- [node-napcat-ts](https://github.com/napcat-js/node-napcat-ts)
- [kivibot@viki](https://github.com/vikiboss/kivibot)
- [Abot@takayama](https://github.com/takayama-lily/abot)

## 作者

@星火 
