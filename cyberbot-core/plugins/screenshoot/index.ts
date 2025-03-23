import {definePlugin, Structs, http, CyberMessageEvent, CyberPluginContext} from "../../src"
import { Buffer } from 'buffer';

const TIMEOUT = 20000; // 10秒超时时间

export default definePlugin({
  // 插件名应和文件名一致, 不然可能会出问题
  name: "screenshoot",
  description: "截图插件",
  setup: (ctx) => {
    ctx.handle("message", async (e) => {
      if (e.raw_message === '#截图 使用文档') {
          await handleScreenshotRequest(e, ctx, 'https://doc.yingshengchong.cn', 375, 667);
      } else if (e.raw_message === '#电脑截图 使用文档') {
          await handleScreenshotRequest(e, ctx, 'https://doc.yingshengchong.cn', 1920, 1080);
      } else if (e.raw_message.includes('#截图') || e.raw_message.includes('#电脑截图')) {
          const urlMatch = e.raw_message.match(/#截图\s*([^\s]+)|#电脑截图\s*([^\s]+)/);

          if (!urlMatch || (!urlMatch[1] && !urlMatch[2])) {
              e.reply('请提供有效的 URL。');
              return;
          }

          const url = urlMatch[1] || urlMatch[2];
          const fullUrl = url.startsWith('http') ? url : `http://${url}`;

          let width: number, height: number;
          if (e.raw_message.includes('#电脑截图')) {
              width = 1920;
              height = 1080;
          } else if (e.raw_message.includes('#截图')) {
              width = 375;
              height = 667;
          } else {
              // 提供默认值或抛出错误
              e.reply('无法确定截图尺寸，请使用 #截图 或 #电脑截图 指令。');
              return;
          }

          await handleScreenshotRequest(e, ctx, fullUrl, width, height);
      }
    })
  }
})

const base64ToBuffer = (base64Image: string): Buffer => {
  // 去除 base64 数据中的 MIME 类型部分
  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
  // 将 base64 数据转换为 Buffer
  const buffer = Buffer.from(base64Data, 'base64');
  
  return buffer;
};

const handleScreenshotRequest = async (e: CyberMessageEvent, ctx: CyberPluginContext, url: string, width: number, height: number): Promise<void> => {
  ctx.bot.set_msg_emoji_like({message_id: e.message_id,emoji_id: "424"})
  const { message_id } = await e.reply("正在等待加载页面资源、UI布局...");

  try {
      const base64 = await Promise.race([
          http.post('http://localhost:9000/generate-image-from-url', { url, viewport: { width, height } }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('请求超时')), TIMEOUT))
      ]);

      const img_buffer = await base64ToBuffer(base64.data.base64Image);
      await ctx.delete_msg(message_id);
      const { message_id:id } = await e.reply([Structs.image(img_buffer)]);
      //30s撤回
      // setTimeout(() => ctx.delete_msg(id), 30000)
  } catch (error) {
      await ctx.delete_msg(message_id);
      if (error instanceof Error && error.message === '请求超时') {
          e.reply('请求超时，请稍后再试。');
      } else {
          e.reply('请求失败，请稍后再试。');
      }
  }
};