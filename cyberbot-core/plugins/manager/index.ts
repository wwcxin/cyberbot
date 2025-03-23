import {definePlugin,Structs, type Send} from "../../src"
import { loadConfig, saveConfig, matchKeyword, isRegexString } from './helper'
import path from 'path';

// 获取当前文件的绝对路径
const __dirname = path.resolve();
const name:string = "manager";
const configPath:string = path.join(__dirname, `plugins/${name}`);

interface Config {
    enableGroups: number[];
    banwords: string[];
    recallwords: string[];
}
let config:Config = {
    enableGroups: [],
    banwords: [],
    recallwords: []
};
const cmds: string[] = [
    '#mg',
    '#mg on/off',
    '#踢 <@成员>',
    '#禁言 <@成员> <?分钟>',
    '#解禁 <@成员>',
    '#开/关灯',
    '#撤回 <@成员> <?条数>',
    '#改群名 <群名>',
    '#加/删管理 <@成员>',
    '#改名片 <@成员> <名片>',
    '#改头衔 <@成员> <头衔>',
    '#加撤回词 <词>',
    '#删撤回词 <词>',
    '#加禁言词 <词>',
    '#删禁言词 <词>',
    '#撤回词列表',
    '#禁言词列表',
    '#微群管'
];

const ban_time = 5;  //禁言时长 单位：分钟

// 初始化时读取配置
(async () => {
    try {
      config = loadConfig(configPath, config) as Config;
    } catch (error) {
      console.error('Error reading config:', error);
    }
})();


export default definePlugin({
    name: name,
    version: "1.0.0",
    description: "manager",
    setup: (ctx) => {
        ctx.handle("message.group", async (e) => {
            if(!('group_id' in e)) return;
            const regex = /^#.*/i
            // 过滤 CQ 码
            const commond:string = e.raw_message;
            
            // at 消息元素列表
            const ats = ctx.getMessageAt(e.raw_message);
            
            let gid:number = e.group_id
            //根据空格拆分消息
            const messages:string[] = commond.split(/\s+/);
            console.log(messages);
            
            
            // 判断是否有权限
            if(!ctx.hasRight(e.sender.user_id) || !commond.match(regex)){
                return;
            }      
             //群指令
            if (commond.startsWith('#mg')) {
                const [_, secondCmd] = commond.split(' ');
            
                if (!['on', 'off'].includes(secondCmd)) {
                    return e.reply(cmds.join('\n'), true);
                }
            
                const isEnabled = config.enableGroups.includes(e.group_id);
                const actionMap = {
                    on: {
                        condition: !isEnabled,
                        successMsg: '✅ 本群开启成功',
                        errorMsg: '❎ 本群已开启',
                        update: () => config.enableGroups.push(e.group_id)
                    },
                    off: {
                        condition: isEnabled,
                        successMsg: '✅ 本群关闭成功',
                        errorMsg: '❎ 本群未开启',
                        update: () => config.enableGroups.splice(config.enableGroups.indexOf(e.group_id), 1)
                    }
                };
            
                const { condition, successMsg, errorMsg, update } = actionMap[secondCmd];
            
                if (condition) {
                    update();
                    saveConfig(configPath, config);
                    return await e.reply(successMsg);
                }
            
                return e.reply(errorMsg);
            }
            if(!config.enableGroups.includes(gid)){
                return
            }
            // 触发指令
            else if (commond.startsWith('#踢')) {
                if(!ats[0]){
                return e.reply('❎移出失败，该群员不存在');
                }
                await ctx.kick(e.group_id, ats[0])
                return e.reply(`🌟${ats[0]} 被移出群聊`);
            }
            else if(commond.startsWith('#禁言')){
                // 执行禁言
                if(!ats[0]){
                  return e.reply('❎禁言/解除禁言失败，该群员不存在');
                }
                const info = await ctx.bot.get_group_member_info({group_id:e.group_id, user_id: ats[0]})
                const name = info.card || (info.nickname ?? ats[0])
                ctx.ban(e.group_id, ats[0], parseInt(messages[2]) * 60);
                return e.reply(name + '已被禁言'+messages[2] + '分钟！');

            }
            else if(commond.startsWith('#解禁')){
                // 解除禁言
                if(!ats[0]){
                  return e.reply('❎解除失败，该群员不存在');
                }
                const info = await ctx.bot.get_group_member_info({group_id:e.group_id, user_id: ats[0]})
                const name = info.card || (info.nickname ?? ats[0])
                ctx.ban(e.group_id, ats[0], 0);
                return e.reply('✅已解除对'+name+'的禁言！');
            }
            else if (['#关灯', '#全员禁言'].includes(commond)) {
                ctx.banAll(e.group_id, true);
                return e.reply('✅已开启全员禁言');
            }
            else if (['#开灯', '#全员解禁'].includes(commond)) {
                ctx.banAll(e.group_id, false);
                return e.reply('✅已解除全员禁言'); 
            }
            else if(commond.startsWith('#撤回')){
                if(!ats[0]){
                  return e.reply('❎撤回失败，该消息指向的用户不存在');
                }
                let count = 0,  m_id = 0;
                let histrymsgs: { user_id: number; message_id: number; }[] = [];
                let flag = true;
                setTimeout(()=>{//5s还未结束退出循环
                  flag = false;
                }, 20000)
                e.reply("正在撤回...");
          
                while(count < parseInt(messages[2]) && flag){
                          
                    const msgs = await ctx.bot.get_group_msg_history({
                        group_id: e.group_id,
                        message_seq: m_id,
                        count:50,
                        reverseOrder:true
                    })
                    
                    // 提取 user_id 和 message_id
                    histrymsgs = msgs.messages.map(msg => ({
                        user_id: msg.sender.user_id,
                        message_id: msg.message_id
                    }));
              
                  
                  if(histrymsgs.length > 0){
                    for (let histrymsg of histrymsgs) {
                      if (histrymsg.user_id == ats[0]) {
                        await ctx.delete_msg(histrymsg.message_id);
                        count++;
                      }
                      if(count >= parseInt(messages[2])){
                        break;
                      }
                    }
                    m_id = histrymsgs[histrymsgs.length-1].message_id
                  }
                }
                return e.reply("✅撤回成功");
            }
            else if(commond.startsWith('#改群名')){
                ctx.bot.set_group_name({ group_id: e.group_id, group_name: messages[1] })
                return e.reply("✅更改成功", true);
            }
            else if(commond.startsWith('#加管理')){
                if(!ats[0]){
                  return e.reply('❎添加失败，该群员不存在');
                }
                ctx.bot.set_group_admin({ group_id: e.group_id, user_id: ats[0], enable: true });
                return e.reply("✅添加成功", true);
            }
            else if(commond.startsWith('#删管理')){
                if(!ats[0]){
                  return e.reply("❎删除失败，该群员不存在", true);
                }
                // ctx.bot.setGroupAdmin(e.group_id, qqs[1], false);
                ctx.bot.set_group_admin({ group_id: e.group_id, user_id: ats[0], enable: false });
                return e.reply("✅删除成功", true);
            }
            if(commond.startsWith('#改名片')){
                if(!ats[0]){
                  return e.reply('❎修改失败，该群员不存在');
                }
                ctx.bot.set_group_card({ group_id: e.group_id, user_id: ats[0], card: messages[2] });
                return e.reply("✅修改成功", true);
            }
            else if(commond.startsWith('#改头衔')){
                if(!ats[0]){
                  return e.reply('❎修改失败，该群员不存在');
                }
                ctx.bot.set_group_special_title({ group_id: e.group_id, user_id: ats[0], special_title: messages[2] });
                return e.reply("✅修改成功", true);
            }
            else  if(commond === '#微群管'){
                return e.reply(cmds.join('\n'), true);
            }

        })
        ctx.handle('message', async e => {
            const commond:string = e.raw_message;
            const regex = /^#.*/i
            if(ctx.hasRight(e.sender.user_id) && commond.match(regex)){
              // 过滤 CQ 码
              const msg:string = commond.replace(/\[.*\]/gi, '');
              
              let gid:number = 0
              if(e.message_type === 'group'){
                gid = e.group_id;
              }
      
              //根据空格拆分消息
              const messages = msg.split(/\s+/);
              //允许私聊的指令
              const isAllow = ['#加撤回词','#删撤回词','#加禁言词','#删禁言词','#禁言词列表','#撤回词列表','#微群管'].includes(messages[0]);
              if (!isAllow && e.message_type !== 'group') {
                return
              }
              if(!isAllow && !config.enableGroups.includes(gid)){
                return;
              }
              // 触发指令
      
              if(msg.startsWith('#加撤回词')){
                if(!messages[1]){
                  return e.reply('格式错误，正确格式：#加撤回词 <词>', true);
                }
                if (config.recallwords.includes(messages[1])) {
                  return e.reply('❎ 词已存在');
                }
                config.recallwords.push(messages[1]);
                saveConfig(configPath, config)
                return e.reply('✅ 添加成功');
              }
              else if(msg.startsWith('#删撤回词')){
                if(!messages[1]){
                  return e.reply('格式错误，正确格式：#删撤回词 <词>', true);
                }
                if (!config.recallwords.includes(messages[1])) {
                  return e.reply('❎ 词不存在');
                }
                const idx = config.recallwords.findIndex(e => e[0] === messages[1]);
                config.recallwords.splice(idx, 1);
                saveConfig(configPath, config)
                return e.reply('✅ 删除成功');
              }
              else if(msg.startsWith('#加禁言词')){
                if(!messages[1]){
                  return e.reply('格式错误，正确格式：#加禁言词 <词>', true);
                }
                if (config.banwords.includes(messages[1])) {
                  return e.reply('❎ 词已存在');
                }
                config.banwords.push(messages[1]);
                saveConfig(configPath, config)
                return e.reply('✅ 添加成功');
              }
              else if(msg.startsWith('#删禁言词')){
                if(!messages[1]){
                  return e.reply('格式错误，正确格式：#删禁言词 <词>', true);
                }
                if (!config.banwords.includes(messages[1])) {
                  e.reply(`${messages[1]}`);
                  return e.reply('❎ 词不存在');
                }
                const idx = config.banwords.findIndex(e => e[0] === messages[1]);
                config.banwords.splice(idx, 1);
                saveConfig(configPath, config)
                return e.reply('✅ 删除成功');
              }
              else if(msg === '#禁言词列表'){
                if(config.banwords.length === 0){
                  return e.reply('禁言词列表为空', true);
                }
                const target_id: number = 'group_id' in e ? e.group_id : e.user_id;
                // 禁言词列表展示逻辑
                const forwardmsg: Send["node"][] = [
                    {
                        type: 'node',
                        data: {
                            content: [
                                Structs.text("==禁言词列表==")
                            ]
                        }
                    },
                    {
                        type: 'node',
                        data: {
                            content: [
                                Structs.text(
                                config.banwords.join('\n')
                                )
                            ]
                        }
                    }
                ];
                ctx.fakeMessage(target_id, forwardmsg, 'group_id' in e)
              }
              else if(msg === '#撤回词列表'){
                if(config.recallwords.length === 0){
                  return e.reply('撤回词列表为空', true);
                }
                const target_id: number = 'group_id' in e ? e.group_id : e.user_id;
                // 禁言词列表展示逻辑
                const forwardmsg: Send["node"][] = [
                    {
                        type: 'node',
                        data: {
                            content: [
                                Structs.text("==撤回词列表==")
                            ]
                        }
                    },
                    {
                        type: 'node',
                        data: {
                            content: [
                                Structs.text(
                                config.recallwords.join('\n')
                                )
                            ]
                        }
                    }
                ];
                ctx.fakeMessage(target_id, forwardmsg, 'group_id' in e)
              }
            }
            else if(e.message_type === 'group' && config.enableGroups.includes(e.group_id)){
              const isCmd:boolean = e.raw_message.trim().startsWith('#mg') || e.raw_message.trim().startsWith('#');
              // 当前处理 QQ 是否 Bot 管理
              const isBotAdmin:boolean = ctx.hasRight(e.sender.user_id)
              if (isBotAdmin || isCmd) {
                  return;
              }
              const { raw_message, sender, message_id } = e;
              //禁言词
              for (const item of config.banwords) {//精确
                // 判断是否为正则匹配
                if ( raw_message !== item && isRegexString(item)) {
                  const content = matchKeyword(raw_message, item);
                  if (content) {
                    await ctx.ban(e.group_id, sender.user_id, ban_time * 60);
                    await ctx.delete_msg(message_id);
                    const { message_id:mid } = await e.reply('消息含有违禁词，请文明聊天。');
                    // 60s撤回
                    return setTimeout(() => {
                        ctx.delete_msg(mid);
                    }, 10 * 1000);
                  }
                }
                else if (raw_message === item) {
                  await ctx.ban(e.group_id, sender.user_id, ban_time * 60);
                  await ctx.delete_msg(message_id);
                  const { message_id:mid } = await e.reply('消息含有违禁词，请文明聊天。');
                  // 60s撤回
                  return setTimeout(() => {
                      ctx.delete_msg(mid);
                  }, 10 * 1000);
                }
              }
              //撤回词
              for (const item of config.recallwords) {//精确
                if ( raw_message !== item && isRegexString(item)) {
                  const content = matchKeyword(raw_message, item);
                  if (content) {
                    await ctx.delete_msg(message_id);
                    const { message_id:mid } = await e.reply('消息含有违禁词，请文明聊天。');
                    // 60s撤回
                    return setTimeout(() => {
                        ctx.delete_msg(mid);
                    }, 10 * 1000);
                  }
                }
                else if (raw_message === item) {
                  await ctx.delete_msg(message_id);
                  const { message_id:mid } = await e.reply('消息含有违禁词，请文明聊天。');
                  // 60s撤回
                  return setTimeout(() => {
                      ctx.delete_msg(mid);
                  }, 10 * 1000);
                }
              }
            }
        })
    }
})
