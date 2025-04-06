/***
 * @author: @星火
 * @description: 
 * 本文件是机器人框架的核心命令插件，负责处理所有与机器人命令相关的逻辑。此插件不可删除，因为它是控制和管理机器人的基础。
 * 
 * 主要功能：
 * - 提供管理员权限验证机制，确保只有授权用户可以执行敏感操作。
 * - 实现了对插件的启停、禁用及重新加载等命令的支持，通过解析用户输入的命令参数来动态调整配置。
 * - 提供详细的错误处理机制，确保在命令执行失败时能够及时反馈给用户。
 * - 提供对插件的安装、卸载、更新等命令的支持，通过解析用户输入的命令参数来动态调整配置。
 */
import {join} from "path";
import {existsSync} from "fs";
import {definePlugin,NCWebsocket,AllHandlers} from "../../src/index.js";
import {exec} from "child_process";
import {promisify} from "util";
import * as os from 'os'
import * as fs from 'fs';

const execAsync = promisify(exec);

interface PluginInfo {
    version: string;
    description: string;
    type: 'system' | 'user';
    setup: {
        enable: boolean;
        listeners: Array<{
            event: keyof AllHandlers;
            fn: any;
        }>;
        cron: Array<any>;
    };
}

interface CommandContext {
    plugin: {
        getPlugins: () => Map<string, PluginInfo>;
        onPlugin: (pluginName: string) => string;
        offPlugin: (pluginName: string) => string;
        reloadPlugin: (pluginName: string) => Promise<any>;
        loadPlugin: (pluginName: string) => Promise<any>;
        getPluginsFromDir: () => string[];
    };
    isMaster: (e: any) => boolean;
    config: {
        self: {
            master: number[];
            admins: number[];
        };
        plugins: {
            system?: string[];
            user?: string[];
        };
    };
    bot: NCWebsocket;
}

interface CommandEvent {
    raw_message: string;
    reply: (message: string) => Promise<{ message_id: number }>;
}

interface CommandHandler {
    handler?: (ctx: CommandContext, e: CommandEvent, args: string[]) => Promise<{ message_id: number } | void>;
    subcommands?: {
        [key: string]: (ctx: CommandContext, e: CommandEvent, args: string[]) => Promise<{ message_id: number } | void>;
    };
    help?: string;
}

// 定义一个接口来描述硬盘信息的结构
interface DiskInfo {
    total: number;
    used: number;
    available: number;
  }

const commands: { [key: string]: CommandHandler } = {
    "关于": {
        handler: async (ctx, e) => {
            return await e.reply("〓  🚀  CyberBot〓\n新一代QQ机器人框架\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n✦ 核心特性 ✦\n├─ 🪶 极简轻量：不依赖复杂环境，安装即用\n├─ 🎨 优雅架构：TypeScript 全栈开发，类型安全\n├─ 🧩 热插拔插件：模块化设计，功能扩展无忧\n├─ ⚡ 性能怪兽：基于 Node.js 事件驱动模型\n├─ 🌐 跨平台支持：Windows/Linux/macOS 全兼容\n\n✦ 技术架构 ✦\n└─ 🔧 底层协议：NapcatQQ 核心驱动\n└─ 🧬 开发框架：node-napcat-ts 深度整合\n└─ 📦 生态支持：npm 海量模块即插即用\n\n✦ 开发者友好 ✦\n💡 完善文档 + 示例项目 = 1分钟快速上手\n💎 支持插件市场机制，共享机器人能力\n🛠️ 提供cli工具链，创建/调试/打包一气呵成\n\n✨ 开源协议：MIT License，欢迎贡献代码！");
        }
    },
    "状态": {
        handler: async (ctx, e) => {
            try {
                const plugins = ctx.plugin.getPlugins();
                const values = Array.from(plugins.values());
                const enabledCount = values.filter(info => info?.setup?.enable ?? false).length;
                // 获取所有可用插件数量
                const totalAvailablePlugins = ctx.plugin.getPluginsFromDir().length;
                // 框架版本信息
                let ver_info = { app_name: "CyberBot", protocol_version: "Unknown", app_version: "Unknown" };
                try {
                    // 使用NCWebsocket的get_version_info方法
                    const versionInfo = await ctx.bot.get_version_info();
                    ver_info = {
                        app_name: versionInfo.app_name || "CyberBot",
                        protocol_version: versionInfo.protocol_version || "Unknown",
                        app_version: versionInfo.app_version || "Unknown"
                    };
                } catch (err) {
                    console.error("获取版本信息失败:", err);
                }
                
                // 获取登录QQ信息
                let login_qq = { nickname: "Unknown", user_id: "Unknown" };
                try {
                    // 使用NCWebsocket的get_login_info方法
                    const loginInfo = await ctx.bot.get_login_info();
                    login_qq = {
                        nickname: loginInfo.nickname || "Unknown",
                        user_id: String(loginInfo.user_id) || "Unknown"
                    };
                } catch (err) {
                    console.error("获取登录信息失败:", err);
                }
                
                // 获取好友列表
                let friend_list: any[] = [];
                try {
                    // 使用NCWebsocket的get_friend_list方法
                    friend_list = await ctx.bot.get_friend_list();
                } catch (err) {
                    console.error("获取好友列表失败:", err);
                }
                
                // 获取群列表
                let group_list: any[] = [];
                try {
                    // 使用NCWebsocket的get_group_list方法
                    group_list = await ctx.bot.get_group_list();
                } catch (err) {
                    console.error("获取群列表失败:", err);
                }
                // 内存使用情况
                const memoryUsage = process.memoryUsage();
                const totalMemory = os.totalmem();
                const freeMemory = os.freemem();
                // nodejs版本信息
                const nodeVersion = process.version;
                // 平台信息
                const platform = os.platform() === 'win32' ? 'Windows' : os.platform();
                const arch = os.arch();
                // 运行时间信息
                const uptimeSeconds = process.uptime();
                const days = Math.floor(uptimeSeconds / (24 * 3600));
                const hours = Math.floor((uptimeSeconds % (24 * 3600)) / 3600);
                const minutes = Math.floor((uptimeSeconds % 3600) / 60);
                const seconds = Math.floor(uptimeSeconds % 60);
                const formattedTime = `${days}d ${hours}h ${minutes}m ${seconds}s`;
                // 插件数量
                const status = '〓 🟢 Bot 状态 〓';
                
                // 硬盘信息
                const { total, used } = await getDiskInfo();
                
                await e.reply(
                    `${status}\n` +
                    `🤖 CyberBot(${login_qq.nickname})\n` +
                    `❄ ${login_qq.user_id}\n` +
                    `🧩 插件${enabledCount}/${totalAvailablePlugins}个已启用\n` +
                    `🕦 ${formattedTime}\n` +
                    `📋 ${friend_list.length}个好友，${group_list.length}个群\n` +
                    `🔷 ${ver_info.app_name}-${ver_info.protocol_version}-${ver_info.app_version}\n` +
                    `🚀 bot占用-${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB-${((memoryUsage.rss / totalMemory) * 100).toFixed(2)}%\n` +
                    `💻 ${platform}-${arch}-node${nodeVersion.slice(1)}\n` +
                    `⚡ ${((totalMemory - freeMemory) / 1024 / 1024 / 1024).toFixed(2)} GB/${(totalMemory / 1024 / 1024 / 1024).toFixed(2)} GB-${(((totalMemory - freeMemory) / totalMemory) * 100).toFixed(2)}%\n` +
                    `💾 ${used.toFixed(0)} GB/${total.toFixed(0)} GB-${((used/total) * 100).toFixed(2)}%`
                );
            } catch (error) {
                console.error("状态命令执行失败:", error);
                await e.reply(`[-]获取状态信息失败: ${error.message || "未知错误"}`);
            }
        }
    },
    "插件": {
        subcommands: {
            "列表": async (ctx, e) => {
                let msg = "〓 🧩 CyberBot 插件 〓\n";
                const plugins = ctx.plugin.getPlugins();
                
                // 获取文件系统中的所有插件
                const allPluginsInDir = ctx.plugin.getPluginsFromDir();
                
                // 创建一个所有可用插件的集合，包括已加载和未加载的
                const allAvailablePlugins = new Set([
                    ...Array.from(plugins.keys()),
                    ...allPluginsInDir
                ]);
                
                // 获取插件类型信息（系统/用户）
                const configSystemPlugins = ctx.config.plugins.system || [];
                
                // 转换为数组并排序：先系统插件，再用户插件，每组内按名称字母顺序
                const sortedPlugins = Array.from(allAvailablePlugins).sort((a, b) => {
                    const aIsSystem = configSystemPlugins.includes(a);
                    const bIsSystem = configSystemPlugins.includes(b);
                    
                    if (aIsSystem && !bIsSystem) return -1;
                    if (!aIsSystem && bIsSystem) return 1;
                    return a.localeCompare(b);
                });
                
                // 显示所有插件及其状态
                for (const pluginName of sortedPlugins) {
                    const plugin = plugins.get(pluginName);
                    const isEnabled = plugin?.setup?.enable || false;
                    const typeLabel = configSystemPlugins.includes(pluginName) ? '内置' : '用户';
                    const versionInfo = plugin?.version ? `-${plugin.version}` : '';
                    
                    // 只使用两种状态标识：绿色(启用)和红色(未启用)
                    msg += `${isEnabled ? '🟢' : '🔴'} ${pluginName}${versionInfo} (${typeLabel})\n`;
                }
                
                await e.reply(msg.trim());
            },
            "启用": async (ctx, e, args) => {
                const pluginName = args[0];
                if (!pluginName) return await e.reply("[-]请指定插件名");
                
                const plugins = ctx.plugin.getPlugins();
                if (plugins.has(pluginName)) {
                    const plugin = plugins.get(pluginName);
                    if (!plugin) return await e.reply("[-]插件信息获取失败");
                    
                    if (plugin.setup.enable) {
                        await e.reply(`[-]插件${pluginName}已经在运行中`);
                        return;
                    }
                    await e.reply(ctx.plugin.onPlugin(pluginName));
                } else {
                    if (!existsSync(join(process.cwd(), "plugins", pluginName))) {
                        await e.reply(`[-]未找到该插件, 请确认插件存在: ${pluginName}`);
                        return;
                    }
                    // 先加载插件
                    const result = await ctx.plugin.loadPlugin(pluginName);
                    if (!result) {
                        await e.reply(`[-]插件${pluginName}加载失败, 具体原因请看日志`);
                        return;
                    }
                    
                    // 加载成功后立即启用
                    const enableResult = ctx.plugin.onPlugin(pluginName);
                    if (enableResult.startsWith("[-]")) {
                        await e.reply(`[!]插件${pluginName}已加载但启用失败: ${enableResult}`);
                        return;
                    }
                    
                    await e.reply(`[+]插件${pluginName}已加载并启用`);
                }
            },
            "禁用": async (ctx, e, args) => {
                const pluginName = args[0];
                if (!pluginName) return await e.reply("[-]请指定插件名");
                
                // 防止禁用系统关键插件
                if (pluginName === "cmds") {
                    return await e.reply("[-]不能禁用核心命令插件");
                }
                
                // 执行禁用操作
                await e.reply(`[*]正在禁用插件: ${pluginName}...`);
                const result = ctx.plugin.offPlugin(pluginName);
                await e.reply(result);
            },
            "重载": async (ctx, e, args) => {
                const pluginName = args[0];
                if (!pluginName) return await e.reply("[-]请指定插件名");
                const result = await ctx.plugin.reloadPlugin(pluginName);
                if (!result) {
                    await e.reply(`[-]插件${pluginName}重载失败`);
                    return;
                }
                await e.reply(`[+]插件${pluginName}已重载`);
            }
        },
        help: "〓 🧩 Bot 插件 〓\n#插件 列表\n#插件 启用 <插件名>\n#插件 禁用 <插件名>\n#插件 重载 <插件名>"
    },
    "设置": {
        subcommands: {
            "详情": async (ctx, e) => {
                if (!ctx.isMaster(e)) return await e.reply("[-]权限不足");
                const msg = `〓 ⚙️ Bot 设置 〓\n主人: ${ctx.config.self.master.join(", ")}\n管理员: ${ctx.config.self.admins.join(", ")}`;
                await e.reply(msg);
            },
            "加主人": async (ctx, e, args) => {
                if (!ctx.isMaster(e)) return await e.reply("[-]权限不足");
                // TODO: Implement config modification
                await e.reply("[-]功能开发中");
            },
            "删主人": async (ctx, e, args) => {
                if (!ctx.isMaster(e)) return await e.reply("[-]权限不足");
                // TODO: Implement config modification
                await e.reply("[-]功能开发中");
            },
            "加管理": async (ctx, e, args) => {
                if (!ctx.isMaster(e)) return await e.reply("[-]权限不足");
                // TODO: Implement config modification
                await e.reply("[-]功能开发中");
            },
            "删管理": async (ctx, e, args) => {
                if (!ctx.isMaster(e)) return await e.reply("[-]权限不足");
                // TODO: Implement config modification
                await e.reply("[-]功能开发中");
            }
        },
        help: "〓 ⚙️ Bot 设置 〓\n#设置 详情\n#设置 [加/删]主人 <QQ/AT>\n#设置 [加/删]管理 <QQ/AT>"
    },
    "帮助": {
        handler: async (ctx, e) => {
            const msg = "〓 💡 CyberBot 帮助 〓\n#帮助 👉 显示帮助信息\n#插件 👉 框架插件管理\n#设置 👉 框架设置管理\n#状态 👉 显示框架状态\n#更新 👉 更新框架版本\n#退出 👉 退出框架进程";
            await e.reply(msg);
        }
    },
    "更新": {
        handler: async (ctx, e) => {
            try {
                if (!ctx.isMaster(e)) return await e.reply("[-]权限不足");
                await e.reply("[*]正在检查 cyberbot-core 更新...");
                
                // 获取当前版本
                const {stdout: currentVersion} = await execAsync("npm list cyberbot-core --json");
                const currentVersionData = JSON.parse(currentVersion);
                const currentVersionNumber = currentVersionData.dependencies?.["cyberbot-core"]?.version || "未知";
                
                // 检查最新版本
                const {stdout: latestVersion} = await execAsync("npm view cyberbot-core version");
                const latestVersionNumber = latestVersion.trim();
                
                if (currentVersionNumber === "未知") {
                    await e.reply("[!]无法获取当前版本信息");
                    return;
                }
                
                await e.reply(`[*]当前版本: ${currentVersionNumber}\n[*]最新版本: ${latestVersionNumber}`);
                
                // 比较版本
                if (currentVersionNumber === latestVersionNumber) {
                    await e.reply("[+]已经是最新版本，无需更新");
                    return;
                }
                
                // 执行更新
                await e.reply("[*]开始更新 cyberbot-core...");
                const {stdout: updateOutput} = await execAsync("npm update cyberbot-core");
                
                await e.reply(`[+]更新成功！\n从 ${currentVersionNumber} 更新到 ${latestVersionNumber}\n需要重启框架才能生效`);
            } catch (error) {
                console.error("更新失败:", error);
                await e.reply(`[-]更新失败: ${error.message || "未知错误"}`);
            }
        }
    },
    "退出": {
        handler: async (ctx, e) => {
            if (!ctx.isMaster(e)) return await e.reply("[-]权限不足");
            await e.reply("[+]正在关闭...");
            process.exit(0);
        }
    }
};

export default definePlugin({
    name: "cmds",
    version: "1.0.0",
    description: "基础插件",
    setup: (ctx) => {
        ctx.handle("message", async (e) => {
            if (!e.raw_message.startsWith("#") || !ctx.hasRight(e.sender.user_id)) return;
            const [cmd, subcmd, ...args] = e.raw_message.slice(1).split(" ");
            const command = commands[cmd];
            if (!command) return;
            try {
                if (command.handler) {
                    return await command.handler(ctx, e, args);
                } else if (command.subcommands) {
                    if (!subcmd) {
                        return await e.reply(command.help || "[-]请指定子命令");
                    }
                    const subHandler = command.subcommands[subcmd];
                    if (subHandler) {
                        return await subHandler(ctx, e, args);
                    } else {
                        return await e.reply(command.help || "[-]未知的子命令");
                    }
                }
            } catch (error) {
                return await e.reply(`[-]命令执行出错: ${error.message || "未知错误"}`);
            }
        });
    }
});


// 封装成一个函数，获取指定路径所在硬盘的信息
const getDiskInfo = async (): Promise<DiskInfo> => {
    const toGB = (bytes: number): number => parseFloat((bytes / (1024 * 1024 * 1024)).toFixed(2));
  
    try {
        const platform = os.platform();
        const currentPath = process.cwd();
        
        // Windows 平台
        if (platform === 'win32') {
            try {
                const drive = currentPath.split(':')[0].toUpperCase();
                const { stdout } = await execAsync(`wmic logicaldisk where "DeviceID='${drive}:'" get size,freespace /format:csv`);
                
                const lines = stdout.trim().split('\n');
                if (lines.length >= 2) {
                    const [_, freespace, size] = lines[1].split(',');
                    const total = parseInt(size) || 0;
                    const available = parseInt(freespace) || 0;
                    
                    return {
                        total: toGB(total),
                        used: toGB(total - available),
                        available: toGB(available)
                    };
                }
            } catch (err) {
                console.error("Windows磁盘信息获取失败:", err);
            }
        } 
        // Linux/macOS 平台
        else {
            try {
                const { stdout } = await execAsync(`df -k "${currentPath}"`);
                
                const lines = stdout.trim().split('\n');
                if (lines.length >= 2) {
                    const parts = lines[1].split(/\s+/);
                    // df 输出格式: 文件系统 总块数 已用 可用 已用% 挂载点
                    const total = parseInt(parts[1]) * 1024;  // 块大小通常是1KB
                    const used = parseInt(parts[2]) * 1024;
                    const available = parseInt(parts[3]) * 1024;
                    
                    return {
                        total: toGB(total),
                        used: toGB(used),
                        available: toGB(available)
                    };
                }
            } catch (err) {
                console.error("Unix磁盘信息获取失败:", err);
            }
        }
        
        // 如果以上方法都失败，尝试使用fs.statfs (Node.js >= 18.x 提供)
        try {
            // 检查是否支持fs.statfs
            if (typeof fs.statfs === 'function') {
                const statfsAsync = promisify(fs.statfs);
                const stats = await statfsAsync(currentPath);
                
                // statfs返回的数据结构不同平台可能有差异
                // 通常包含 blocks, bfree, bavail 等字段
                const total = stats.blocks * stats.bsize;
                const available = stats.bfree * stats.bsize;
                const used = total - available;
                
                return {
                    total: toGB(total),
                    used: toGB(used),
                    available: toGB(available)
                };
            }
        } catch (err) {
            console.error("fs.statfs调用失败:", err);
        }
        
        // 所有方法都失败，返回默认值
        console.warn("找不到当前盘符的磁盘信息，使用默认值");
        return {
            total: 100,
            used: 50,
            available: 50
        };
    } catch (error) {
        console.error("获取磁盘信息时发生错误:", error);
        return {
            total: 100,
            used: 50,
            available: 50
        };
    }
};