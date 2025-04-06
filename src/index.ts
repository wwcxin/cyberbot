import type {AllHandlers, Send} from "node-napcat-ts";
import {NCWebsocket, Structs} from "node-napcat-ts";
import {join} from "path";
import {existsSync, readFileSync, writeFileSync} from "fs";
import TOML from '@iarna/toml';
import axios from "axios";
import {createJiti} from "jiti"
import {readdirSync} from "node:fs";
import { createHash } from 'crypto';
// @ts-ignore
import * as cron from "node-cron";
// 导入日志模块

import { initLogger } from "./logger.js";

export { Structs, Send, NCWebsocket, AllHandlers, CyberPluginContext, axios as http }

// Config
export function getConfig(): Config {
    const configPath = join(process.cwd(), "config.toml")
    if (!existsSync(configPath)) {
        throw new Error("Config file not found. Please create a config.toml file in the project root directory.")
    }
    const parsed = TOML.parse(readFileSync(configPath, "utf-8")) as any
    return {
        napcat: {
            baseUrl: parsed.napcat.baseUrl,
            accessToken: parsed.napcat.accessToken,
            throwPromise: parsed.napcat.throwPromise,
            reconnection: parsed.napcat.reconnection,
            debug: parsed.napcat.debug
        },
        self: {
            uin: parsed.self.bot,
            master: parsed.self.master,
            admins: parsed.self.admins || [],
            bot_uin: parsed.self.bot
        },
        plugins: {
            system: parsed.plugins?.system || [],
            user: parsed.plugins?.user || []
        },
        logger: {
            level: parsed.logger?.level || 'info',
            maxSize: parsed.logger?.maxSize || '10m',
            maxDays: parsed.logger?.maxDays || 7
        }
    }
}

export interface Config {
    napcat: {
        baseUrl: string,
        accessToken: string,
        throwPromise: boolean,
        reconnection: {
            enable: boolean,
            attempts: number,
            delay: number
        },
        debug: boolean
    },
    self: {
        uin: number,
        master: Array<number>,
        admins: Array<number>,
        bot_uin: number
    },
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
// 获取配置
const config = getConfig();

// 初始化日志系统
export const log = initLogger(config);

export class Bot {
    private bot: NCWebsocket;
    private config: Config;
    private pluginManager: PluginManager;
    private plugins: {} | null;


    constructor() {
        this.config = getConfig();
        this.bot = new NCWebsocket({
            "baseUrl": this.config.napcat.baseUrl,
            "accessToken": this.config.napcat.accessToken,
            "reconnection": {
                "enable": this.config.napcat.reconnection.enable,
                "attempts": this.config.napcat.reconnection.attempts,
                "delay": this.config.napcat.reconnection.delay
            }
        }, this.config.napcat.debug);
        this.pluginManager = new PluginManager(this.bot, this.config);
        this.plugins = null;
    }

    async start() {

        this.bot.on("socket.open", (ctx) => {
            log.info("[*]开始连接: " + this.config.napcat.baseUrl)
        })
        this.bot.on("socket.error", (ctx) => {
            log.error("[-]websocket 连接错误: " + ctx.error_type)
        })
        this.bot.on("socket.close", (ctx) => {
            log.error("[-]websocket 连接关闭: " + ctx.code)
        })
        this.bot.on("meta_event.lifecycle", (ctx) => {
            if (ctx.sub_type == "connect") {
                log.info(`[+]连接成功: ${this.config.napcat.baseUrl}`)
                log.info(logo)
            }
        })
        this.bot.on("meta_event.heartbeat", (ctx) => {
            log.info(`[*]心跳包♥`)
        })
        this.bot.on("message", (ctx) => {
            log.info("[*]receive message: " + ctx.raw_message)
        })
        this.bot.on("api.response.failure", (ctx) => {
            log.error(`[-]ApiError, status: ${ctx.status}, message: ${ctx.message}`)
        })
        this.bot.on("api.preSend", (ctx) => {
            log.info(`[*]${ctx.action}: ${JSON.stringify(ctx.params)}`)
        })
        this.plugins = await this.pluginManager.init()
        await this.bot.connect()
        
        // 在连接成功并加载插件后向主人发送上线通知
        this.sendOnlineNotificationToMasters();
    }
    
    /**
     * 向所有主人发送机器人上线通知
     */
    private async sendOnlineNotificationToMasters() {
        // 等待短暂时间确保连接稳定
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        this.config.self.master.forEach(async (masterId) => {
            try {
                // 获取插件信息，确保plugins是Map类型
                let pluginCount = 0;
                let totalPlugins = 0;
                
                if (this.pluginManager && this.pluginManager.plugins instanceof Map) {
                    const plugins = this.pluginManager.plugins;
                    pluginCount = Array.from(plugins.values()).filter(info => info.setup && info.setup.enable).length;
                    totalPlugins = plugins.size;
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
    }
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

// 定义基础消息事件类型
export interface BaseMessageEvent {
    raw_message: string;
    message_id: number;
    user_id: number;
    message_type: 'private' | 'group';
    sender: {
        user_id: number;
    };
}

// 定义群消息事件类型
export interface GroupMessageEvent extends BaseMessageEvent {
    message_type: 'group';
    group_id: number;
}

// 定义私聊消息事件类型
export interface PrivateMessageEvent extends BaseMessageEvent {
    message_type: 'private';
}

// 联合类型，用于实际使用
export type MessageEvent = GroupMessageEvent | PrivateMessageEvent;

// 机器人消息事件类型
export type CyberMessageEvent = AllHandlers['message'] & ExtendedEvent;

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
        cronTasks: string | Array<[string, (ctx: CyberPluginContext, e: MessageEvent & ExtendedEvent) => any]>,
        func?: () => any
    ) => any;
    /** 注册事件处理器 */
    handle: <EventName extends keyof AllHandlers>(
        eventName: EventName,
        handler: EventName extends "message" | "message.group" | "message.private"
            ? (e: CyberMessageEvent) => any 
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
    hasRight: (user_id: number) => boolean;
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
     * @param group_id - 群ID。
     * @param user_id - 用户的ID。
     * @returns 如果用户是群组管理员或群主，则返回 `true`，否则返回 `false`。
     * @throws - 如果获取群组成员信息失败，抛出错误。
     */
    isGroupAdmin: (group_id: number, user_id: number) => Promise<boolean>;
    /**
     * 检查用户是否是群组群主。
     * 
     * @param group_id - 群ID。
     * @param user_id - 用户的ID。
     * @returns 如果用户是群组群主，则返回 `true`，否则返回 `false`。
     * @throws - 如果获取群组成员信息失败，抛出错误。
     */
    isGroupOwner: (group_id: number, user_id: number) => Promise<boolean>;
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
     * @param raw_message 原始消息
     * @return 图片链接
     */
    getImageLink: (raw_message: string) => string;
    /**
     * 替换 URL 中的 rkey 参数, 获取直链
     * @param url - 原始 URL
     * @returns 替换 rkey 后的新 URL
     */
    getDirectLink: (url: string) => Promise<string>;
    /**
     * 从消息内容中提取回复消息的ID。
     * 该方法使用正则表达式从传入的 `raw_message` 中提取 `[CQ:reply,id=...]` 格式的回复消息ID。
     * 如果找到回复消息ID，则返回该ID；否则，返回空字符串。
     * 
     * @param raw_message - 包含回复消息信息的原始消息字符串。
     * @returns 提取的回复消息ID字符串，如果未找到则返回空字符串。
     * @throws 如果在提取过程中发生错误，记录错误日志并返回空字符串。
     */
    getMessageId: (raw_message: string) => string;
    /**
     * 从消息内容中提取 @ 消息的 ID。
     * 该方法使用正则表达式从传入的 `raw_message` 中提取 `[CQ:at,qq=...]` 格式的 @ 消息ID。
     * 如果找到 @ 消息ID，则返回该ID；否则，返回空字符串。
     * 
     * @param raw_message - 包含 @ 消息信息的原始消息字符串。
     * @returns 提取的 @ 消息ID字符串，如果未找到则返回空字符串。
     * @throws 如果在提取过程中发生错误，记录错误日志并返回空字符串。
     */
    getMessageAt: (raw_message: string) => number[];
    /**
     * 从消息内容中提取纯文本内容。
     * 该方法使用正则表达式从传入的 `raw_message` 中移除所有的 CQ 码，并返回剩余的纯文本内容。
     * 
     * @param raw_message - 包含 CQ 码的原始消息字符串。
     * @returns 提取的纯文本内容字符串。
     * @throws 如果在提取过程中发生错误，记录错误日志并抛出错误。
     */
    getText: (raw_message: string) => string;
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


export class PluginManager {
    public plugins: Map<string, PluginInfo>;
    public bot: NCWebsocket;
    public ctx: CyberPluginContext;
    private tempListener: Array<listener>;
    private tempCronJob: Array<any>;
    private jiti: any;

    constructor(bot: NCWebsocket, config: Config) {
        this.plugins = new Map<string, PluginInfo>();
        // @ts-ignore
        this.jiti = createJiti(import.meta.url, {moduleCache: false})
        this.bot = bot;
        this.tempListener = [];
        this.tempCronJob = [];
        this.ctx = {
            config: config,
            http: axios,
            bot: this.bot,
            bot_uin: config.self.bot_uin,
            cron: (cronTasks, func) => {
                // 如果是数组格式，表示多个定时任务
                if (Array.isArray(cronTasks)) {
                    for (const [cronExpression, callback] of cronTasks) {
                        if(!cron.validate(cronExpression)){
                            log.error(`[-]无效的 cron 表达式: ${cronExpression}`);
                            this.tempCronJob.push(false);
                            continue;
                        }
                        
                        // 创建一个包装函数，传入 ctx 和带有 reply 方法的事件对象
                        const wrappedCallback = () => {
                            // 创建一个基础的事件对象
                            const baseEvent: GroupMessageEvent = {
                                message_type: 'group',
                                raw_message: '',
                                message_id: 0,
                                user_id: 0,
                                group_id: 0,
                                sender: { user_id: 0 }
                            };
                            
                            // 添加 reply 方法
                            const eventWithReply = this.ctx.utils.addReplyMethod(baseEvent);
                            
                            // 调用回调函数，传入 ctx 和增强的事件对象
                            return callback(this.ctx, eventWithReply);
                        };
                        
                        this.tempCronJob.push(cron.schedule(cronExpression, wrappedCallback, {
                            scheduled: false
                        }));
                    }
                    return;
                }
                
                // 原有的字符串格式处理（单个定时任务）
                if(!cron.validate(cronTasks)){
                    log.error(`[-]无效的 cron 表达式: ${cronTasks}`);
                    this.tempCronJob.push(false);
                    return;
                }
                this.tempCronJob.push(cron.schedule(cronTasks, func!, {
                    scheduled: false
                }));
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
                ? (e: CyberMessageEvent) => any 
                : (e: AllHandlers[EventName] & ExtendedEvent) => any) => {
                const wrappedFunc = (e: any) => {
                    const extendedEvent = this.ctx.utils.addReplyMethod(e);
                    // @ts-ignore: 忽略复杂联合类型的错误
                    return func(extendedEvent);
                };
                
                const obj = {
                    event: eventName,
                    fn: wrappedFunc
                }
                this.tempListener.push(obj)
            },
            isMaster: (e) => {
                if (typeof e === 'number' && !isNaN(e)) {
                    return this.ctx.config.self.master.includes(e)
                }
                if (typeof e === 'object' && e.sender && typeof e.sender.user_id === 'number') {
                    return this.ctx.config.self.master.includes(e.sender.user_id);
                }
                return false;
            },
            isAdmin: (e) => {
                if (typeof e === 'number' && !isNaN(e)) {
                    return this.ctx.config.self.master.includes(e) || this.ctx.config.self.admins.includes(e)
                }
                if (typeof e === 'object' && e.sender && typeof e.sender.user_id === 'number') {
                    const userId = e.sender.user_id;
                    return this.ctx.config.self.master.includes(userId) || this.ctx.config.self.admins.includes(userId);
                }
                return false;
            },
            hasRight: (user_id: number) => {
                return this.ctx.isMaster(user_id) || this.ctx.isAdmin(user_id)
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
            isGroupAdmin: async (group_id: number, user_id: number): Promise<boolean> => {
                try{
                    const memberInfo = await this.bot.get_group_member_info({ group_id, user_id });
                    return memberInfo.role === 'admin' || memberInfo.role === 'owner';
                }catch(error){
                    log.error(`Failed to check if user ${user_id} is an admin in group ${group_id}: ${error}`); 
                    return false;
                }
            },
            isGroupOwner: async (group_id: number, user_id: number): Promise<boolean> => {
                try{
                    const memberInfo = await this.bot.get_group_member_info({ group_id, user_id });
                    return memberInfo.role === 'owner';
                }catch(error){
                    log.error(`Failed to check if user ${user_id} is an owner in group ${group_id}: ${error}`);
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
            getImageLink: (raw_message: string) => {
                try {
                    const imagePattern = /\[CQ:image,.*?url=(.*?),/g;
                    const match = imagePattern.exec(raw_message);
                    if (match && match[1]) {
                      return match[1];
                    } else {
                      log.warn('未找到图片链接');
                      return "";
                    }
                  } catch (error) {
                    log.error('提取图片链接时发生错误:', error);
                    return "";
                  }
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
            
            getMessageId: (raw_message: string) => {
                try {
                    const regex = /\[CQ:reply,id=(\d+)\]/;
                    const match = raw_message.match(regex);
                    if (match && match[1]) {
                      return match[1];
                    }
                    return "";
                  } catch (error) {
                    log.error('提取消息ID时发生错误:', error);
                    return "";
                  }
            },
            getMessageAt: (raw_message: string): number[] => {
                try {
                    const regex = /\[CQ:at,qq=(\d+)\]/g;
                    const matches = raw_message.matchAll(regex);
                    const qqs: number[] = [];
            
                    for (const match of matches) {
                        if (match[1]) {
                            qqs.push(Number(match[1]));
                        }
                    }
            
                    return qqs;
                } catch (error) {
                    log.error('提取消息ID时发生错误:', error);
                    return [];
                }
            },
            getText: (raw_message: string) => {
                try {
                    const cqCodePattern = /\[CQ:[^\]]+\]/g;
                    // 使用正则表达式替换 CQ 码为空字符串
                    return raw_message.replace(cqCodePattern, '').trim();
                } catch (error) {
                    log.error('提取纯文本内容时发生错误:', error);
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
            
            /** 工具函数 */
            utils: {
                addReplyMethod: <T extends any>(e: T): T & ExtendedEvent => {
                    // 如果已经有reply方法，直接返回
                    if ((e as any).reply) return e as T & ExtendedEvent;
                    
                    // 添加reply方法
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
                        if (quote && (e as any).message_id) {
                            processedMessages.unshift(Structs.reply((e as any).message_id));
                        }
                        
                        // 根据消息类型确定发送参数
                        const sendParams = (() => {
                            if ((e as any).message_type === 'group' || (e as any).group_id) {
                                return { group_id: (e as any).group_id };
                            } else if ((e as any).message_type === 'private' || (e as any).user_id) {
                                return { user_id: (e as any).user_id };
                            } else {
                                log.error(`Unsupported message type or missing ID`);
                                return { user_id: (e as any).user_id };
                            }
                        })();
                        
                        // 发送消息并返回结果
                        try {
                            log.info(`Sending message: ${JSON.stringify(processedMessages)}`);
                            const response = await this.bot.send_msg({
                                ...sendParams,
                                message: processedMessages
                            });
                            return { message_id: response.message_id };
                        } catch (error) {
                            log.error(`Failed to send message: ${error}`);
                        }
                    };
                    return e as T & ExtendedEvent;
                }
            }
        };
    }

    async init() {
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

        // 读取所有插件目录
        if (existsSync(pluginsPath)) {
            const allPlugins = readdirSync(pluginsPath);
            // 只添加实际存在的目录
            plugins.push(...allPlugins.filter(pluginName => {
                const pluginDir = join(pluginsPath, pluginName);
                return existsSync(pluginDir) && (
                    existsSync(join(pluginDir, "index.ts")) || 
                    existsSync(join(pluginDir, "index.js"))
                );
            }));
        }

        return plugins;
    }


    async loadPlugin(pluginName: string): Promise<any> {
        try {
            // 先尝试 .ts 文件，再尝试 .js 文件
            const tsPath = join(process.cwd(), "plugins", pluginName, "index.ts");
            const jsPath = join(process.cwd(), "plugins", pluginName, "index.js");
            
            let pluginPath = existsSync(tsPath) ? tsPath : jsPath;
            if (!existsSync(pluginPath)) {
                log.error(`[-]插件${pluginName}文件不存在`);
                return false;
            }
            
            const plugin = await this.jiti.import(pluginPath);
            if (!plugin || !plugin.default || typeof plugin.default.setup !== 'function') {
                log.error(`[-]插件${pluginName}格式不正确，缺少setup函数`);
                return false;
            }
            
            // 清空临时监听器和定时任务
            this.tempListener = [];
            this.tempCronJob = [];
            
            // 调用插件的setup函数
            plugin.default.setup(this.ctx);
            
            // 设置插件信息
            const pluginType = this.ctx.config.plugins.system.includes(pluginName) ? 'system' : 'user';
            this.plugins.set(plugin.default.name, {
                version: plugin.default.version || "0.1.0",
                description: plugin.default.description || "",
                type: pluginType,
                setup: {
                    enable: false,
                    listeners: this.tempListener,
                    cron: this.tempCronJob
                }
            });
            
            // 如果插件在配置文件中被启用，则自动启用它
            const enabledPlugins = pluginType === 'system' ? 
                this.ctx.config.plugins.system : 
                this.ctx.config.plugins.user;
                
            if (enabledPlugins.includes(plugin.default.name)) {
                log.info(this.onPlugin(plugin.default.name));
            }
            
            // 清空临时监听器和定时任务，防止影响下一个插件
            this.tempListener = [];
            this.tempCronJob = [];
            
            return plugin;
        } catch (err) {
            log.error(`[-]插件${pluginName}导入失败, 原因: ${err}`);
            return false;
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
            const configPath = join(process.cwd(), "config.toml");
            const config = TOML.parse(readFileSync(configPath, "utf-8")) as {
                plugins: { system: string[], user: string[] }
            };
            
            // 确保plugins部分存在
            if (!config.plugins) {
                config.plugins = { system: [], user: [] };
            }
            
            // 判断是系统插件还是用户插件
            const pluginInfo = this.plugins.get(pluginName);
            const pluginType = pluginInfo?.type || 'user';
            const targetArray = config.plugins[pluginType] || [];
            
            if (isEnabled && !targetArray.includes(pluginName)) {
                targetArray.push(pluginName);
            } else if (!isEnabled) {
                const index = targetArray.indexOf(pluginName);
                if (index > -1) {
                    targetArray.splice(index, 1);
                }
            }
            
            config.plugins[pluginType] = targetArray;
            
            // 保存回文件
            writeFileSync(configPath, TOML.stringify(config));
            log.info(`[+]配置文件已更新: ${pluginName} ${isEnabled ? '已启用' : '已禁用'}`);
        } catch (error) {
            log.error(`[-]保存配置文件失败: ${error}`);
        }
    }

    offPlugin(pluginName: string) {
        const map = this.plugins.get(pluginName) as PluginInfo;
        if (!this.plugins.has(pluginName)) {
            return "[-]该插件不存在";
        }
        
        try {
            // 1. 如果插件正在运行，先停止所有事件和定时任务
            if (map?.setup?.enable) {
                // 注销插件的事件监听器
                for (const p of map.setup.listeners) {
                    try {
                        this.bot.off(p.event, p.fn);
                        log.debug(`[+]插件${pluginName}注销事件: ${p.event}`);
                    } catch (err) {
                        log.error(`[-]插件${pluginName}注销事件${p.event}失败: ${err}`);
                    }
                }
                
                // 停止插件的定时任务
                for (const p of map.setup.cron) {
                    if (!p) continue;
                    try {
                        p.stop();
                        log.debug(`[+]插件${pluginName}停止定时任务`);
                    } catch (err) {
                        log.error(`[-]插件${pluginName}停止定时任务失败: ${err}`);
                    }
                }
            }
            
            // 2. 从插件管理器中移除插件引用
            this.plugins.delete(pluginName);
            
            // 3. 尝试清除 Node.js 模块缓存
            try {
                const pluginPaths = [
                    join(process.cwd(), "plugins", pluginName, "index.ts"),
                    join(process.cwd(), "plugins", pluginName, "index.js")
                ];
                
                for (const path of pluginPaths) {
                    // 清除该模块及其依赖的缓存
                    if (require.cache[path]) {
                        delete require.cache[path];
                        log.debug(`[+]已清除插件${pluginName}的模块缓存`);
                        
                        // 尝试递归清除所有相关模块缓存
                        const modulesToDelete = Object.keys(require.cache).filter(
                            modulePath => modulePath.includes(`/plugins/${pluginName}/`)
                        );
                        
                        modulesToDelete.forEach(modulePath => {
                            delete require.cache[modulePath];
                        });
                        
                        if (modulesToDelete.length > 0) {
                            log.debug(`[+]已清除插件${pluginName}相关的${modulesToDelete.length}个模块缓存`);
                        }
                    }
                }
            } catch (error) {
                log.warn(`[!]清除插件${pluginName}模块缓存失败: ${error}`);
            }
            
            // 4. 从配置文件中移除该插件
            this.saveConfig(pluginName, false);
            
            // 5. 尝试主动触发垃圾回收（仅在非生产环境，因为这可能影响性能）
            if (process.env.NODE_ENV !== 'production' && global.gc) {
                try {
                    global.gc();
                    log.debug('[+]已触发垃圾回收');
                } catch (e) {
                    // 忽略错误
                }
            }
            
            return `[+]插件${pluginName}已从内存中禁用`;
        } catch (error: any) {
            log.error(`[-]禁用插件${pluginName}失败: ${error}`);
            return `[-]禁用插件${pluginName}失败: ${error.message || "未知错误"}`;
        }
    }

    onPlugin(pluginName: string) {
        const map = this.plugins.get(pluginName) as PluginInfo;
        if (!this.plugins.has(pluginName)) {
            return "[-]该插件不存在";
        }
        if (map?.setup && map.setup?.enable) {
            return "[-]该插件没有被禁用";
        }
        
        // 注册插件的事件监听器
        for (const p of map.setup.listeners) {
            try {
                this.bot.on(p.event, p.fn);
                log.debug(`[+]插件${pluginName}注册事件: ${p.event}`);
            } catch (err) {
                log.error(`[-]插件${pluginName}注册事件${p.event}失败: ${err}`);
            }
        }
        
        // 启动插件的定时任务
        for (const p of map.setup.cron) {
            if (!p) {
                log.error(`[-]插件${pluginName}的定时任务启动出错, 请检查一下cron表达式`);
                continue;
            }
            try {
                p.start();
                log.debug(`[+]插件${pluginName}启动定时任务`);
            } catch (err) {
                log.error(`[-]插件${pluginName}启动定时任务失败: ${err}`);
            }
        }
        
        map.setup.enable = true;
        // 保存配置
        this.saveConfig(pluginName, true);
        return `[+]插件${pluginName}已启用`;
    }

    async reloadPlugin(pluginName: string): Promise<any> {
        try {
            if (!this.plugins.has(pluginName)) {
                return "[-]该插件不存在";
            }
            
            const map = this.plugins.get(pluginName) as PluginInfo;
            const wasEnabled = map?.setup?.enable || false;
            
            // 保存插件路径，防止在offPlugin后找不到
            const pluginDir = join(process.cwd(), "plugins", pluginName);
            const hasTsFile = existsSync(join(pluginDir, "index.ts"));
            const hasJsFile = existsSync(join(pluginDir, "index.js"));
            
            if (!existsSync(pluginDir) || (!hasTsFile && !hasJsFile)) {
                return `[-]插件${pluginName}文件不存在，无法重载`;
            }
            
            // 1. 先禁用插件
            if (wasEnabled) {
                log.info(this.offPlugin(pluginName));
            } else {
                // 即使没启用，也需要从列表中删除以便重新加载
                this.plugins.delete(pluginName);
            }
            
            // 2. 重新加载插件
            const result = await this.loadPlugin(pluginName);
            if (!result) {
                log.error(`[-]插件 ${pluginName} 重载失败`);
                return false;
            }
            
            // 3. 如果之前是启用状态，则重新启用
            if (wasEnabled) {
                log.info(this.onPlugin(pluginName));
            }
            
            log.info(`[+]插件 ${pluginName} 重载成功`);
            return true;
        } catch (error: any) {
            log.error(`[-]插件 ${pluginName} 重载失败: ${error}`);
            return false;
        }
    }
}

