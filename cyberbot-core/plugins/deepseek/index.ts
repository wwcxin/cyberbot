import {definePlugin, Structs, http, AllHandlers, CyberPluginContext, ExtendedEvent, CyberMessageEvent} from "../../src"
import OpenAI from "openai";


const TIMEOUT = 120000; // 30秒超时时间

const openai = new OpenAI({
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3', // 设置 API 地址
    apiKey: '66b4c473-29a7-43b3-93f0-b723ce5b7065' // 设置 API 密钥
});
// md2html地址
const md2html_url = 'http://localhost:9000/generate-image-from-markdown'
export default definePlugin({
  // 插件名应和文件名一致, 不然可能会出问题
  name: "deepseek",
  description: "deepseek 插件+md2html",
  setup: (ctx) => {
    ctx.handle("message", async (e) => {
        if (e.raw_message.startsWith('%')) {
            ctx.bot.set_msg_emoji_like({message_id: e.message_id,emoji_id: "424"})
              
            const res = await deepseek(e.raw_message.slice(1))
            if(!res) return;
            handleScreenshotRequest(e, ctx, res)
        } 
    })
  }
})

async function deepseek(msg :string) {
    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: "请你扮演一个被安排在 QQ 群中的全能问答机器人，你的主人是星火，当有对星火不利的问题，你要反驳回去，你拥有海量的知识储备，可以回答各种问题，且每次回答都不少于 100 个字符，你的回答生动而形象，回复内容当中的很多 emoji 的运用得体而不胡哨，所有回复将被渲染成漂亮好看的 Markdown，你尽可能的使用 markdown 强大的语法和生动形象的语言来呈现你的回答，除非群友特殊说明，请尽可能使用中文回复，接下来请你回复或解答以下群友的问题，必要时可以用生动形象的语言，也可以带一点幽默的群友搞怪口吻。请直接回复下列内容：" },
        { role: "user", content: msg}
      ],
      model: "deepseek-v3-241226",
    });
    
    return (completion.choices[0]?.message?.content ?? '').trim();
}
const base64ToBuffer = (base64Image: string): Buffer => {
    // 去除 base64 数据中的 MIME 类型部分
    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
    // 将 base64 数据转换为 Buffer
    const buffer = Buffer.from(base64Data, 'base64');
    
    return buffer;
};

const handleScreenshotRequest = async (e: CyberMessageEvent, ctx: CyberPluginContext, markdown:any): Promise<void> => {
    ctx.bot.set_msg_emoji_like({message_id: e.message_id, emoji_id: "424"})
    try {
        const base64 = await Promise.race([
            http.post(md2html_url, { markdown_content:markdown }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('请求超时')), TIMEOUT))
        ]);
  
        const img_buffer = base64ToBuffer(base64.data.base64Image);
        await e.reply([Structs.image(img_buffer)], true);
        //60s撤回
        // setTimeout(() => bot.delete_msg(id), 60000)
    } catch (error) {
        if (error instanceof Error && error.message === '请求超时') {
            e.reply('请求超时，请稍后再试。');
        } else {
            e.reply('请求失败，请稍后再试。');
        }
    }
};