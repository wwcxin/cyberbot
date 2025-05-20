import {definePlugin, Structs, http, log} from "../../src"

export default definePlugin({
  // 插件名应和文件名一致, 不然可能会出问题
  name: "demo",
  description: "插件描述",
  setup: (ctx) => {
    ctx.handle("message", async (e) => {

      if (e.raw_message === '#断开连接') {
        ctx.bot.disconnect();
        e.reply('已断开连接', true)
      }

      // log.info(`[+]收到消息: ${JSON.stringify(ctx.getImageLink(e))}`);
      // 收到 hello 消息时回复 world
      if (e.raw_message === 'hello') {
        
        // 第二个参数表示是否引用回复愿消息
        const { message_id } = await e.reply('world', true)
        //5s撤回
        setTimeout(() => {
          ctx.delete_msg(message_id)
        }, 5000);
      }
      
      // 收到 love 消息时回复爱你哟和一个爱心 QQ 表情
      if (e.raw_message === 'love') {
        // 复杂消息消息可以使用数组组合
        e.reply(['爱你哟 ', Structs.face(66)])
      }
      // 收到 壁纸 消息时回复今天的 bing 壁纸
      if (e.raw_message === '壁纸') {
        // 第一个参数是图片的 URL，第二个参数是是否使用缓存，true 为使用缓存，false 为不使用缓存
        e.reply([Structs.image('https://p2.qpic.cn/gdynamic/m7yRCticIwlKMnXkIat8nNRyD95wf24YNBoiblNYKYdXs/0')])
      }
      // 收到 一言 消息时回复一言
      if (e.raw_message === '一言') {
        const { data } = await http.get('https://v1.hitokoto.cn/')
        e.reply(data.hitokoto, true)
      }
    })
    ctx.handle("message.group", async (e) => {
      // 处理群消息
      if(e.raw_message === "群消息"){
        e.reply("这是一条群消息")
      }
    })
    ctx.handle("message.private", async (e) => {
      // 处理私聊消息
      if(e.raw_message == "私聊"){
        await e.reply("私聊消息")
      }
    })

    ctx.handle("request", async (e: any) => {
      // 处理所有请求：好友、群，添加好友、邀请入群等等
      console.log('收到请求:', JSON.stringify(e));
      
      // 群组相关请求
      if (e.request_type === 'group') {
        // 自动同意群邀请或加群请求
        await ctx.aprroveGroup(e.flag);
        console.log('已自动同意群组请求');
      }
      
      // 好友相关请求可以在这里处理
      if (e.request_type === 'friend') {
        // 处理好友请求
      }
    })
    ctx.handle("notice", async (e: any) => {
      // 处理所有通知：好友、群的数量增加与减少、戳一戳、撤回，以及群的签到、禁言、管理变动、转让等等
      // console.log('收到通知:', JSON.stringify(e));
    })
    // 可设置多个 cron
    // ctx.cron([
    //   [
    //     '*/5 * * * * *', // 每5秒执行一次
    //     async (ctx, e) => {
    //       await ctx.sendPrivateMessage(2062748014, "每5秒执行一次")
    //     }
    //   ],
    //   [
    //     '*/3 * * * * *', // 每分钟执行一次
    //     async (ctx, e) => {
    //       await ctx.sendPrivateMessage(2062748014, "每3秒执行一次")
    //     }
    //   ],
    // ])
  }
})