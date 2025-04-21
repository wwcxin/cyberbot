import {log, definePlugin, Structs} from "../../src";

export default definePlugin({
  name: "直链获取",
  version: "1.0.0",
  description: "直链获取插件",
  setup: (ctx) => {
    ctx.handle("message", async (e) => {
      if((e.raw_message.includes('[CQ:reply') || e.raw_message.includes('[CQ:at')) && ctx.getText(e) === '取'){
          const textwithlink = await ctx.getQuotedText(e)
          const url = textwithlink.startsWith('[CQ:image') ? textwithlink.match(/url=([^,]+)/)?.[1]?.replace(/&amp;/g, '&') : null;
          e.reply(`${url}`);
      }
      if(e.raw_message.startsWith('取头像')){
          const atqq = e.raw_message.match(/qq=(\d+)/)?.[1] || e.raw_message.replace('取头像', '').trim();
          e.reply([Structs.text(ctx.getQQAvatarLink(Number(atqq), 100)), Structs.image(ctx.getQQAvatarLink(Number(atqq), 100))])
      }
    });
  },
});
