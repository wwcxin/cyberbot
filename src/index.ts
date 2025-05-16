import {NCWebsocket, Structs, type AllHandlers, type Send} from "node-napcat-ts";
import {join} from "path";
import {existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync} from "fs";
import {writeFile} from 'fs/promises';
import axios from "axios";
import {createJiti} from "jiti"
import { createHash } from 'crypto';
// @ts-ignore
import * as cron from "node-cron";
// 导入日志模块

import { logger, Logger } from "./logger.js";

export { Structs, Send, NCWebsocket, AllHandlers, CyberPluginContext, axios as http }

// Config
// 使用单例模式存储配置，避免多次解析
let configCache: Config | null = null;

export function getConfig(): Config {
    // 如果缓存存在，直接返回
    if (configCache) return configCache;
    
    const configPath = join(process.cwd(), "config.json")
    if (!existsSync(configPath)) {
        throw new Error("配置文件未找到。请在项目根目录创建 config.json 文件。")
    }
    
    try {
        // 读取并解析配置文件
        const rawContent = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(rawContent) as Config;
        
        // 验证必要的配置项
        if (!parsed.baseUrl) {
            throw new Error("配置错误: 缺少 baseUrl 字段");
        }
        
        if (!parsed.accessToken) {
            parsed.accessToken = "";
        }
        
        // 缓存配置
        configCache = parsed;
        
        return configCache;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`配置文件解析错误: ${error.message}`);
        }
        throw error;
    }
}

export interface Config {
    baseUrl: string,
    accessToken: string,
    throwPromise: boolean,
    reconnection: {
        enable: boolean,
        attempts: number,
        delay: number,
        debug: boolean
    },
    bot: number,
    master: Array<number>,
    admins: Array<number>,
    plugins: {
        system: Array<string>,
        user: Array<string>
    },
    logger: {
        level: string,
        maxSize: string,
        maxDays: number
    }
}

// Index
const logo = `
  .oooooo.                .o8                          oooooooooo.                .   
 d8P'  \`Y8b              "888                          \`888'   \`Y8b             .o8   
888          oooo    ooo  888oooo.   .ooooo.  oooo d8b  888     888  .ooooo.  .o888oo 
888           \`88.  .8'   d88' \`88b d88' \`88b \`888\"\"8P  888oooo888' d88' \`88b   888   
888            \`88..8'    888   888 888ooo888  888      888    \`88b 888   888   888   
\`88b    ooo     \`888'     888   888 888    .o  888      888    .88P 888   888   888 . 
 \`Y8bood8P'      .8'      \`Y8bod8P' \`Y8bod8P' d888b    o888bood8P'  \`Y8bod8P'   "888" 
             .o..P'                                                                   
             \`Y8P'                                                                  
                                                                                      
CyberBot 一个基于 node-napcat-ts 的 QQ 机器人
参考: kivibot@viki && Abot@takayama
@auther: 星火
`
// 初始化日志系统
export const log:Logger = logger

export class Bot {
    private bot: NCWebsocket;
    private config: Config;
    private pluginManager: PluginManager;
    private plugins: {} | null;
    private lastHeartbeatTime: number = 0;
    private heartbeatTimeout: NodeJS.Timeout | null = null;
    private readonly HEARTBEAT_TIMEOUT = 30000; // 30秒无心跳则判定为断开
    private readonly HEARTBEAT_CHECK_INTERVAL = 10000; // 每10秒检查一次心跳状态
    private errorCount: number = 0;
    private readonly MAX_ERRORS_BEFORE_RECONNECT = 5;
    private readonly ERROR_RESET_INTERVAL = 60000; // 1分钟重置错误计数
    private isShuttingDown: boolean = false; // 添加关闭状态标志
    

    constructor() {
        // 获取配置，如果失败则抛出错误
        try {
            this.config = getConfig();
        } catch (error) {
            log.error(`[-]配置加载失败: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
        
        // 创建websocket连接
        this.bot = new NCWebsocket({
            "baseUrl": this.config.baseUrl,
            "accessToken": this.config.accessToken,
            "throwPromise": this.config.throwPromise,
            "reconnection": {
                "enable": this.config.reconnection?.enable ?? true,
                "attempts": this.config.reconnection?.attempts ?? 10,
                "delay": this.config.reconnection?.delay ?? 5000
            }
        }, this.config.reconnection?.debug ?? false);
        
        this.pluginManager = new PluginManager(this.bot, this.config);
        this.plugins = null;
        
        // 初始化错误处理器
        ErrorHandler.initialize();
        
        // 初始化心跳检查
        this.initHeartbeatCheck();
        
        // 初始化错误计数重置定时器
        setInterval(() => {
            this.errorCount = 0;
        }, this.ERROR_RESET_INTERVAL);

        // 添加进程退出处理
        this.setupProcessHandlers();
    }

    private setupProcessHandlers(): void {
        // 处理 SIGINT (Ctrl+C)
        process.on('SIGINT', async () => {
            if (this.isShuttingDown) {
                log.warn('[*]正在强制退出...');
                process.exit(1);
            }
            
            this.isShuttingDown = true;
            log.info('[*]正在优雅关闭...');
            
            try {
                await this.stop();
                log.info('[*]已安全关闭，正在退出...');
                process.exit(0);
            } catch (error) {
                log.error(`[-]关闭时发生错误: ${error}`);
                process.exit(1);
            }
        });

        // 处理 SIGTERM
        process.on('SIGTERM', async () => {
            if (this.isShuttingDown) {
                process.exit(1);
            }
            
            this.isShuttingDown = true;
            log.info('[*]收到终止信号，正在关闭...');
            
            try {
                await this.stop();
                log.info('[*]已安全关闭，正在退出...');
                process.exit(0);
            } catch (error) {
                log.error(`[-]关闭时发生错误: ${error}`);
                process.exit(1);
            }
        });

        // 处理未捕获的异常
        process.on('uncaughtException', (error) => {
            log.error(`[-]未捕获的异常: ${error}`);
            if (!this.isShuttingDown) {
                this.handleError(error, 'uncaughtException');
            }
        });

        // 处理未处理的 Promise 拒绝
        process.on('unhandledRejection', (reason, promise) => {
            log.error(`[-]未处理的 Promise 拒绝: ${reason}`);
            if (!this.isShuttingDown) {
                this.handleError(reason, 'unhandledRejection');
            }
        });
    }

    private initHeartbeatCheck() {
        // 定期检查心跳状态
        this.heartbeatTimeout = setInterval(() => {
            const now = Date.now();
            if (this.lastHeartbeatTime && (now - this.lastHeartbeatTime > this.HEARTBEAT_TIMEOUT)) {
                log.error("[-]心跳超时，尝试重新连接...");
                this.reconnect();
            }
        }, this.HEARTBEAT_CHECK_INTERVAL);
    }

    private async reconnect() {
        try {
            log.info("[*]开始重新连接...");
            
            // 1. 清理心跳检查
            if (this.heartbeatTimeout) {
                clearInterval(this.heartbeatTimeout);
                this.heartbeatTimeout = null;
            }
            
            // 2. 重置心跳时间
            this.lastHeartbeatTime = 0;
            
            // 3. 确保完全断开现有连接
            try {
                await this.bot.disconnect();
                // 等待连接完全关闭
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (disconnectError) {
                log.warn(`[!]断开旧连接时发生错误: ${disconnectError}`);
            }
            
            // 4. 重新创建连接
            this.bot = new NCWebsocket({
                "baseUrl": this.config.baseUrl,
                "accessToken": this.config.accessToken,
                "reconnection": {
                    "enable": this.config.reconnection?.enable ?? true,
                    "attempts": this.config.reconnection?.attempts ?? 10,
                    "delay": this.config.reconnection?.delay ?? 5000
                }
            }, this.config.reconnection?.debug ?? false);
            
            // 5. 重新注册事件处理器
            this.registerEventHandlers();
            
            // 6. 重新初始化心跳检查
            this.initHeartbeatCheck();
            
            // 7. 重新连接
            await this.bot.connect();
            
            // 8. 重置错误计数
            this.errorCount = 0;
            
            log.info("[+]重新连接成功");
        } catch (error) {
            this.handleError(error, "重新连接");
            // 如果重连失败，继续尝试
            setTimeout(() => this.reconnect(), 5000);
        }
    }

    private handleError(error: any, context: string) {
        this.errorCount++;
        log.error(`[-]${context}错误: ${error}`);
        
        // 如果错误次数过多，尝试重新连接
        if (this.errorCount >= this.MAX_ERRORS_BEFORE_RECONNECT) {
            log.error(`[-]错误次数过多(${this.errorCount})，尝试重新连接...`);
            this.errorCount = 0;
            this.reconnect();
        }
    }

    private registerEventHandlers() {
        // 基础连接事件
        this.bot.on("socket.open", (ctx) => {
            log.info("[*]开始连接: " + this.config.baseUrl);
            this.lastHeartbeatTime = Date.now();
        });

        this.bot.on("socket.error", (ctx) => {
            this.handleError(ctx.error_type, "WebSocket连接");
            this.lastHeartbeatTime = 0;
        });

        this.bot.on("socket.close", (ctx) => {
            this.handleError(`连接关闭，代码: ${ctx.code}`, "WebSocket");
            this.lastHeartbeatTime = 0;
        });

        // 生命周期事件
        this.bot.on("meta_event.lifecycle", (ctx) => {
            try {
                if (ctx.sub_type == "connect") {
                    log.info(`[+]连接成功: ${this.config.baseUrl}`);
                    log.info(logo);
                    this.lastHeartbeatTime = Date.now();
                }
            } catch (error) {
                this.handleError(error, "生命周期事件");
            }
        });

        // 心跳事件
        this.bot.on("meta_event.heartbeat", (ctx) => {
            try {
                this.lastHeartbeatTime = Date.now();
                log.info(`[*]心跳包♥ (${new Date().toLocaleTimeString()})`);
                
                // 定期检查连接状态
                this.bot.get_login_info().catch(error => {
                    this.handleError(error, "心跳检查");
                    this.reconnect();
                });
            } catch (error) {
                this.handleError(error, "心跳事件");
            }
        });

        // 消息事件
        this.bot.on("message", (ctx) => {
            try {
                if (ctx.message_type == "group") {
                    log.info(`[*]群(${ctx.group_id}) ${ctx.sender.nickname}(${ctx.sender.user_id}): ${ctx.raw_message}`);
                } else if (ctx.message_type == "private") {
                    log.info(`[*]私聊(${ctx.sender.user_id}) ${ctx.sender.nickname}: ${ctx.raw_message}`);
                }
            } catch (error) {
                this.handleError(error, "消息处理");
            }
        });

        // API 错误事件
        this.bot.on("api.response.failure", (ctx) => {
            this.handleError(`状态: ${ctx.status}, 消息: ${ctx.message}`, "API调用");
        });
    }

    async start() {
        // 注册事件处理器
        this.registerEventHandlers();
        
        // 初始化插件
        this.plugins = await this.pluginManager.init();
        
        // 连接服务器
        await this.bot.connect();
        
        // 发送上线通知
        this.sendOnlineNotificationToMasters();
    }
    
    /**
     * 向所有主人发送机器人上线通知
     */
    private async sendOnlineNotificationToMasters() {
        // 等待短暂时间确保连接稳定
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        this.config.master.forEach(async (masterId) => {
            try {
                // 获取插件信息，确保plugins是Map类型
                let pluginCount = 0;
                let totalPlugins = 0;
                
                if (this.pluginManager) {
                    const plugins = this.pluginManager.plugins;
                    pluginCount = Array.from(plugins.values()).filter(info => info.setup && info.setup.enable).length;
                    // 从plugins目录获取所有可用插件数量
                    totalPlugins = this.pluginManager.getPluginsFromDir().length;
                }
                
                await this.bot.send_msg({
                    user_id: masterId,
                    message: [
                        Structs.text(`[Bot🤖] 已成功上线！\n` +
                            `📅 ${new Date().toLocaleString()}\n` +
                            `🧩 插件状态: ${pluginCount}/${totalPlugins} 已启用\n` +
                            `💻 系统信息: ${process.platform} ${process.arch}\n` +
                            `🎉 机器人已准备就绪，随时为您服务！`)
                    ]
                });
                log.info(`[+]已向主人 ${masterId} 发送上线通知`);
            } catch (error) {
                log.error(`[-]向主人 ${masterId} 发送上线通知失败: ${error}`);
            }
        });
    }

    // 修改 stop 方法，确保资源正确清理
    async stop() {
        if (this.isShuttingDown) {
            return;
        }
        
        this.isShuttingDown = true;
        log.info('[*]开始停止服务...');

        try {
            // 1. 停止心跳检查
            if (this.heartbeatTimeout) {
                clearInterval(this.heartbeatTimeout);
                this.heartbeatTimeout = null;
            }

            // 2. 停止所有插件
            if (this.pluginManager) {
                const plugins = this.pluginManager.getPlugins();
                for (const [pluginName] of plugins) {
                    try {
                        await this.pluginManager.offPlugin(pluginName);
                    } catch (error) {
                        log.error(`[-]停止插件 ${pluginName} 时发生错误: ${error}`);
                    }
                }
            }

            // 3. 断开连接
            if (this.bot) {
                try {
                    await this.bot.disconnect();
                } catch (error) {
                    log.error(`[-]断开连接时发生错误: ${error}`);
                }
            }

            // 4. 保存错误日志
            try {
                ErrorHandler.saveErrorLogsSynchronously();
            } catch (error) {
                log.error(`[-]保存错误日志时发生错误: ${error}`);
            }

            log.info('[*]服务已完全停止');
        } catch (error) {
            log.error(`[-]停止服务时发生错误: ${error}`);
            throw error;
        }
    }
}


// Plugin
export function definePlugin(plugin: CyberPlugin): CyberPlugin {
    return plugin;
}

interface PluginInfo {
    version: string,
    description: string,
    type: 'system' | 'user',
    setup: {
        enable: boolean,
        listeners: Array<listener>;
        cron: Array<any>;
    },
    lastUsed?: number; // 添加最后使用时间字段
}

interface listener {
    event: keyof AllHandlers,
    fn: any;
}


interface pluginUtil {
    getPlugins: () => Map<string, PluginInfo>;
    onPlugin: (pluginName: string) => string;
    offPlugin: (pluginName: string) => string;
    reloadPlugin: (pluginName: string) => Promise<string>;
    getPluginsFromDir: () => string[];
    loadPlugin: (pluginName: string) => Promise<string>;
}

// 扩展事件类型
export type ExtendedEvent = {
    reply: (content: string | number | any[] | any, quote?: boolean) => Promise<{message_id: number}>;
    kick: (user_id: number, reject_add_request?: boolean) => Promise<void>;
};

// 不重复定义MessageEvent类型
// export type MessageEvent = AllHandlers['message'];

interface CyberPluginContext {
    config: Config;
    /** axios 实例 */
    http: typeof axios;
    bot: NCWebsocket;
    bot_uin: number;
    plugin: pluginUtil;
    /** cron 定时任务 
     * @param cronTasks - 定时任务配置
     * 支持两种格式:
     * 1. 单个任务: cron("* * * * * *", () => {})
     * 2. 多个任务数组: cron([
     *      ['* * * * * *', async (ctx, e) => { e.reply("task1") }],
     *      ['0 * * * * *', async (ctx, e) => { e.reply("task2") }]
     *    ])
     */
    cron: (
        cronTasks: string | Array<[string, (ctx: CyberPluginContext, e: AllHandlers['message'] & ExtendedEvent) => any]>,
        func?: () => any
    ) => any;
    /** 注册事件处理器 */
    handle: <EventName extends keyof AllHandlers>(
        eventName: EventName,
        handler: EventName extends "message" | "message.group" | "message.private"
            ? (e: AllHandlers[EventName] & ExtendedEvent) => any 
            : (e: AllHandlers[EventName] & ExtendedEvent) => any
    ) => any;
    /** 是否为主人 */
    isMaster: (
        id:
            | number
            | {
            sender: {
                user_id: number;
            };
        }
    ) => boolean;
    /** 是否为管理员 */
    isAdmin: (
        id:
            | number
            | {
            sender: {
                user_id: number;
            };
        }
    ) => boolean;
    /**
     * 检查用户是否有权限。
     * 
     * @param user_id - 用户的ID。
     * @returns 如果用户是管理员或主人，则返回 `true`，否则返回 `false`。
     */
    hasRight: (e: any) => boolean;
    /**
     * 发送私聊消息。
     * 
     * @param user_id - 目标ID。
     * @param message - 要发送的消息内容，可以是字符串、数字或消息段数组。
     * @returns - 返回发送消息的结果，包含消息ID。
     * @throws - 如果发送消息失败，抛出错误。
     */
    sendPrivateMessage: (user_id:number, message: string | number | Array<any>,) => Promise<{message_id: number;}>;
    /**
     * 发送消息到指定的群组。
     * 
     * @param group_id - 目标群组的ID。
     * @param message - 要发送的消息内容，可以是字符串、数字或消息段数组。
     * @returns - 返回发送消息的结果，包含消息ID。
     * @throws - 如果发送消息失败，抛出错误。
     */
    sendGroupMessage: (group_id:number, message: string | number | Array<any>,) => Promise<{message_id: number;}>;
    /**
     * 撤回指定的消息。
     * 
     * @param message_id - 要撤回的消息的ID。
     * @throws - 如果撤回消息失败，抛出错误。
     */
    delete_msg: (message_id: number) => Promise<void>;
    /**
     * 将指定用户从群组中踢出。
     * 
     * @param group_id - 群ID。
     * @param user_id - 要踢出的用户的ID。
     * @param reject_add_request - 是否拒绝该用户的加群请求。默认值为 `false`。
     * @throws - 如果踢出用户失败，抛出错误。
     */
    kick: (group_id: number, user_id: number, reject_add_request?: boolean) => Promise<void>;
    /**
     * 将指定用户在群组中禁言。
     * 
     * @param group_id - 群ID。
     * @param user_id - 要禁言的用户的ID。
     * @param duration - 禁言时长，单位为秒。默认值为 `30` 秒。
     * @throws - 如果禁言用户失败，抛出错误。
     */
    ban: (group_id: number, user_id: number, duration?: number) => Promise<void>;
    /**
     * 设置群组全员禁言状态。
     * 
     * @param group_id - 群ID。
     * @param enable - 是否开启全员禁言。默认值为 `false`，即关闭全员禁言。
     * @throws - 如果设置全员禁言状态失败，抛出错误。
     */
    banAll: (group_id: number, enable: boolean) => Promise<void>;
    /**
     * 设置群组名称。
     * 
     * @param group_id - 群ID。
     * @param name - 要设置的群组名称。
     * @throws - 如果设置群组名称失败，抛出错误。
     */
    setGroupName: (group_id: number, name: string) => Promise<void>;
    /**
     * 设置群组管理员。
     * 
     * @param group_id - 群ID。
     * @param user_id - 要设置或取消管理员权限的用户的ID。
     * @param enable - 是否设置为管理员。默认值为 `true`，即设置为管理员。
     * @throws - 如果设置管理员权限失败，抛出错误。
     */
    setAdmin: (group_id: number, user_id: number, enable: boolean) => Promise<void>;
    /**
     * 设置群组成员的特殊头衔。
     * 
     * @param group_id - 群ID。
     * @param user_id - 要设置特殊头衔的用户的ID。
     * @param title - 要设置的特殊头衔。
     * @throws - 如果设置特殊头衔失败，抛出错误。
     */
    setTitle: (group_id: number, user_id: number, title: string) => Promise<void>;
    /**
     * 处理群组加入请求，自动同意请求。
     * @param flag - 从上报消息获取
     * @throws - 如果处理请求失败，抛出错误。
     */
    aprroveGroup: (flag: string) => Promise<void>;
    /**
     * 处理群组加入请求，自动拒绝请求。
     * 
     * @param flag - 从上报消息获取
     * @throws - 如果处理请求失败，抛出错误。
     */
    rejectGroup: (flag: string) => Promise<void>;
    /**
     * 检查用户是否是群组管理员或群主。
     * 
     * @param e - 原始消息
     * @returns 如果用户是群组管理员或群主，则返回 `true`，否则返回 `false`。
     * @throws - 如果获取群组成员信息失败，抛出错误。
     */
    isGroupAdmin: (e: any) => Promise<boolean>;
    /**
     * 检查用户是否是群组群主。
     * 
     * @param e - 原始消息
     * @returns 如果用户是群组群主，则返回 `true`，否则返回 `false`。
     * @throws - 如果获取群组成员信息失败，抛出错误。
     */
    isGroupOwner: (e: any) => Promise<boolean>;
    /**
     * MD5 加密
     * @param {string} text 待 MD5 加密数据
     * @return {string} MD5 加密后的 hex 字符串
     */
    md5: (text: string) => string;
    /**
     * 生成随机整数
     * @param {number} min 最小值
     * @param {number} max 最大值
     * @return {number} 随机范围内的整数
     */
    randomInt: (min: number, max: number) => number;
    /**
     * 取数组内随机一项
     * @param {Array<T>} array 待操作数组
     * @return {T} 数组内的随机一项
     */
    randomItem: <T>(array: T[]) => T;   
    /**
     * 获取群组头像链接
     * @param group_id 群组ID
     * @param size 头像大小，可选值为40、64、100、200
     * @return 群组头像链接
     */
    getGroupAvatarLink: (group_id: number, size?: number) => string;
    /**
     * 获取QQ头像链接
     * @param user_id QQ号
     * @param size 头像大小，可选值为40、64、100、200
     * @return QQ头像链接
     */
    getQQAvatarLink: (user_id: number, size?: number) => string;
    /**
     * 获取图片链接
     * @param e 原始消息
     * @return 图片链接
     */
    getImageLink: (e: AllHandlers['message']) => string;
    /**
     * 获取消息中提及到的图片URL（消息或被引用消息中的图片）
     * @param e 原始消息
     * @return 图片链接
     */
    getMentionedImageUrl: (e: AllHandlers['message']) => Promise<string | null>;
    /**
     * 替换 URL 中的 rkey 参数, 获取直链
     * @param url - 原始 URL
     * @returns 替换 rkey 后的新 URL
     */
    getDirectLink: (url: string) => Promise<string>;
    /**
     * 从消息内容中提取回复消息的ID。
     * 如果找到回复消息ID，则返回该ID；否则，返回空字符串。
     * 
     * @param e - 包含回复消息信息的原始消息。
     * @returns 提取的回复消息ID字符串，如果未找到则返回空字符串。
     * @throws 如果在提取过程中发生错误，记录错误日志并返回空字符串。
     */
    getReplyMessageId: (e: AllHandlers['message']) => string;
    /**
     * 从消息内容中提取 @ 消息的 ID。
     * 如果找到 @ 消息ID，则返回该ID；否则，返回空字符串。
     * 
     * @param e - 原始消息字符串。
     * @returns 提取的 @ 消息ID字符串，如果未找到则返回空字符串。
     * @throws 如果在提取过程中发生错误，记录错误日志并返回空字符串。
     */
    getMessageAt: (e: AllHandlers['message']) => number | null;
    /**
     * 从消息内容中提取纯文本内容。
     * 
     * @param e - 原始消息对象。
     * @returns 提取的纯文本内容字符串。
     * @throws 如果在提取过程中发生错误，记录错误日志并抛出错误。
     */
    getText: (e: AllHandlers['message']) => string;

    /**
     * 从消息内容中提取被引用的消息内容。
     * 
     * @param e - 包含被回复消息信息的原始消息。
     * @returns 提取的被回复消息内容字符串。
     * @throws 如果在提取过程中发生错误，记录错误日志并抛出错误。
     */
    getQuotedText: (e: AllHandlers['message']) => Promise<string>;
    /**
     * 发送伪造消息。
     * 
     * @param target_id - 目标用户的ID（如果是私聊）或群组的ID（如果是群聊）。
     * @param message - 要发送的消息内容，格式为 `Send['node'][]`。
     * @param isGroup - 是否发送到群组。默认值为 `true`。
     * @returns - 返回发送消息的结果，包含消息ID和资源ID。
     * @throws - 如果发送消息失败，抛出错误。
     */
    fakeMessage: (target_id: number, message: Send['node'][], isGroup: boolean) => Promise<{
        message_id: number;
        res_id: string;
    }>;
    /**
     * 获取群成员信息
     * @param group_id - 群ID
     * @param user_id - 用户ID
     * @param no_cache - 是否不使用缓存
     * @returns 群成员信息
     */
    getGroupMemberInfo: (group_id: number, user_id: number, no_cache: boolean) => Promise<any>
    /**
     * 获取被引用的消息详细
     * @param e - 原始消息
     * @returns 被引用的消息详细
     */
    getQuoteMessage: (e: AllHandlers['message']) => Promise<any>;
    /**
     * 设置QQ性别
     * @param sex - 性别
     */
    setSex: (sex: number) => Promise<void>;
    /**
     * 退出群组
     * @param group_id - 群组ID
     * @param is_dismiss - 是否解散群组
     */
    quitGroup: (group_id: number, is_dismiss: boolean) => Promise<void>;
    /**
     * 设置群管理员
     * @param group_id - 群组ID
     * @param user_id - 用户ID
     * @param enable - 是否启用
     */
    setGroupAdmin: (group_id: number, user_id: number, enable: boolean) => Promise<void>;
    /**
     * 设置群名片
     * @param group_id - 群组ID
     * @param user_id - 用户ID
     * @param card - 名片内容
     */
    setGroupCard: (group_id: number, user_id: number, card: string) => Promise<void>;
    /**
     * 判断是否艾特bot
     * @param e - 事件对象
     * @returns 是否艾特bot
     */
    isAtBot: (e: AllHandlers['message']) => Promise<boolean>;
    /** 工具函数 */
    utils: {
        /** 为事件对象添加reply方法 */
        addReplyMethod: <T extends any>(e: T) => T & ExtendedEvent;
    };
}

interface CyberPlugin {
    /** 插件 ID */
    name: string;
    /** 插件版本 */
    version?: string;
    /** 插件描述 */
    description?: string;
    /** 插件初始化，可返回一个函数用于清理 */
    setup?: (ctx: CyberPluginContext) => any;
}

/**
 * 错误处理工具类
 */
class ErrorHandler {
    private static readonly MAX_ERROR_LOGS = 50; // 最大错误日志数量
    private static readonly ERROR_LOGS_FILE = join(process.cwd(), "logs", "error_logs.json");
    private static readonly MAX_LOG_AGE_DAYS = 3; // 默认保留3天的错误日志
    private static errorLogs: Array<{
        timestamp: number;
        plugin: string;
        type: string;
        message: string;
        code?: string;
    }> = [];
    private static isInitialized = false;
    
    // 提高性能的内存优化标志
    private static memoryOptimizedMode = false;
    // 最后保存时间，用于延迟写入
    private static lastSaveTime = 0;
    // 待保存标志
    private static pendingSave = false;
    // 保存延迟
    private static readonly SAVE_DELAY = 5000; // 5秒
    
    /**
     * 初始化错误处理器
     */
    static initialize(): void {
        if (this.isInitialized) return;
        
        try {
            this.loadErrorLogs();
            this.isInitialized = true;
            
            // 启动时清理旧日志
            this.cleanOldLogs();
            
            // 设置进程退出时保存日志
            process.on('exit', () => {
                this.saveErrorLogsSynchronously();
            });
            
            // 设置每小时自动保存
            setInterval(() => {
                this.saveErrorLogs().catch(err => {
                    console.error('Failed to auto-save error logs:', err);
                });
            }, 60 * 60 * 1000);
            
            log.info(`[*]错误处理系统已初始化，最大日志数量: ${this.MAX_ERROR_LOGS}`);
        } catch (error) {
            console.error('Error initializing ErrorHandler:', error);
        }
    }
    
    /**
     * 启用内存优化模式，减少日志细节
     * @param enable 是否启用
     */
    static setMemoryOptimizedMode(enable: boolean): void {
        this.memoryOptimizedMode = enable;
        log.info(`[*]错误日志内存优化模式已${enable ? '启用' : '禁用'}`);
    }
    
    /**
     * 格式化错误对象为字符串
     */
    static formatError(error: any): string {
        if (!error) return 'Unknown error';
        
        // 在内存优化模式下简化错误信息
        if (this.memoryOptimizedMode) {
            return error.message || String(error);
        }
        
        // 常规模式下，返回更详细的错误信息
        try {
            if (error instanceof Error) {
                return `${error.name}: ${error.message}\n${error.stack || ''}`;
            }
            if (typeof error === 'string') {
                return error;
            }
            return JSON.stringify(error, null, 2);
        } catch (e) {
            return String(error);
        }
    }
    
    /**
     * 记录错误日志
     * @param plugin 插件名称
     * @param type 错误类型
     * @param error 错误对象
     */
    static logError(plugin: string, type: string, error: any): void {
        try {
            if (!this.isInitialized) {
                this.initialize();
            }
            
            // 格式化错误消息
            const message = this.formatError(error);
            
            // 在内存优化模式下限制错误消息长度
            const limitedMessage = this.memoryOptimizedMode && message.length > 500 
                ? message.substring(0, 500) + '...(truncated)'
                : message;
            
            // 添加到错误日志数组
            this.errorLogs.unshift({
                timestamp: Date.now(),
                plugin,
                type,
                message: limitedMessage,
                // 在内存优化模式下不保存代码片段
                code: this.memoryOptimizedMode ? undefined : (error.code || undefined)
            });
            
            // 保持日志数量在限制范围内
            if (this.errorLogs.length > this.MAX_ERROR_LOGS) {
                this.errorLogs = this.errorLogs.slice(0, this.MAX_ERROR_LOGS);
            }
            
            // 延迟保存以减少I/O操作
            this.pendingSave = true;
            const now = Date.now();
            if (now - this.lastSaveTime > this.SAVE_DELAY) {
                this.saveErrorLogs().catch(e => console.error('Failed to save error logs:', e));
                this.lastSaveTime = now;
                this.pendingSave = false;
            } else if (!this.pendingSave) {
                // 设置延迟保存
                this.pendingSave = true;
                setTimeout(() => {
                    if (this.pendingSave) {
                        this.saveErrorLogs().catch(e => console.error('Failed to save error logs:', e));
                        this.lastSaveTime = Date.now();
                        this.pendingSave = false;
                    }
                }, this.SAVE_DELAY);
            }
            
            // 同时输出错误日志到控制台
            log.error(`[${plugin}][${type}] ${message}`);
        } catch (e) {
            console.error('Error in logError:', e);
        }
    }
    
    /**
     * 加载错误日志从文件
     */
    private static loadErrorLogs(): void {
        try {
            // 确保日志目录存在
            const logDir = join(process.cwd(), "logs");
            if (!existsSync(logDir)) {
                mkdirSync(logDir, { recursive: true });
            }
            
            if (!existsSync(this.ERROR_LOGS_FILE)) {
                this.errorLogs = [];
                return;
            }
            
            const data = readFileSync(this.ERROR_LOGS_FILE, 'utf8');
            this.errorLogs = JSON.parse(data);
            
            // 验证并清理损坏的日志
            this.errorLogs = this.errorLogs.filter(log => 
                log && typeof log === 'object' && 
                typeof log.timestamp === 'number' &&
                typeof log.plugin === 'string' &&
                typeof log.type === 'string'
            );
            
            log.info(`[*]已加载 ${this.errorLogs.length} 条错误日志记录`);
        } catch (error) {
            console.error('Error loading error logs:', error);
            this.errorLogs = [];
        }
    }
    
    /**
     * 异步保存错误日志到文件
     */
    private static async saveErrorLogs(): Promise<void> {
        try {
            // 确保日志目录存在
            const logDir = join(process.cwd(), "logs");
            if (!existsSync(logDir)) {
                mkdirSync(logDir, { recursive: true });
            }
            
            const data = JSON.stringify(this.errorLogs);
            await writeFile(this.ERROR_LOGS_FILE, data, 'utf8');
        } catch (error) {
            console.error('Error saving error logs:', error);
        }
    }
    
    /**
     * 同步保存错误日志到文件（进程退出时使用）
     */
    static saveErrorLogsSynchronously(): void {
        if (!this.isInitialized) {
            return;
        }

        try {
            // 确保日志目录存在
            const logDir = join(process.cwd(), "logs");
            if (!existsSync(logDir)) {
                mkdirSync(logDir, { recursive: true });
            }

            // 清理过期日志
            this.cleanOldLogs();

            // 同步写入文件
            const data = JSON.stringify(this.errorLogs, null, 2);
            writeFileSync(this.ERROR_LOGS_FILE, data, 'utf8');
            
            // 清空内存中的日志
            this.errorLogs = [];
            this.pendingSave = false;
            
            log.info('[*]错误日志已同步保存');
        } catch (error) {
            console.error('Error saving error logs synchronously:', error);
            // 在退出时，我们仍然尝试写入，即使可能失败
            try {
                const data = JSON.stringify(this.errorLogs);
                writeFileSync(this.ERROR_LOGS_FILE, data, 'utf8');
            } catch (e) {
                console.error('Final attempt to save error logs failed:', e);
            }
        }
    }
    
    /**
     * 获取特定插件的错误日志
     */
    static getPluginErrors(pluginName: string): Array<any> {
        return this.errorLogs.filter(log => log.plugin === pluginName);
    }
    
    /**
     * 清理旧的错误日志
     */
    static cleanOldLogs(maxAge: number = this.MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000): void {
        if (!this.isInitialized) {
            return;
        }

        try {
            const now = Date.now();
            const oldSize = this.errorLogs.length;
            
            // 过滤掉过期的日志
            this.errorLogs = this.errorLogs.filter(log => 
                log && 
                typeof log === 'object' && 
                typeof log.timestamp === 'number' &&
                (now - log.timestamp) < maxAge
            );
            
            const removedCount = oldSize - this.errorLogs.length;
            if (removedCount > 0) {
                log.info(`[*]已清理 ${removedCount} 条过期错误日志`);
            }
        } catch (error) {
            console.error('Error cleaning old logs:', error);
        }
    }
    
    /**
     * 立即清空所有错误日志
     */
    static clearAllLogs(): void {
        this.errorLogs = [];
        this.saveErrorLogs().catch(e => console.error('Failed to save after clearing logs:', e));
        log.info('[*]已清空所有错误日志');
    }
}

export class PluginManager {
    public plugins: Map<string, PluginInfo>;
    public bot: NCWebsocket;
    private pluginCtxProxies: Map<string, CyberPluginContext> = new Map();
    private sharedMethodWrappers: Map<string, Function> = new Map();
    private pluginErrorHandlers: Map<string, Map<string, Function>> = new Map();
    public ctx: CyberPluginContext;
    private tempListener: Array<listener>;
    private tempCronJob: Array<any>;
    private jiti: any;
    private cronTaskPool: Map<string, Array<any>> = new Map();
    
    // 添加内存监控相关属性
    private static readonly MEMORY_CHECK_INTERVAL = 5 * 60 * 1000; // 5分钟检查一次
    private static readonly MEMORY_WARNING_THRESHOLD = 0.8; // 80%内存使用率警告
    private static readonly MEMORY_CRITICAL_THRESHOLD = 0.9; // 90%内存使用率危险
    private memoryCheckInterval: NodeJS.Timeout | null = null;
    
    constructor(bot: NCWebsocket, config: Config) {
        this.plugins = new Map<string, PluginInfo>();
        this.bot = bot;
        this.tempListener = [];
        this.tempCronJob = [];
        
        // 初始化定时任务池
        this.cronTaskPool = new Map();
        
        this.jiti = createJiti(import.meta.url, {moduleCache: false});
        this.ctx = {
            config: config,
            http: axios,
            bot: this.bot,
            bot_uin: config.bot,
            cron: (cronTasks, func) => {
                // 存储定时任务的数组
                const cronJobInstances = [];
                
                // 如果是数组格式，表示多个定时任务
                if (Array.isArray(cronTasks)) {
                    for (const [cronExpression, callback] of cronTasks) {
                        if(!cron.validate(cronExpression)){
                            log.error(`[-]无效的 cron 表达式: ${cronExpression}`);
                            cronJobInstances.push(null); // 占位，保持索引一致
                            this.tempCronJob.push(false);
                            continue;
                        }
                        
                        // 1. 创建一个轻量级事件对象模板 - 避免在闭包中重复创建
                        const baseEventTemplate = {
                            message_type: 'group',
                            raw_message: '',
                            message_id: 0,
                            user_id: 0,
                            group_id: 0,
                            sender: { user_id: 0 }
                        };
                        
                        // 2. 预先创建reply方法，避免每次调用都创建
                        const replyMethod = async (message: string | number | any[] | any, quote: boolean = false) => {
                            try {
                                let messageArray = Array.isArray(message) ? message : [message];
                                const processedMessages = messageArray.map(item => {
                                    if (typeof item === 'string' || typeof item === 'number') {
                                        return Structs.text(item.toString());
                                    }
                                    return item;
                                });
                                
                                return await this.bot.send_msg({
                                    user_id: 0, // 默认值，实际发送时不会用到
                                    message: processedMessages
                                });
                            } catch (error) {
                                log.error(`Failed to send cron message: ${error}`);
                                return { message_id: 0 };
                            }
                        };
                        
                        // 3. 提取真正需要的ctx属性，而不是捕获整个ctx
                        // 创建一个最小化的上下文对象，包含常用属性
                        const minimalCtx = {
                            bot: this.bot,
                            config: {
                                master: [...this.ctx.config.master], // 复制数组，避免引用
                                bot: this.ctx.config.bot
                            },
                            // 添加任务可能需要的其他最小化属性
                            sendPrivateMessage: this.ctx.sendPrivateMessage,
                            sendGroupMessage: this.ctx.sendGroupMessage
                        };
                        
                        // 4. 创建轻量级回调包装器
                        const wrappedCallback = () => {
                            try {
                                // 每次创建新的事件对象，避免状态共享问题
                                const eventObj = {...baseEventTemplate};
                                
                                // 添加reply方法
                                (eventObj as any).reply = replyMethod;
                                
                                // 使用类型断言处理类型兼容问题
                                return callback(minimalCtx as unknown as CyberPluginContext, eventObj as any);
                            } catch (error) {
                                // 捕获并记录错误，但不中断cron执行
                                log.error(`[-]Cron任务执行错误: ${error}`);
                            }
                        };
                        
                        // 5. 创建定时任务实例，但初始状态为暂停
                        const job = cron.schedule(cronExpression, wrappedCallback, {
                            scheduled: false
                        });
                        
                        // 存储到临时数组和结果数组
                        cronJobInstances.push(job);
                        this.tempCronJob.push(job);
                    }
                    
                    // 返回创建的所有任务实例，便于后续管理
                    return cronJobInstances;
                }
                
                // 原有的字符串格式处理（单个定时任务）
                if(!cron.validate(cronTasks)){
                    log.error(`[-]无效的 cron 表达式: ${cronTasks}`);
                    this.tempCronJob.push(false);
                    return null;
                }
                
                // 同样使用最小化上下文创建单个任务
                const job = cron.schedule(cronTasks, func!, {
                    scheduled: false
                });
                
                this.tempCronJob.push(job);
                cronJobInstances.push(job);
                return job;  // 返回单个任务实例
            },
            plugin: {
                getPlugins: () => {
                    return this.getPlugins();
                },
                onPlugin: (pluginName: string) => {
                    return this.onPlugin(pluginName)
                },
                offPlugin: (pluginName: string) => {
                    return this.offPlugin(pluginName)
                },
                reloadPlugin: (pluginName: string): Promise<string> => {
                    return this.reloadPlugin(pluginName)
                },
                getPluginsFromDir: (): string[] => {
                    return this.getPluginsFromDir();
                },
                loadPlugin: (pluginName: string): Promise<any> => {
                    return this.loadPlugin(pluginName);
                }
            },
            handle: <EventName extends keyof AllHandlers>(eventName: EventName, func: EventName extends "message" | "message.group" | "message.private"
                ? (e: AllHandlers[EventName] & ExtendedEvent) => any 
                : (e: AllHandlers[EventName] & ExtendedEvent) => any) => {
                const wrappedFunc = async (e: any) => {
                    try {
                        // 添加reply方法
                        const extendedEvent = this.ctx.utils.addReplyMethod(e);
                        // @ts-ignore: 忽略复杂联合类型的错误
                        return await func(extendedEvent);
                    } catch (error) {
                        // 记录错误但不中断事件处理流程
                        log.error(`[-]处理${eventName}事件时出错: ${error}`);
                        // 避免错误影响整个系统
                        return null;
                    }
                };
                
                const obj = {
                    event: eventName,
                    fn: wrappedFunc
                }
                this.tempListener.push(obj)
            },
            isMaster: (e) => {
                if (typeof e === 'number' && !isNaN(e)) {
                    return this.ctx.config.master.includes(e)
                }
                if (typeof e === 'object' && e.sender && typeof e.sender.user_id === 'number') {
                    return this.ctx.config.master.includes(e.sender.user_id);
                }
                return false;
            },
            isAdmin: (e) => {
                if (typeof e === 'number' && !isNaN(e)) {
                    return this.ctx.config.master.includes(e) || this.ctx.config.admins.includes(e)
                }
                if (typeof e === 'object' && e.sender && typeof e.sender.user_id === 'number') {
                    const userId = e.sender.user_id;
                    return this.ctx.config.master.includes(userId) || this.ctx.config.admins.includes(userId);
                }
                return false;
            },
            hasRight: (e) => {
                // 处理不同类型的输入
                try {
                    if (typeof e === 'number') {
                        // 如果传入的是数字（user_id），直接判断权限
                        return this.ctx.isMaster(e) || this.ctx.isAdmin(e);
                    }
                    
                    if (e && typeof e === 'object') {
                        if (e.sender && typeof e.sender.user_id === 'number') {
                            // 如果传入的是有sender属性的事件对象
                            return this.ctx.isMaster(e.sender.user_id) || this.ctx.isAdmin(e.sender.user_id);
                        } else if (typeof e.user_id === 'number') {
                            // 如果传入对象有user_id属性
                            return this.ctx.isMaster(e.user_id) || this.ctx.isAdmin(e.user_id);
                        }
                    }
                    
                    // 其它情况，记录错误并返回false
                    log.error(`hasRight: 无效的参数类型: ${typeof e}, 值: ${JSON.stringify(e)}`);
                    return false;
                } catch (error) {
                    log.error(`hasRight检查失败: ${error}`);
                    return false;
                }
            },

            sendPrivateMessage: async (user_id:number, message: string | number | Array<any>,):Promise<{message_id: number;}> => {
                try{
                    return await this.bot.send_private_msg({
                        user_id: user_id,
                        message: Array.isArray(message) ? message : [Structs.text(String(message))]
                    })
                }catch(error){
                    log.error(`Failed to send message: ${error}`);
                    return { message_id: 0 };
                }
            },

            sendGroupMessage: async (group_id:number, message: string | number | Array<any>): Promise<{message_id: number;}> => {
                try{
                    return await this.bot.send_group_msg({
                        group_id: group_id,
                        message: Array.isArray(message) ? message : [Structs.text(String(message))]
                    })
                }catch(error){
                    log.error(`Failed to send message: ${error}`);
                    return { message_id: 0 };
                }
            },
            delete_msg: async (message_id: number): Promise<void> => {
                try {
                    await this.bot.delete_msg({ message_id });
                } catch (error) {
                    log.error(`Failed to delete message: ${error}`);
                }
            },
            kick: async (group_id: number, user_id: number, reject_add_request?: boolean): Promise<void> => {
                try{
                    await this.bot.set_group_kick({
                        group_id: group_id,
                        user_id: user_id,
                        reject_add_request: reject_add_request
                    });
                }catch(error){
                    log.error(`Failed to kick user ${user_id} from group ${group_id}: ${error}`);
                }
            },
            ban: async (group_id: number, user_id: number, duration?: number): Promise<void> => {
                try{
                    await this.bot.set_group_ban({
                        group_id: group_id,
                        user_id: user_id,
                        duration: duration
                    });
                }catch(error){
                    log.error(`Failed to ban user ${user_id} in group ${group_id}: ${error}`);
                }
            },
            banAll: async (group_id: number, enable: boolean): Promise<void> => {
                try{
                    await this.bot.set_group_whole_ban({
                        group_id: group_id,
                        enable: enable
                    });
                }catch(error){
                    log.error(`Failed to set whole ban for group ${group_id} to ${enable}: ${error}`);
                }
            },
            setGroupName: async (group_id: number, name: string): Promise<void> => {
                try{
                    await this.bot.set_group_name({
                        group_id: group_id,
                        group_name: name
                    }); 
                }catch(error){
                    log.error(`Failed to set group name for group ${group_id} to ${name}: ${error}`);
                }
            },
            setAdmin: async (group_id: number, user_id: number, enable: boolean): Promise<void> => {
                try{
                    await this.bot.set_group_admin({
                        group_id: group_id,
                        user_id: user_id,
                        enable: enable
                    });
                }catch(error){
                    log.error(`Failed to set admin status for user ${user_id} in group ${group_id} to ${enable}: ${error}`);
                }
            },
            setTitle: async (group_id: number, user_id: number, title: string): Promise<void> => {
                try{
                    await this.bot.set_group_special_title({
                        group_id: group_id,
                        user_id: user_id,
                        special_title: title
                    });
                }catch(error){
                    log.error(`Failed to set special title for user ${user_id} in group ${group_id} to ${title}: ${error}`);
                }
            },
            aprroveGroup: async (flag: string): Promise<void> => {
                try{
                    await this.bot.set_group_add_request({
                        flag: flag,
                        approve: true
                    });
                }catch(error){
                    log.error(`Failed to approve group request: ${error}`);
                }
            },
            rejectGroup: async (flag: string): Promise<void> => {
                try{
                    await this.bot.set_group_add_request({
                        flag: flag,
                        approve: false
                    });
                }catch(error){
                    log.error(`Failed to reject group request: ${error}`);
                }
            },
            isGroupAdmin: async (e: any): Promise<boolean> => {
                try {
                    // 确保有有效的group_id和能获取到bot id
                    if (!e || !e.group_id) {
                        log.error("isGroupAdmin: 无效的参数，缺少group_id");
                        return false;
                    }
                    
                    const botInfo = await this.bot.get_login_info();
                    if (!botInfo || !botInfo.user_id) {
                        log.error("isGroupAdmin: 无法获取机器人信息");
                        return false;
                    }
                    
                    const result = await this.bot.get_group_member_info({
                        group_id: e.group_id,
                        user_id: botInfo.user_id,
                        no_cache: false
                    });
                    
                    return result.role === 'admin' || result.role === 'owner';
                } catch (error) {
                    log.error(`isGroupAdmin检查失败: ${error}`);
                    return false;
                }
            },
            isGroupOwner: async (e: any): Promise<boolean> => {
                try {
                    // 确保参数有效
                    if (!e || !e.group_id || !e.sender || !e.sender.user_id) {
                        log.error("isGroupOwner: 无效的参数，缺少必要信息");
                        return false;
                    }
                    
                    const memberInfo = await this.bot.get_group_member_info({ 
                        group_id: e.group_id, 
                        user_id: e.sender.user_id,
                        no_cache: false
                    });
                    
                    return memberInfo.role === 'owner';
                } catch (error) {
                    log.error(`Failed to check if user ${e?.sender?.user_id} is an owner in group ${e?.group_id}: ${error}`);
                    return false;
                }
            },
            md5: (text: string) => {
                const hash = createHash('md5');
                hash.update(text);
                return hash.digest('hex');
            },
            randomInt: (min: number, max: number) => {
                return Math.floor(Math.random() * (max - min + 1)) + min;
            },
            randomItem: <T>(array: T[]) => {
                return array[Math.floor(Math.random() * array.length)];
            },
            getGroupAvatarLink: (group_id: number, size?: number) => {
                return `https://p.qlogo.cn/gh/${group_id}/${group_id}/${size || 40}`;
            },
            getQQAvatarLink: (user_id: number, size?: number) => {
                return `https://q2.qlogo.cn/headimg_dl?dst_uin=${user_id}&spec=${size || 40}`;
            },
            getImageLink: (e: AllHandlers['message']) => {
                try {
                    if (!Array.isArray(e.message)) return "";
                    
                    const imageItem = e.message.find(item => item.type === "image");
                    return imageItem?.data?.url.trim() || "";
                } catch (error) {
                    log.error('提取图片链接时发生错误:', error);
                    return "";
                }
            },
            getMentionedImageUrl: async (e: AllHandlers['message']) => {
                if (!e || !e.message) return null;
                try {
                const reply: any = e.message.find((msg: any) => msg.type === 'reply');
                if (!reply) return null;
                const msg = await this.bot.get_msg({ message_id: reply.data.id });

                for (const segment of msg.message) {
                    if (segment.type === 'image' && segment.data && segment.data.url) {
                    return segment.data.url;
                    }
                }
                } catch {
                for (const segment of e.message) {
                    if (segment.type === 'image' && segment.data && segment.data.url) {
                    return segment.data.url;
                    }
                }
                }
                return null;
            },
            getDirectLink: async (url: string) => {
                try {
                    const rKey = await this.bot.nc_get_rkey();
                    if (!rKey) {
                      log.error('获取 rkey 失败，无法替换');
                      return "";
                    }

                    // 从URL中提取appid
                    const appidMatch = url.match(/appid=(\d+)/);
                    const appid = appidMatch ? appidMatch[1] : null;

                    // 根据appid选择rkey
                    let current_rkey;
                    if (appid === '1406') {
                        current_rkey = rKey[0]?.rkey;
                    } else if (appid === '1407') {
                        current_rkey = rKey[1]?.rkey;
                    } else {
                        log.error('未知的appid或无法从URL中提取appid');
                        return "";
                    }

                    // 使用正则表达式提取 &rkey= 之前的内容
                    const regex = /^(.*?)&rkey=/;
                    const baseUrl = url.match(regex)?.[1];
                    // 如果匹配到内容，拼接 rKey，否则返回空字符串
                    return baseUrl ? `${baseUrl}${current_rkey}` : "";
                  } catch (error) {
                    log.error('获取直链失败:', error);
                    return "";
                  }
            },
            
            getReplyMessageId: (e: AllHandlers['message']) => {
                try {
                    if (!Array.isArray(e.message)) return "";
                    const replyObj = e.message.find(item => item.type === "reply");
                    return replyObj?.data?.id.trim() || ""; // 转为 number 或 null
                  } catch (error) {
                    log.error('提取消息ID时发生错误:', error);
                    return "";
                  }
            },
            getMessageAt: (e: AllHandlers['message']): number | null => {
                try {
                    if (!Array.isArray(e.message)) return null;
                    
                    // 查找第一个at类型的消息段
                    const atItem = e.message.find(item => item.type === "at");
                    if (!atItem || !atItem.data) return null;
                    
                    // 使用类型断言来避免TypeScript错误
                    const qqStr = (atItem.data as { qq?: string }).qq;
                    if (!qqStr) return null;
                    
                    // 转换为数字并返回
                    const qq = Number(qqStr);
                    return isNaN(qq) ? null : qq;
                } catch (error) {
                    log.error('提取艾特的QQ号时发生错误:', error);
                    return null;
                }
            },
            getText: (e: AllHandlers['message']) => {
                try {
                    if (!Array.isArray(e.message)) return "";
                    
                    // 收集所有文本段并拼接
                    const textSegments = e.message
                        .filter(item => item.type === "text")
                        .map(item => item.data?.text || "")
                        .join("")
                        .trim();
                    
                    return textSegments;
                } catch (error) {
                    log.error('提取纯文本内容时发生错误:', error);
                    return "";
                }
            },
            getQuotedText: async (e: AllHandlers['message']): Promise<string> => {
                try {
                    const message_id = this.ctx.getReplyMessageId(e);
                    if (!message_id) return ""; // 提前返回无效情况
                    
                    const { raw_message } = await this.bot.get_msg({ 
                        message_id: Number(message_id) 
                    });
                    return raw_message || ""; // 确保总是返回字符串
                } catch (error) {
                    logger.error('提取被引用的文本时发生错误:', error);
                    return "";
                }
            },
            fakeMessage: async (target_id: number, message: Send['node'][], isGroup: boolean) => {
                try {
                    // 调用 send_group_forward_msg 函数
                    /**@ =message例子=
                     * message: [
                     *   {
                     *     type: 'node',
                     *     data: {
                     *       content: [
                     *           Structs.text(message) // 消息内容，使用 Structs.text 生成文本消息
                     *       ]
                     *     }
                     *   }
                     * ]
                     **/
                    // 动态构建参数对象
                    const params = isGroup
                      ? { group_id: target_id, message: message } // 群聊消息
                      : { user_id: target_id, message: message }; // 私聊消息
              
                    // 调用转发消息函数
                    return await this.bot.send_forward_msg(params);
                } catch (error) {
                    log.error(`Failed to send fake message to target ${target_id}: ${error}`);
                    throw error;
                }
            },

            // 新增: 获取群成员信息
            getGroupMemberInfo: async (group_id: number, user_id: number, no_cache: boolean = false) => {
                const result = await this.bot.get_group_member_info({
                group_id: group_id,
                user_id: user_id,
                no_cache: no_cache
                });
                return result;
            },

            // 新增：获取被引用的消息详细
            getQuoteMessage: async (e: AllHandlers['message']) => {
                if (!e || !e.message) return null;
                try {
                    const reply = e.message.find((msg: any) => msg.type === 'reply');
                    if (!reply || !reply.data) return null;
                    
                    // 使用类型断言确保TypeScript知道reply.data有id属性
                    const replyId = (reply.data as { id: string }).id;
                    if (!replyId) return null;
                    
                    const msg = await this.bot.get_msg({ message_id: Number(replyId) });
                    return msg;
                } catch (error) {
                    return null;
                }
            },

            // 新增: 设置QQ性别
            setSex: async (sex: number) => {
                const botInfo = await this.bot.get_login_info();

                await this.bot.set_qq_profile({
                nickname: botInfo.nickname,
                sex: sex
                });
            },

            // 新增: 退出群组
            quitGroup: async (group_id: number, is_dismiss: boolean = false) => {
                await this.bot.set_group_leave({
                group_id: group_id,
                is_dismiss: is_dismiss
                });
            },

            // 新增: 设置群管理员
            setGroupAdmin: async (group_id: number, user_id: number, enable: boolean = true) => {
                await this.bot.set_group_admin({
                group_id: group_id,
                user_id: user_id,
                enable: enable
                });
            },

            // 新增: 设置群名片
            setGroupCard: async (group_id: number, user_id: number, card: string) => {
                await this.bot.set_group_card({
                group_id: group_id,
                user_id: user_id,
                card: card
                });
            },

            // 新增：判断是否艾特bot
            isAtBot: async (e: AllHandlers['message']) => {
                if (!e || !e.message) return false;
                const atItem = e.message.find(item => item.type === "at");
                if (!atItem || !atItem.data) return false;
                const qqStr = (atItem.data as { qq?: string }).qq;
                const botInfo = await this.bot.get_login_info();
                return qqStr === botInfo.user_id.toString();
            },

            /** 工具函数 */
            utils: {
                addReplyMethod: <T extends any>(e: T): T & ExtendedEvent => {
                    // 如果已经有reply方法，直接返回
                    if ((e as any).reply) return e as T & ExtendedEvent;
                    
                    // 提取消息类型和ID，避免闭包持有整个事件对象
                    const messageType = (e as any).message_type || 'private';
                    const messageId = (e as any).message_id;
                    const userId = (e as any).user_id;
                    const groupId = (e as any).group_id;
                    const sender = (e as any).sender;
                    
                    // 添加reply方法，尽量减少引用
                    (e as any).reply = async (message: string | number | any[] | any, quote: boolean = false) => {
                        // 处理消息内容，统一转为数组格式
                        let messageArray = Array.isArray(message) ? message : [message];
                        
                        // 转换文本和数字为消息段
                        const processedMessages = messageArray.map(item => {
                            if (typeof item === 'string' || typeof item === 'number') {
                                return Structs.text(item.toString());
                            }
                            return item;
                        });
                        
                        // 添加回复消息段（如果需要引用）
                        if (quote && messageId) {
                            processedMessages.unshift(Structs.reply(messageId));
                        }
                        
                        // 根据消息类型确定发送参数
                        const sendParams = (() => {
                            if (messageType === 'group' || groupId) {
                                return { group_id: groupId };
                            } else {
                                return { user_id: userId };
                            }
                        })();
                        
                        // 发送消息并返回结果
                        try {
                            const response = await this.bot.send_msg({
                                ...sendParams,
                                message: processedMessages
                            });

                            // 添加发送消息的日志记录
                            const messageContent = messageArray.map(item => {
                                if (typeof item === 'string') return item;
                                if (typeof item === 'number') return item.toString();
                                if (item.type === 'text') return item.data.text;
                                if (item.type === 'image') return '[图片]';
                                if (item.type === 'reply') return '[回复]';
                                if (item.type === 'at') return `[@${item.data.qq}]`;
                                if (item.type === 'video') return '[视频]';
                                if (item.type === 'audio') return '[音频]';
                                if (item.type === 'file') return '[文件]';
                                if (item.type === 'location') return '[位置]';
                                if (item.type === 'music') return '[音乐]';
                                if (item.type === 'share') return '[分享]';
                                if (item.type === 'forward') return '[转发]';
                                
                                return `[${item.type}]`;
                            }).join('');

                            if (messageType === 'group') {
                                log.info(`[*]群(${groupId}) Bot回复: ${messageContent}`);
                            } else {
                                log.info(`[*]私聊(${userId}) Bot回复: ${messageContent}`);
                            }

                            return { message_id: response.message_id };
                        } catch (error) {
                            log.error(`Failed to send message: ${error}`);
                            return { message_id: 0 };
                        }
                    };
                    
                    // 添加kick方法，方便移除群成员
                    if (messageType === 'group' && groupId) {
                        (e as any).kick = async (kickUserId: number, reject_add_request?: boolean) => {
                            try {
                                await this.bot.set_group_kick({
                                    group_id: groupId,
                                    user_id: kickUserId,
                                    reject_add_request
                                });
                            } catch (error) {
                                log.error(`Failed to kick user ${kickUserId}: ${error}`);
                            }
                        };
                    }
                    
                    return e as T & ExtendedEvent;
                }
            }
        };
    }

    // 创建插件上下文代理的方法
    private createPluginContextProxy(pluginName: string): CyberPluginContext {
        // 如果已经存在此插件的代理，直接返回
        if (this.pluginCtxProxies.has(pluginName)) {
            return this.pluginCtxProxies.get(pluginName)!;
        }

        // 确保此插件有错误处理函数缓存
        if (!this.pluginErrorHandlers.has(pluginName)) {
            this.pluginErrorHandlers.set(pluginName, new Map());
        }
        const pluginErrorCache = this.pluginErrorHandlers.get(pluginName)!;

        // 为特定插件创建的状态，可以单独维护
        const pluginState = {
            name: pluginName,
            // 这里可以添加插件特定的状态
        };

        // 创建轻量级代理对象 - 直接代理原始ctx
        const pluginCtxProxy = new Proxy(this.ctx, {
            get: (target, prop, receiver) => {
                const value = Reflect.get(target, prop, receiver);
                
                // 处理函数类型的属性
                if (typeof value === 'function') {
                    const propKey = String(prop);
                    
                    // 1. 首先尝试获取插件特定的错误处理包装器
                    if (pluginErrorCache.has(propKey)) {
                        return pluginErrorCache.get(propKey);
                    }
                    
                    // 2. 然后尝试从共享函数缓存获取
                    if (this.sharedMethodWrappers.has(propKey)) {
                        // 获取通用的函数包装
                        const sharedWrapper = this.sharedMethodWrappers.get(propKey)!;
                        
                        // 创建插件特定的错误处理包装 - 复用通用逻辑但添加插件特定的错误处理
                        const errorHandler = (...args: any[]) => {
                            try {
                                return sharedWrapper.apply(target, args);
                            } catch (error) {
                                // 添加插件特定的错误处理
                                ErrorHandler.logError(pluginName, `ctx_method_${propKey}`, error);
                                log.warn(`[!]插件${pluginName}调用${propKey}方法出错: ${ErrorHandler.formatError(error)}`);
                                throw error;
                            }
                        };
                        
                        // 缓存此插件特定的错误处理包装
                        pluginErrorCache.set(propKey, errorHandler);
                        return errorHandler;
                    }
                    
                    // 3. 如果缓存中不存在，创建并存储通用函数包装
                    const genericWrapper = function(this: any, ...args: any[]) {
                        return value.apply(target, args);
                    };
                    
                    // 存储到共享函数缓存
                    this.sharedMethodWrappers.set(propKey, genericWrapper);
                    
                    // 创建并缓存插件特定的错误处理包装
                    const errorHandler = (...args: any[]) => {
                        try {
                            return genericWrapper.apply(target, args);
                        } catch (error) {
                            // 添加插件特定的错误处理
                            ErrorHandler.logError(pluginName, `ctx_method_${propKey}`, error);
                            log.warn(`[!]插件${pluginName}调用${propKey}方法出错: ${ErrorHandler.formatError(error)}`);
                            throw error;
                        }
                    };
                    
                    // 缓存此插件特定的错误处理包装
                    pluginErrorCache.set(propKey, errorHandler);
                    return errorHandler;
                }
                
                // 处理需要隔离的属性
                if (prop === 'plugin') {
                    // 确保plugin工具方法在调用时能正确获取当前插件名
                    return {
                        ...value,
                        // 重写可能需要特殊处理的方法
                        reloadPlugin: (name: string) => {
                            // 默认重载自己
                            if (!name || name === '') {
                                return this.reloadPlugin(pluginName);
                            }
                            return value.reloadPlugin(name);
                        }
                    };
                }
                
                return value;
            }
        });

        // 保存到代理缓存中
        this.pluginCtxProxies.set(pluginName, pluginCtxProxy);
        return pluginCtxProxy;
    }

    async init() {
        // 移除对initSharedContext的调用
        // this.initSharedContext();

        // 之前的方法是获取所有插件目录中的插件
        //const pluginList = this.getPluginsFromDir();
        
        // 修改为只获取配置文件中指定的系统和用户插件
        const configSystemPlugins = this.ctx.config.plugins.system || [];
        const configUserPlugins = this.ctx.config.plugins.user || [];
        
        // 合并系统插件和用户插件
        const pluginList = [...configSystemPlugins, ...configUserPlugins];
        
        // 输出加载的插件
        log.info(`[+]正在加载配置中的插件: ${pluginList.join(', ') || '无'}`);
        
        let success = 0,
            fail = 0;
        for (const p of pluginList) {
            try {
                const result = await this.loadPlugin(p);
                if (result) {
                    success++;
                } else {
                    log.error(`[-]插件${p}加载失败`);
                    fail++;
                }
            } catch (err) {
                log.error(`[-]插件${p}导入失败: ${err}`);
                fail++;
            }
        }
        log.info(
            `[+]插件加载完毕, 一共导入${
                success + fail
            }个插件, 成功: ${success}, 失败: ${fail}`
        );

        // 显示启用插件数量比例（相对于所有可用插件）
        const enabledCount = Array.from(this.plugins.values()).filter(info => info.setup.enable).length;
        const totalAvailablePlugins = this.getPluginsFromDir().length;
        log.info(`[+]已启用插件: ${enabledCount}/${totalAvailablePlugins} (已加载/可用)`);

        return this.plugins;
    }

    getPluginsFromDir(): string[] {
        const pluginsPath = join(process.cwd(), "plugins");
        const plugins: string[] = [];

        // 读取所有文件和目录
        if (existsSync(pluginsPath)) {
            const allFiles = readdirSync(pluginsPath);
            
            // 处理所有文件和目录
            for (const item of allFiles) {
                const fullPath = join(pluginsPath, item);
                const stats = statSync(fullPath);
                
                if (stats.isDirectory()) {
                    // 如果是目录，检查是否有index.ts或index.js
                    const hasTsIndex = existsSync(join(fullPath, "index.ts"));
                    const hasJsIndex = existsSync(join(fullPath, "index.js"));
                    
                    if (hasTsIndex || hasJsIndex) {
                        plugins.push(item);
                    }
                } else if (stats.isFile()) {
                    // 如果是文件，检查是否是.ts或.js文件
                    if (item.endsWith('.ts') || item.endsWith('.js')) {
                        // 去掉文件扩展名
                        const pluginName = item.replace(/\.(ts|js)$/, '');
                        plugins.push(pluginName);
                    }
                }
            }
        }

        return plugins;
    }


    async loadPlugin(pluginName: string): Promise<any> {
        try {
            log.info(`[*]正在加载插件 ${pluginName}...`);

            // 使用绝对路径替代相对路径
            const pluginDir = join(process.cwd(), "plugins");
            
            // 优先检查JS文件（编译后的文件）再检查TS文件
            // 检查子目录中的插件文件
            const subDirJsPath = join(pluginDir, pluginName, "index.js");
            const subDirTsPath = join(pluginDir, pluginName, "index.ts");
            // 检查直接的插件文件
            const directJsPath = join(pluginDir, `${pluginName}.js`);
            const directTsPath = join(pluginDir, `${pluginName}.ts`);

            // 首先检查子目录js，然后子目录ts，然后直接js，最后直接ts
            let pluginPath = '';
            if (existsSync(subDirJsPath)) {
                pluginPath = subDirJsPath;
            } else if (existsSync(subDirTsPath)) {
                pluginPath = subDirTsPath;
            } else if (existsSync(directJsPath)) {
                pluginPath = directJsPath;
            } else if (existsSync(directTsPath)) {
                pluginPath = directTsPath;
            } else {
                log.error(`[-]插件${pluginName}不存在`);
                return `[-]插件${pluginName}不存在`;
            }

            // 尝试加载插件
            try {
                // 清除之前的模块缓存
                this.cleanPluginModuleCache(pluginName);

                // 动态导入插件
                const plugin = await this.jiti(pluginPath);

                // 检查插件结构
                if (!plugin || !plugin.default || !plugin.default.name) {
                    log.error(`[-]插件${pluginName}格式错误，缺少必要字段`);
                    return `[-]插件${pluginName}格式错误，缺少必要字段`;
                }

                // 创建此插件的上下文代理
                const pluginCtx = this.createPluginContextProxy(pluginName);

                // 安全地执行插件初始化
                try {
                    this.tempListener = [];
                    this.tempCronJob = [];
                    
                    // 使用插件特定的上下文代理
                    await Promise.resolve(plugin.default.setup(pluginCtx));
                    
                    // 设置插件信息
                    const pluginType = this.ctx.config.plugins.system.includes(pluginName) ? 'system' : 'user';
                    this.plugins.set(pluginName, {
                        version: plugin.default.version || "0.1.0",
                        description: plugin.default.description || "",
                        type: pluginType,
                        setup: {
                            enable: false,
                            listeners: [...this.tempListener], // 创建新数组，避免引用
                            cron: [...this.tempCronJob]
                        }
                    });
                    
                    // 存储插件的定时任务到任务池中，便于后续管理
                    if (this.tempCronJob.length > 0) {
                        // 过滤掉无效的任务（null或false值）
                        const validJobs = this.tempCronJob.filter(job => job && typeof job === 'object');
                        if (validJobs.length > 0) {
                            this.cronTaskPool.set(pluginName, validJobs);
                            log.debug(`[*]已存储插件 ${pluginName} 的 ${validJobs.length} 个定时任务`);
                        }
                    }
                    
                    // 检查是否需要自动启用
                    const enabledPlugins = pluginType === 'system' ? 
                        this.ctx.config.plugins.system : 
                        this.ctx.config.plugins.user;
                        
                    if (enabledPlugins.includes(pluginName)) {
                        log.info(`[*]插件${pluginName}在配置中已启用，正在激活...`);
                        // 使用 onPlugin 方法来确保正确启用
                        const result = this.onPlugin(pluginName);
                        if (result.startsWith('[-]')) {
                            log.error(`[-]插件${pluginName}自动启用失败: ${result}`);
                            return false;
                        }
                    }
                    
                    return true;
                } catch (error) {
                    log.error(`[-]插件${pluginName}初始化失败: ${error}`);
                    // 清理已注册的临时资源
                    this.tempListener = [];
                    this.tempCronJob = [];
                    return false;
                }
            } catch (error: any) {
                ErrorHandler.logError(pluginName, 'plugin_load', error);
                log.error(`[-]加载插件${pluginName}失败: ${ErrorHandler.formatError(error)}`);
                return `[-]加载插件${pluginName}失败: ${ErrorHandler.formatError(error)}`;
            }
        } catch (error: any) {
            ErrorHandler.logError(pluginName, 'plugin_load_outer', error);
            log.error(`[-]加载插件${pluginName}外部错误: ${ErrorHandler.formatError(error)}`);
            return `[-]加载插件${pluginName}外部错误: ${ErrorHandler.formatError(error)}`;
        }
    }

    getPlugins() {
        // 获取实际文件系统中的插件列表
        const actualPlugins = this.getPluginsFromDir();
        
        // 清理不存在的插件
        for (const [pluginName] of this.plugins) {
            if (!actualPlugins.includes(pluginName)) {
                this.plugins.delete(pluginName);
                // 从配置文件中移除该插件
                this.saveConfig(pluginName, false);
            }
        }
        
        return this.plugins;
    }

    /**
     * 保存配置到文件
     * @param pluginName 插件名称
     * @param isEnabled 是否启用
     * @private
     */
    private saveConfig(pluginName: string, isEnabled: boolean) {
        try {
            const configPath = join(process.cwd(), "config.json");
            
            // 读取完整配置文件
            const configContent = readFileSync(configPath, "utf-8");
            // 使用显式类型注解
            const fullConfig = JSON.parse(configContent) as {
                baseUrl?: string;
                accessToken?: string;
                throwPromise?: boolean;
                reconnection?: {
                    enable?: boolean;
                    attempts?: number;
                    delay?: number;
                    debug?: boolean;
                };
                bot?: number;
                master?: number[];
                admins?: number[];
                plugins?: {
                    system?: string[];
                    user?: string[];
                };
                logger?: {
                    level?: string;
                    maxSize?: string;
                    maxDays?: number;
                };
                [key: string]: any; // 允许其他属性
            };
            
            // 确保plugins部分存在
            if (!fullConfig.plugins) {
                fullConfig.plugins = { system: [], user: [] };
            }
            
            // 判断是系统插件还是用户插件
            const pluginInfo = this.plugins.get(pluginName);
            const pluginType = pluginInfo?.type || 'user';
            
            // 确保对应数组存在
            if (!fullConfig.plugins[pluginType]) {
                fullConfig.plugins[pluginType] = [];
            }
            
            const targetArray = fullConfig.plugins[pluginType];
            
            // 添加或移除插件名
            if (isEnabled && !targetArray.includes(pluginName)) {
                targetArray.push(pluginName);
            } else if (!isEnabled) {
                const index = targetArray.indexOf(pluginName);
                if (index > -1) {
                    targetArray.splice(index, 1);
                }
            }
            
            // 保存回文件，使用同步方法避免并发问题
            writeFileSync(configPath, JSON.stringify(fullConfig, null, 2));
            log.info(`[+]配置文件已更新: ${pluginName} ${isEnabled ? '已启用' : '已禁用'}`);
        } catch (error: any) { // 添加类型注解
            log.error(`[-]保存配置文件失败: ${error}`);
            // 通知出现错误，而不是默默失败
            throw new Error(`保存配置文件失败: ${error.message || String(error)}`);
        }
    }

    offPlugin(pluginName: string) {
        const map = this.plugins.get(pluginName) as PluginInfo;
        if (!this.plugins.has(pluginName)) {
            return "[-]该插件不存在";
        }
        
        // 如果插件已经是禁用状态，则直接返回
        if (map?.setup && map.setup.enable === false) {
            log.debug(`[*]插件${pluginName}已经是禁用状态，无需再次禁用`);
            return `[+]插件${pluginName}已经是禁用状态`;
        }
        
        try {
            // 1. 立即禁用插件状态，防止新的事件触发
            if (map?.setup) {
                map.setup.enable = false;
            }

            // 2. 清理事件监听器
            if (map?.setup?.listeners?.length > 0) {
                for (const listener of map.setup.listeners) {
                    try {
                        if (listener && typeof listener.fn === 'function') {
                            this.bot.off(listener.event, listener.fn);
                            log.debug(`[+]插件${pluginName}注销事件: ${listener.event}`);
                        }
                        // 清除函数引用
                        listener.fn = null;
                    } catch (err) {
                        ErrorHandler.logError(pluginName, 'event_cleanup', err);
                        log.error(`[-]插件${pluginName}注销事件失败: ${ErrorHandler.formatError(err)}`);
                    }
                }
                // 彻底清空监听器和定时任务数组，避免内存泄漏
                map.setup.listeners.length = 0;
                map.setup.listeners.splice(0);
                map.setup.cron.length = 0;
                map.setup.cron.splice(0);
            } else {
                // 若插件状态不明确，强制设置为禁用
                if (map?.setup) {
                    map.setup.enable = false;
                }
            }

            // 3. 清理模块缓存
            try {
                this.cleanPluginModuleCache(pluginName);
            } catch (error) {
                ErrorHandler.logError(pluginName, 'cache_cleanup', error);
                log.warn(`[!]清理插件${pluginName}模块缓存失败: ${ErrorHandler.formatError(error)}`);
            }

            // 4. 从插件管理器中移除插件
            this.plugins.delete(pluginName);
            
            // 5. 更新配置文件
            try {
                this.saveConfig(pluginName, false);
            } catch (error: any) { // 添加类型注解
                // 配置保存失败但插件在内存中已禁用，记录错误并继续
                log.error(`[-]保存配置失败，但插件${pluginName}已在内存中禁用: ${error}`);
                return `[+]插件${pluginName}已在内存中禁用，但配置保存失败: ${error.message || String(error)}`;
            }
            
            // 6. 清理旧的错误日志
            ErrorHandler.cleanOldLogs();
            
            // 清理插件上下文代理，释放内存
            if (this.pluginCtxProxies.has(pluginName)) {
                this.pluginCtxProxies.delete(pluginName);
                log.debug(`[*]已释放插件 ${pluginName} 的上下文代理`);
            }
            
            // 清理插件专用的错误处理函数缓存
            if (this.pluginErrorHandlers.has(pluginName)) {
                this.pluginErrorHandlers.delete(pluginName);
                log.debug(`[*]已清理插件 ${pluginName} 的函数错误处理缓存`);
            }
            
            // 从任务池中移除该插件的所有定时任务
            if (this.cronTaskPool.has(pluginName)) {
                const tasks = this.cronTaskPool.get(pluginName);
                if (Array.isArray(tasks)) {
                    for (const task of tasks) {
                        if (task && typeof task.stop === 'function') {
                            try {
                                task.stop();
                            } catch (error) {
                                log.error(`[-]停止插件${pluginName}的缓存定时任务失败: ${error}`);
                            }
                        }
                    }
                }
                this.cronTaskPool.delete(pluginName);
                log.debug(`[*]已清理插件 ${pluginName} 的定时任务池`);
            }
            
            // 完全释放插件资源
            this.releasePluginResources(pluginName);
            
            return `[+]插件${pluginName}已从内存中禁用`;
        } catch (error: any) {
            ErrorHandler.logError(pluginName, 'plugin_disable', error);
            log.error(`[-]禁用插件${pluginName}失败: ${ErrorHandler.formatError(error)}`);
            return `[-]禁用插件${pluginName}失败: ${error.message || String(error)}`;
        }
    }

    onPlugin(pluginName: string) {
        const map = this.plugins.get(pluginName) as PluginInfo;
        if (!this.plugins.has(pluginName)) {
            return "[-]该插件不存在";
        }
        
        // 检查插件状态
        if (!map || !map.setup) {
            return "[-]插件状态无效";
        }
        
        // 如果插件已经启用，返回提示信息
        if (map.setup.enable === true) {
            log.debug(`[*]插件${pluginName}已经处于启用状态`);
            return `[*]插件${pluginName}已经处于启用状态`;
        }

        try {
            // 1. 注册事件监听器
            if (map.setup.listeners?.length > 0) {
                for (const listener of map.setup.listeners) {
                    try {
                        if (listener && typeof listener.fn === 'function') {
                            this.bot.on(listener.event, listener.fn);
                            log.debug(`[+]插件${pluginName}注册事件: ${listener.event}`);
                        }
                    } catch (err) {
                        log.error(`[-]插件${pluginName}注册事件${listener.event}失败: ${err}`);
                    }
                }
            }
            
            // 2. 启动定时任务 - 修改此部分以正确启动任务
            if (map.setup.cron?.length > 0) {
                for (const job of map.setup.cron) {
                    if (!job) {
                        log.error(`[-]插件${pluginName}的定时任务无效, 请检查cron表达式`);
                        continue;
                    }
                    try {
                        if (typeof job.start === 'function') {
                            job.start();
                            log.debug(`[+]插件${pluginName}启动定时任务`);
                        }
                    } catch (err) {
                        log.error(`[-]插件${pluginName}启动定时任务失败: ${err}`);
                    }
                }
            }
            
            // 3. 设置启用状态
            map.setup.enable = true;
            
            // 4. 保存配置
            try {
                this.saveConfig(pluginName, true);
            } catch (error: any) { // 添加类型注解
                log.error(`[-]插件${pluginName}配置保存失败，但插件已在内存中启用: ${error}`);
                return `[+]插件${pluginName}已在内存中启用，但配置保存失败: ${error.message || String(error)}`;
            }
            
            log.info(`[+]插件${pluginName}已成功启用`);
            
            // 从任务池中恢复该插件的所有任务
            if (this.cronTaskPool.has(pluginName)) {
                const tasks = this.cronTaskPool.get(pluginName);
                if (Array.isArray(tasks)) {
                    for (const task of tasks) {
                        if (task && typeof task.start === 'function') {
                            try {
                                task.start();
                                log.debug(`[+]恢复插件${pluginName}的缓存定时任务`);
                            } catch (error) {
                                log.error(`[-]恢复插件${pluginName}的缓存定时任务失败: ${error}`);
                            }
                        }
                    }
                }
            }
            
            return `[+]插件${pluginName}已启用`;
        } catch (error: any) {
            // 如果启用过程中出错，尝试回滚
            try {
                this.offPlugin(pluginName);
            } catch (rollbackError) {
                log.error(`[-]插件${pluginName}启用失败后回滚也失败: ${rollbackError}`);
            }
            
            log.error(`[-]启用插件${pluginName}失败: ${error}`);
            return `[-]启用插件${pluginName}失败: ${error.message || String(error)}`;
        }
    }

    async reloadPlugin(pluginName: string): Promise<any> {
        try {
            // 1. 检查插件是否存在
            if (!this.plugins.has(pluginName)) {
                log.warn(`[!]插件${pluginName}不存在，将尝试作为新插件加载`);
                const result = await this.loadPlugin(pluginName);
                return result ? true : `[-]插件${pluginName}加载失败`;
            }
            
            const map = this.plugins.get(pluginName) as PluginInfo;
            const wasEnabled = map?.setup?.enable || false;
            
            // 2. 验证插件文件
            const pluginDir = join(process.cwd(), "plugins");
            // 优先检查JS文件（编译后的文件）再检查TS文件
            // 检查子目录中的插件文件
            const subDirJsPath = join(pluginDir, pluginName, "index.js");
            const subDirTsPath = join(pluginDir, pluginName, "index.ts");
            // 检查直接的插件文件
            const directJsPath = join(pluginDir, `${pluginName}.js`);
            const directTsPath = join(pluginDir, `${pluginName}.ts`);

            // 检查插件是否存在
            if (!existsSync(subDirJsPath) && !existsSync(subDirTsPath) && 
                !existsSync(directJsPath) && !existsSync(directTsPath)) {
                return `[-]插件${pluginName}文件不存在，无法重载`;
            }
            
            log.info(`[*]开始重载插件 ${pluginName}...`);
            
            // 3. 禁用并清理插件
            if (wasEnabled) {
                log.info(`[*]插件${pluginName}处于启用状态，执行完整清理`);
                await Promise.resolve(this.offPlugin(pluginName));
            } else {
                log.info(`[*]插件${pluginName}处于禁用状态，执行基本清理`);
                this.plugins.delete(pluginName);
            }
            
            // 4. 确保插件完全移除
            if (this.plugins.has(pluginName)) {
                log.warn(`[!]插件${pluginName}仍在插件列表中，强制移除`);
                this.plugins.delete(pluginName);
            }
            
            // 5. 清理插件模块缓存
            this.cleanPluginModuleCache(pluginName);
            
            // 清理插件上下文代理
            if (this.pluginCtxProxies.has(pluginName)) {
                this.pluginCtxProxies.delete(pluginName);
                log.debug(`[*]已释放插件 ${pluginName} 的上下文代理，准备重新加载`);
            }
            
            // 6. 等待资源释放（使用较短的延时）
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // 7. 重新加载插件
            log.info(`[*]正在加载插件 ${pluginName}...`);
            const result = await this.loadPlugin(pluginName);
            
            if (!result) {
                log.error(`[-]插件${pluginName}重载失败，加载错误`);
                return false;
            }
            
            // 8. 如果之前是启用状态，重新启用
            if (wasEnabled) {
                log.info(`[*]恢复插件${pluginName}的启用状态`);
                const currentPlugin = this.plugins.get(pluginName);
                if (!currentPlugin) {
                    log.warn(`[!]找不到插件${pluginName}，无法启用`);
                    return false;
                }
                
                if (!currentPlugin.setup.enable) {
                    currentPlugin.setup.enable = true;
                    this.saveConfig(pluginName, true);
                    log.info(`[+]插件${pluginName}已手动启用`);
                }
            }
            
            log.info(`[+]插件 ${pluginName} 重载成功`);
            return true;
        } catch (error) {
            ErrorHandler.logError(pluginName, 'plugin_reload', error);
            log.error(`[-]重载插件${pluginName}时发生错误: ${ErrorHandler.formatError(error)}`);
            return false;
        }
    }

    private cleanPluginModuleCache(pluginName: string): void {
        try {
            // 修改插件路径查找逻辑，匹配loadPlugin方法中的更改
            const pluginDir = join(process.cwd(), "plugins");
            // 优先检查JS文件（编译后的文件）再检查TS文件
            // 检查子目录中的插件文件
            const subDirJsPath = join(pluginDir, pluginName, "index.js");
            const subDirTsPath = join(pluginDir, pluginName, "index.ts");
            // 检查直接的插件文件
            const directJsPath = join(pluginDir, `${pluginName}.js`);
            const directTsPath = join(pluginDir, `${pluginName}.ts`);

            // 确定实际使用的路径
            let pluginPath = '';
            if (existsSync(subDirJsPath)) {
                pluginPath = subDirJsPath;
            } else if (existsSync(subDirTsPath)) {
                pluginPath = subDirTsPath;
            } else if (existsSync(directJsPath)) {
                pluginPath = directJsPath;
            } else if (existsSync(directTsPath)) {
                pluginPath = directTsPath;
            }
            
            // 清除 jiti 创建的模块缓存
            if (this.jiti && this.jiti.cache) {
                Object.keys(this.jiti.cache).forEach(key => {
                    if (key.includes(pluginName)) {
                        delete this.jiti.cache[key];
                        log.debug(`[*]清理jiti缓存: ${key}`);
                    }
                });
            }
            
            log.info(`[+]已清理插件 ${pluginName} 的模块缓存`);
        } catch (error) {
            ErrorHandler.logError(pluginName, 'module_cache_cleanup', error);
            log.warn(`[!]清理插件${pluginName}模块缓存失败: ${ErrorHandler.formatError(error)}`);
        }
    }

    /**
     * 释放插件相关的所有资源
     * @param pluginName 插件名称
     */
    private releasePluginResources(pluginName: string): void {
        try {
            // 清理插件上下文代理
            this.pluginCtxProxies.delete(pluginName);
            
            // 清理插件错误处理器
            this.pluginErrorHandlers.delete(pluginName);
            
            // 清理模块缓存
            this.cleanPluginModuleCache(pluginName);
            
            log.debug(`[*]内存优化：完全释放插件 ${pluginName} 的资源`);
        } catch (error) {
            log.error(`释放插件 ${pluginName} 资源时出错:`, error);
        }
    }
    
    /**
     * 启动内存监控
     */
    private startMemoryMonitoring(): void {
        if (this.memoryCheckInterval) {
            clearInterval(this.memoryCheckInterval);
        }
        
        this.memoryCheckInterval = setInterval(() => {
            this.checkMemoryUsage();
        }, PluginManager.MEMORY_CHECK_INTERVAL);
        
        // 确保在实例销毁时清理定时器
        process.on('exit', () => {
            if (this.memoryCheckInterval) {
                clearInterval(this.memoryCheckInterval);
            }
        });
    }
    
    /**
     * 检查内存使用情况
     */
    private checkMemoryUsage(): void {
        try {
            const memoryUsage = process.memoryUsage();
            const heapUsed = memoryUsage.heapUsed / memoryUsage.heapTotal;
            
            // 记录内存使用情况
            log.debug(`[*]内存使用情况: ${Math.round(heapUsed * 100)}% (${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB)`);
            
            // 根据内存使用率采取不同措施
            if (heapUsed >= PluginManager.MEMORY_CRITICAL_THRESHOLD) {
                log.warn(`[!]内存使用率过高(${Math.round(heapUsed * 100)}%)，执行紧急清理...`);
                this.emergencyMemoryCleanup();
            } else if (heapUsed >= PluginManager.MEMORY_WARNING_THRESHOLD) {
                log.warn(`[!]内存使用率较高(${Math.round(heapUsed * 100)}%)，建议检查内存泄漏`);
                this.normalMemoryCleanup();
            }
        } catch (error) {
            log.error(`[-]内存检查失败: ${error}`);
        }
    }
    
    /**
     * 常规内存清理
     */
    private normalMemoryCleanup(): void {
        try {
            // 清理过期的插件上下文代理
            this.cleanupPluginContexts();
            
            // 清理错误日志
            ErrorHandler.cleanOldLogs();
            
            // 清理未使用的定时任务
            this.cleanupUnusedCronTasks();
            
            // 建议启用内存优化模式
            ErrorHandler.setMemoryOptimizedMode(true);
            
            log.info('[*]已完成常规内存清理');
        } catch (error) {
            log.error(`[-]常规内存清理失败: ${error}`);
        }
    }
    
    /**
     * 紧急内存清理
     */
    private emergencyMemoryCleanup(): void {
        try {
            // 执行更激进的内存清理
            this.normalMemoryCleanup();
            
            // 清理所有插件上下文代理
            this.pluginCtxProxies.clear();
            
            // 清理所有错误处理函数缓存
            this.pluginErrorHandlers.clear();
            
            // 清理所有定时任务
            this.cleanupAllCronTasks();
            
            // 强制垃圾回收
            if (global.gc) {
                global.gc();
                log.info('[*]已执行强制垃圾回收');
            }
            
            log.warn('[!]已完成紧急内存清理');
        } catch (error) {
            log.error(`[-]紧急内存清理失败: ${error}`);
        }
    }
    
    /**
     * 清理过期的插件上下文代理
     */
    private cleanupPluginContexts(): void {
        const now = Date.now();
        for (const [pluginName, proxy] of this.pluginCtxProxies) {
            const pluginInfo = this.plugins.get(pluginName);
            // 如果插件不存在或已禁用超过1小时，清理其上下文代理
            if (!pluginInfo || (!pluginInfo.setup.enable && now - (pluginInfo.lastUsed || 0) > 3600000)) {
                this.pluginCtxProxies.delete(pluginName);
                log.debug(`[*]已清理插件 ${pluginName} 的上下文代理`);
            }
        }
    }
    
    /**
     * 清理未使用的定时任务
     */
    private cleanupUnusedCronTasks(): void {
        for (const [pluginName, tasks] of this.cronTaskPool) {
            const pluginInfo = this.plugins.get(pluginName);
            // 如果插件不存在或已禁用，清理其定时任务
            if (!pluginInfo || !pluginInfo.setup.enable) {
                this.cleanupPluginCronTasks(pluginName);
            }
        }
    }
    
    /**
     * 清理所有定时任务
     */
    private cleanupAllCronTasks(): void {
        for (const [pluginName] of this.cronTaskPool) {
            this.cleanupPluginCronTasks(pluginName);
        }
        this.cronTaskPool.clear();
    }
    
    /**
     * 清理指定插件的定时任务
     */
    private cleanupPluginCronTasks(pluginName: string): void {
        const tasks = this.cronTaskPool.get(pluginName);
        if (tasks) {
            for (const task of tasks) {
                if (task && typeof task.stop === 'function') {
                    try {
                        task.stop();
                    } catch (error) {
                        log.error(`[-]停止插件 ${pluginName} 的定时任务失败: ${error}`);
                    }
                }
            }
            this.cronTaskPool.delete(pluginName);
            log.debug(`[*]已清理插件 ${pluginName} 的定时任务`);
        }
    }
}