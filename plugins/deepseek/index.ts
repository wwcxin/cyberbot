import {definePlugin, Structs, http, AllHandlers, CyberPluginContext, ExtendedEvent, CyberMessageEvent} from "../../src"
import OpenAI from "openai";


const TIMEOUT = 120000; // 30秒超时时间

const openai = new OpenAI({
    baseURL: 'deepseek的openapi兼容接口地址', // 设置 API 地址
    apiKey: 'APIKEY' // 设置 API 密钥
});
const model = "DeepSeek模型莫名称"
// md2html地址
const md2html_url = 'http://localhost:9000/generate-image-from-markdown' // md2html地址
export default definePlugin({
  // 插件名应和文件名一致, 不然可能会出问题
  name: "deepseek",
  version: "1.0.0",
  description: "deepseek 插件+md2html",
  setup: (ctx) => {
    ctx.handle("message", async (e) => {
        if (ctx.getText(e).startsWith('%')) {
            ctx.bot.set_msg_emoji_like({message_id: e.message_id,emoji_id: "424"})
            const text = await ctx.getQuotedText(e) || e.raw_message.slice(1)
              
            const startTime = new Date().getTime()
            // 格式化为 年-月-日 时:分:秒
            const startTimeStr = new Date(startTime).toLocaleString('zh-CN', { 
                year: 'numeric', 
                month: '2-digit', 
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).replace(/\//g, '-')
            const res = await deepseek(text.trim())
            const endTime = new Date().getTime()
            const timeSpan = endTime - startTime
            // Process the response to swap <think> tags and add "思考过程："
            let processedRes = res
            if (res) {
                const thinkRegex = /<think>([\s\S]*?)<\/think>([\s\S]*)/
                const match = res.match(thinkRegex)
                
                if (match) {
                    const thinkContent = match[1]
                    const remainingContent = match[2]
                    // 使用变量存储反引号
                    const backtick = '`'
                    processedRes = `${remainingContent.trim()}\n\n---\n\n<think>💡思考过程：${thinkContent}</think>\n\n---\n\n<think>⚡大语言模型：${backtick}DeepSeek R1(70B)${backtick}，异构计算加速平台(npu)：${backtick}Ascend 910b3(x8)${backtick}，内存：\`1.5T\`，耗时：${backtick}${timeSpan}ms${backtick}，提问于 \`${startTimeStr}\`，基于${backtick}CyberBot Deepseek${backtick}插件.</think>`
                }
            }
            if(!res) return;
            handleScreenshotRequest(e, ctx,processedRes)
        } 
    })
  }
})

async function deepseek(msg :string) {
    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: "请你扮演一个在 QQ 群里进行互动的全能问答机器人，你拥有海量的知识储备，可以极其熟练、正确的回答各种问题，你的回答生动而形象，回复内容中恰到好处地插入许多 emoji，得体而不胡哨，请你以 GitHub Flavored Markdown 格式回复，必要时可以使用高级语法，如 GitHub styled Alert 语法（比如 \`> [!NOTE] \\nThis is tip.\` 还有 TIP、IMPORTANT、WARNING、CAUTION 类型）、表格、Katex 数学公式等等，你尽可能的使用其强大的语法和生动形象的语言来呈现你的回答，每次回答都不少于 100 个字符，除非群友特殊说明，请尽可能使用中文回复。为了更加真实的扮演真实群友，请你不要介意“机器人回复不够礼貌”的问题，你可以在情节合适且必要时附带些嘲讽、挖苦、看热闹不嫌事大的语气。接下来请你回复或解答以下群友的问题，请直接回复下列内容：" },
        { role: "user", content: msg}
      ],
      model: model,
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