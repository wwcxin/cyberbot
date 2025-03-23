import {definePlugin, Structs, http, Send} from "../../src"
import { isRegexString, isImageUrl, writeConfigToFile, readConfigFromFile } from './helper'
import * as path from 'path'

let config = {
  enableGroups: [] as number[],
  keywords: [] as Array<{ keyword: string; reply: string }>
};
const menus: string[] = ['#kw on/off', '#kw add <关键词> <回复内容[支持图片/正则表达式]>', '#kw rm <关键词>', '#kw ls'];

const keyword_path: string = path.resolve(process.cwd(), 'plugins/keyword/config.json');

// 初始化时读取配置
(async () => {
  try {
    config = await readConfigFromFile(keyword_path)
  } catch (error) {
    console.error('Error reading config:', error);
  }
})();

export default definePlugin({
  // 插件名应和文件名一致, 不然可能会出问题
  name: "keyword",
  description: "关键词插件",
  setup: (ctx) => {
    ctx.handle("message", async (e) => {
      if(e.raw_message.startsWith("#kw")){
          if(!ctx.hasRight(e.sender.user_id)) return;
          const [, command, ...args] = e.raw_message.split(' ');
          const restMessage = args.join(' ');
          switch (command) {
            case 'on':
              // 实现开关功能
              if('group_id' in e && args.length == 0){
                config.enableGroups.push(e.group_id);
                await writeConfigToFile(keyword_path,config)
                await e.reply(`✅已开启关键词回复`);
              }
              break;
            case 'off':
              // 实现开关功能
              if('group_id' in e && args.length == 0){
                config.enableGroups.splice(config.enableGroups.indexOf(e.group_id),1);
                await writeConfigToFile(keyword_path,config)
                await e.reply(`❎已关闭关键词回复`);
              }
              break;
            case 'add':
              {
                const [keyword, reply] = restMessage.split(' ', 2);
                // 这里需要存储 keyword 和 reply，可以考虑使用数据库或文件系统
                
                if(keyword && reply) {
                    const extracimageurl = ctx.getImageLink(reply);

                    config.keywords.push({
                        keyword: JSON.stringify(keyword),
                        reply: (await extracimageurl).length ? JSON.stringify(extracimageurl): JSON.stringify(reply)
                    });
                    await writeConfigToFile(keyword_path,config)
                    await e.reply(`✅已添加关键词回复`);
                }
                break;
              }
            case 'rm':
              {
                const keywordToRemove = restMessage;
                // 这里需要从存储中删除 keywordToRemove
                if(keywordToRemove) {
                    config.keywords = config.keywords.filter(item => JSON.parse(item.keyword) !== keywordToRemove);
                    await writeConfigToFile(keyword_path,config)
                    await e.reply(`✅已删除关键词回复`);
                }
                break;
              }
            case 'ls':
              {
                // 实现列出所有关键词功能
                if(args.length == 0){
                    if(config.keywords.length == 0){
                        await e.reply('暂无关键词'); 
                        return;
                    }
                    const target_id: number = 'group_id' in e ? e.group_id : e.user_id;
                    // 关键词列表展示逻辑
                    const forwardmsg: Send["node"][] = [
                        {
                            type: 'node',
                            data: {
                                content: [
                                    Structs.text("==关键词列表==")
                                ]
                            }
                        },
                        {
                            type: 'node',
                            data: {
                                content: [
                                  Structs.text(
                                    config.keywords.map(keyword => `${JSON.parse(keyword.keyword)}➡️${JSON.parse(keyword.reply)}`).join('\n')
                                    )
                                ]
                            }
                        }
                    ];
                    ctx.fakeMessage(target_id, forwardmsg, 'group_id' in e)
                }
                // 这里需要从存储中读取所有关键词并回复给用户
                break;
              }
            default:
              await e.reply(menus.join('\n'));
          }
      }
      if ('group_id' in e && config.enableGroups.includes(e.group_id)) {
        for (const keyword of config.keywords) {
            try {
                const parsed = {
                    keyword: JSON.parse(keyword.keyword),
                    reply: JSON.parse(keyword.reply)
                };
    
                const isRegex = isRegexString(parsed.keyword);
                const isMatched = isRegex 
                    ? new RegExp(parsed.keyword).test(e.raw_message)
                    : e.raw_message === parsed.keyword;
    
                if (isMatched) {
                    const replyContent = await (isImageUrl(parsed.reply)
                        ? [Structs.image(await ctx.getDirectLink(parsed.reply))]
                        : parsed.reply);
                    
                    await e.reply(replyContent);
                    return;
                }
            } catch (e) {
                console.error('Keyword processing error:', keyword, e);
            }
        }
      }
      
    })
  }
})