import { definePlugin, http, Structs } from '../../src'
import OpenAI from "openai"
import fs from 'fs'
import path from 'path'
import { md2html, renderToImage } from '../渲染'
import sharp from 'sharp'
import PQueue from 'p-queue'

// 基础配置
const baseConfig = {
    OPENAI_CONFIG: {
        apiKey: 'sk-a213a9a122d54bf5adc8ecf0dabfd9a8', // 替换为你的通义千问API Key https://bailian.console.aliyun.com/
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    },
    AI_MODEL: "qwen2.5-vl-72b-instruct",                  // 图片模型
    STR_MODEL: "deepseek-v3",                 // 文本模型
    TRIGGER_WORD: "汐汐",                      // 触发前缀列表
    BLOCKED_GROUPS: [123456789, 87654321],    // 回复阻断的群列表
    SYSTEM_PROMPT: "请你扮演一个在 QQ 群里进行互动的全能问答机器人，你拥有海量的知识储备，可以极其熟练、正确的回答各种问题，你的回答生动而形象，回复内容中恰到好处地插入许多 emoji，得体而不胡哨，请你以 GitHub Flavored Markdown 格式回复，必要时可以使用高级语法，如 GitHub styled Alert 语法（比如 `> [!NOTE]  \nThis is tip.` 还有 TIP、IMPORTANT、WARNING、CAUTION 类型）、表格、Katex 数学公式等等，你尽可能的使用其强大的语法和生动形象的语言来呈现你的回答，每次回答都不少于 100 个字符，除非群友特殊说明，请尽可能使用中文回复。为了更加真实的扮演真实群友，请你不要介意'机器人回复不够礼貌'的问题，你可以在情节合适且必要时附带些嘲讽、挖苦、看热闹不嫌事大的语气。接下来请你回复或解答以下群友的问题，请直接回复下列内容："
}

// 添加性能监控函数
function timeLog(label: string) {
    const start = Date.now();
    return {
        end: () => {
            const duration = Date.now() - start;
            console.log(`${label}: ${duration}ms`);
        }
    };
}

export default definePlugin({
    name: '阿里百炼',
    version: '1.0.0',
    async setup(ctx) {
        // 初始化OpenAI客户端
        const openai = new OpenAI(baseConfig.OPENAI_CONFIG)

        // 确保临时文件夹存在
        const tempDir = path.join(__dirname, 'temp')
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir)
        }

        // 创建消息队列
        const queue = new PQueue({concurrency: 1})

        // 修改消息处理器
        ctx.handle('message.group', async e => {
            // 抽取处理AI回复的函数
            async function handleAIResponse(e: any, response: any) {
                const markdown = response.choices[0]?.message?.content ?? '';
                if (!markdown) {
                    await e.reply('AI 返回内容为空');
                    return;
                }

                try {
                    console.log('开始渲染 Markdown:', markdown);
                    
                    // 使用渲染插件处理markdown
                    const html = await md2html(markdown, {
                        darkMode: true, // 或 false，根据需要选择
                        customCSS: `
                            .markdown-body {
                                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                            }
                        `
                    });
                    
                    console.log('Markdown 转换为 HTML 完成');
                    
                    const imagePath = await renderToImage(html);
                    console.log('HTML 渲染为图片完成，路径:', imagePath);
                    
                    // 发送图片
                    await e.reply([
                        Structs.image(imagePath)
                    ], true);
                    
                    console.log('图片发送完成');
                    
                    // 清理临时文件
                    try {
                        fs.unlinkSync(imagePath);
                        console.log('临时文件清理完成');
                    } catch (error) {
                        console.error('清理临时文件失败:', error);
                    }
                } catch (error) {
                    console.error('渲染失败:', error);
                    // 如果渲染失败,直接发送原文
                    await e.reply([
                        '渲染失败，发送原文：\n',
                        markdown
                    ].join(''), true);
                }
            }

            if (baseConfig.BLOCKED_GROUPS.includes(e.group_id)) return;
            if (!ctx.getText(e).startsWith(baseConfig.TRIGGER_WORD) && !(await ctx.isAtBot(e))) return;

            const Text_msg = ctx.getText(e).replace(baseConfig.TRIGGER_WORD, '').trim()
            if (!Text_msg) {
                await e.reply('？你想说什么')
                return
            }

            // 将消息处理放入队列
            queue.add(async () => {
                const thinkingMsg = await e.reply('正在思考,请稍候...');
                const timer = timeLog('AI Response');
                
                try {
                    // 尝试图片+文本对话
                    try {
                        const imgUrl = await ctx.getMentionedImageUrl(e);
                        const base64Image = await imageToBase64(imgUrl);
                        
                        if (imgUrl && base64Image) {  // 确保两者都存在
                            const response = await openai.chat.completions.create({
                                model: baseConfig.AI_MODEL,
                                messages: [{
                                    role: "user",
                                    content: [
                                        { 
                                            type: "image_url", 
                                            image_url: {
                                                "url": `data:image/png;base64,${base64Image}`
                                            }
                                        },
                                        { type: "text", text: Text_msg }
                                    ]
                                }]
                            });

                            await handleAIResponse(e, response);
                            return;
                        }
                    } catch (error) {
                        // 继续尝试引用消息+文本对话
                        console.error('图片处理失败:', error);
                    }

                    // 引用消息+文本对话
                    try {
                        const quotedMsg = await ctx.getQuoteMessage(e);
                        const content = ctx.getText(quotedMsg).trim();
                        const response = await openai.chat.completions.create({
                            model: baseConfig.STR_MODEL,
                            messages: [
                                { role: "system", content: baseConfig.SYSTEM_PROMPT },
                                { role: "user", content: content },
                                { role: "user", content: Text_msg }
                            ]
                        });

                        await handleAIResponse(e, response);
                        return;
                    } catch (err) {
                        // 继续尝试纯文本对话
                    }

                    // 纯文本对话
                    const response = await openai.chat.completions.create({
                        model: baseConfig.STR_MODEL,
                        messages: [
                            { role: "system", content: baseConfig.SYSTEM_PROMPT },
                            { role: "user", content: Text_msg }
                        ]
                    });

                    await handleAIResponse(e, response);

                } finally {
                    // 撤回思考中的消息
                    if (thinkingMsg && thinkingMsg.message_id) {
                        await ctx.delete_msg(thinkingMsg.message_id);
                    }
                    timer.end();
                }
            });
        })
    }
})
async function imageToBase64(url: string | null) {
    // 如果URL为空则直接返回
    if (!url) {
        return null;
    }

    try {
        // Step 1: 下载图片
        const response = await http.get(url, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(response.data);
    
        // Step 2: 使用 sharp 转换为 PNG 格式
        const pngBuffer = await sharp(imageBuffer).png().toBuffer();
    
        // Step 3: 转换为 Base64 编码
        const base64Image = pngBuffer.toString('base64');
    
        return base64Image;
    } catch (error) {
        console.error('Error fetching or converting image:', error);
        return null;
    }
}
