import { definePlugin, http, Structs } from '../../src'
import OpenAI from "openai"
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import PQueue from 'p-queue'
import puppeteer from 'puppeteer'

// 类型定义
interface BotConfig {
    OPENAI: {
        apiKey: string;
        baseURL: string;
        models: {
            image: string;
            text: string;
        };
    };
    BOT: {
        triggerWord: string;
        blockedGroups: number[];
        systemPrompt: string;
    };
    RENDER: {
        markdownApi: string;
        width: number;
        initialHeight: number;
        timeout: number;
    };
    CACHE: {
        imageCacheSize: number;
        cacheTTL: number;
    };
}

interface ThinkingMessage {
    message_id: number;
}

class BotError extends Error {
    constructor(
        message: string,
        public code: string,
        public details?: any
    ) {
        super(message);
        this.name = 'BotError';
    }
}

// 优化后的配置结构
const baseConfig: BotConfig = {
    OPENAI: {
        apiKey: process.env.ALI_API_KEY || 'sk-', // 替换为你的通义千问API Key https://bailian.console.aliyun.com/
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        models: {
            image: "qwen2.5-vl-72b-instruct",
            text: "deepseek-v3"
        }
    },
    BOT: {
        triggerWord: "汐汐",
        blockedGroups: [123456789, 87654321],
        systemPrompt: "请你扮演一个在 QQ 群里进行互动的全能问答机器人，你拥有海量的知识储备，可以极其熟练、正确的回答各种问题，你的回答生动而形象，回复内容中恰到好处地插入许多 emoji，得体而不胡哨，请你以 GitHub Flavored Markdown 格式回复，必要时可以使用高级语法，如 GitHub styled Alert 语法（比如 `> [!NOTE]  \nThis is tip.` 还有 TIP、IMPORTANT、WARNING、CAUTION 类型）、表格、Katex 数学公式等等，你尽可能的使用其强大的语法和生动形象的语言来呈现你的回答，每次回答都不少于 100 个字符，除非群友特殊说明，请尽可能使用中文回复。为了更加真实的扮演真实群友，请你不要介意'机器人回复不够礼貌'的问题，你可以在情节合适且必要时附带些嘲讽、挖苦、看热闹不嫌事大的语气。接下来请你回复或解答以下群友的问题，请直接回复下列内容："
    },
    RENDER: {
        markdownApi: 'https://markdown2html.deno.dev',
        width: 900,
        initialHeight: 0,
        timeout: 30000
    },
    CACHE: {
        imageCacheSize: 100,
        cacheTTL: 3600000
    }
};

// 图片缓存机制
const imageCache = new Map<string, { data: string; timestamp: number }>();

// 工具函数
const utils = {
    ensureTempDir(): string {
        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true, mode: 0o755 });
        }
        return tempDir;
    },

    timeLog(label: string) {
        const start = Date.now();
        return {
            end: () => {
                const duration = Date.now() - start;
                console.log(`${label}: ${duration}ms`);
            }
        };
    },

    processLocalImagePaths(html: string): string {
        return html.replace(/<img[^>]+src="([^"]+)"[^>]*>/g, (match, src) => {
            if (!src.startsWith('http://') && !src.startsWith('https://')) {
                const filePath = src.startsWith('file://') ? src : `file://${src}`;
                return match.replace(src, filePath);
            }
            return match;
        });
    },

    async getCachedImage(url: string): Promise<string | null> {
        const cached = imageCache.get(url);
        if (cached && Date.now() - cached.timestamp < baseConfig.CACHE.cacheTTL) {
            return cached.data;
        }
        
        const base64Image = await this.imageToBase64(url);
        if (base64Image) {
            if (imageCache.size >= baseConfig.CACHE.imageCacheSize) {
                const oldestKey = Array.from(imageCache.entries())
                    .sort(([, a], [, b]) => a.timestamp - b.timestamp)[0][0];
                imageCache.delete(oldestKey);
            }
            imageCache.set(url, { data: base64Image, timestamp: Date.now() });
        }
        return base64Image;
    },

    async imageToBase64(url: string | null): Promise<string | null> {
        if (!url) return null;

        try {
            const response = await http.get(url, { 
                responseType: 'arraybuffer',
                timeout: 10000
            });
            
            const imageBuffer = Buffer.from(response.data);
            const pngBuffer = await sharp(imageBuffer)
                .png({
                    compressionLevel: 9,
                    quality: 80,
                    progressive: true
                })
                .toBuffer();
            
            return pngBuffer.toString('base64');
        } catch (error) {
            console.error('图片处理错误:', {
                url,
                error: error.message,
                stack: error.stack
            });
            throw new BotError('图片处理失败', 'IMAGE_PROCESSING_ERROR', { url, error });
        }
    }
};

// 消息处理类
class MessageHandler {
    private queue: PQueue;
    private openai: OpenAI;
    private tempDir: string;

    constructor(private ctx: any) {
        this.queue = new PQueue({
            concurrency: 1,
            timeout: 30000,
            throwOnTimeout: true
        });
        this.openai = new OpenAI(baseConfig.OPENAI);
        this.tempDir = utils.ensureTempDir();
    }

    async handleMessage(e: any) {
        if (baseConfig.BOT.blockedGroups.includes(e.group_id)) return;
        
        const messageText = this.ctx.getText(e);
        if (!messageText) {
            console.error('无效消息:', { groupId: e.group_id, messageId: e.message_id });
            return;
        }
        
        if (!messageText.startsWith(baseConfig.BOT.triggerWord) && !(await this.ctx.isAtBot(e))) return;

        const textMsg = messageText.replace(baseConfig.BOT.triggerWord, '').trim();
        if (!textMsg) {
            await e.reply('？你想说什么');
            return;
        }

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new BotError('处理超时', 'TIMEOUT')), 30000)
        );

        try {
            await Promise.race([
                this.queue.add(() => this.processMessage(e, textMsg)),
                timeoutPromise
            ]);
        } catch (error) {
            if (error instanceof BotError && error.code === 'TIMEOUT') {
                await e.reply('处理超时，请稍后重试');
            } else {
                console.error('消息处理错误:', error);
                await e.reply('处理消息时发生错误，请稍后重试');
            }
        }
    }

    private async processMessage(e: any, textMsg: string) {
        let thinkingMsg: ThinkingMessage | null = null;
        try {
            thinkingMsg = await e.reply('正在思考,请稍候...') as ThinkingMessage;
            const timer = utils.timeLog('AI Response');

            try {
                // 尝试图片+文本对话
                const imgUrl = await this.ctx.getMentionedImageUrl(e);
                if (imgUrl) {
                    const base64Image = await utils.getCachedImage(imgUrl);
                    if (base64Image) {
                        const response = await this.openai.chat.completions.create({
                            model: baseConfig.OPENAI.models.image,
                            messages: [{
                                role: "user",
                                content: [
                                    { 
                                        type: "image_url", 
                                        image_url: {
                                            "url": `data:image/png;base64,${base64Image}`
                                        }
                                    },
                                    { type: "text", text: textMsg }
                                ]
                            }]
                        });
                        await this.handleAIResponse(e, response);
                        return;
                    }
                }

                // 引用消息+文本对话
                const quotedMsg = await this.ctx.getQuoteMessage(e);
                if (quotedMsg?.message) {
                    const content = this.ctx.getText(quotedMsg).trim();
                    if (content) {
                        const response = await this.openai.chat.completions.create({
                            model: baseConfig.OPENAI.models.text,
                            messages: [
                                { role: "system", content: baseConfig.BOT.systemPrompt },
                                { role: "user", content: content },
                                { role: "user", content: textMsg }
                            ]
                        });
                        await this.handleAIResponse(e, response);
                        return;
                    }
                }

                // 纯文本对话
                const response = await this.openai.chat.completions.create({
                    model: baseConfig.OPENAI.models.text,
                    messages: [
                        { role: "system", content: baseConfig.BOT.systemPrompt },
                        { role: "user", content: textMsg }
                    ]
                });
                await this.handleAIResponse(e, response);

            } finally {
                timer.end();
            }
        } catch (error) {
            console.error('消息处理失败:', error);
            await e.reply('处理消息时发生错误，请稍后重试');
        } finally {
            if (thinkingMsg?.message_id) {
                try {
                    await this.ctx.delete_msg(thinkingMsg.message_id);
                } catch (error) {
                    console.error('撤回消息失败:', error);
                }
            }
        }
    }

    private async handleAIResponse(e: any, response: any) {
        const timer = utils.timeLog('AI Response Processing');
        try {
            const markdown = response.choices[0]?.message?.content;
            if (!markdown) {
                throw new BotError('AI 返回内容为空', 'EMPTY_RESPONSE');
            }

            const htmlResponse = await fetch(baseConfig.RENDER.markdownApi, {
                method: 'POST',
                headers: { 'Content-Type': 'text/markdown' },
                body: markdown
            });
            
            if (!htmlResponse.ok) {
                throw new BotError(`HTTP error! status: ${htmlResponse.status}`, 'MARKDOWN_CONVERSION_ERROR');
            }
            
            const html = await htmlResponse.text();
            if (!html) {
                throw new BotError('HTML内容为空', 'EMPTY_HTML');
            }

            const processedHtml = utils.processLocalImagePaths(html);
            const timestamp = Date.now();
            const imageFileName = `${timestamp}.png`;
            const imagePath = path.join(this.tempDir, imageFileName);

            const browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu'
                ],
                timeout: baseConfig.RENDER.timeout
            });

            try {
                const page = await browser.newPage();
                await page.setViewport({
                    width: baseConfig.RENDER.width,
                    height: baseConfig.RENDER.initialHeight
                });

                await page.setContent(processedHtml, {
                    waitUntil: 'networkidle0'
                });

                const bodyHandle = await page.$('body');
                const { height } = await bodyHandle!.boundingBox() || { height: 0 };
                await bodyHandle!.dispose();

                await page.setViewport({
                    width: baseConfig.RENDER.width,
                    height: Math.ceil(height)
                });

                await page.screenshot({
                    path: imagePath,
                    fullPage: true
                });

                const imageBuffer = await fs.promises.readFile(imagePath);
                const base64Image = imageBuffer.toString('base64');
                
                await this.ctx.bot.send_group_msg({
                    group_id: e.group_id,
                    message: [{
                        type: "image",
                        data: {
                            file: `base64://${base64Image}`,
                            summary: "[图片]"
                        }
                    }]
                });

                await fs.promises.unlink(imagePath);
            } finally {
                await browser.close();
            }
        } catch (error) {
            if (error instanceof BotError) {
                console.error(`Bot错误 [${error.code}]:`, error.message, error.details);
            } else {
                console.error('未知错误:', error);
            }
            throw error;
        } finally {
            timer.end();
        }
    }
}

// 插件定义
export default definePlugin({
    name: '阿里百炼',
    version: '1.0.0',
    async setup(ctx) {
        const messageHandler = new MessageHandler(ctx);
        ctx.handle('message.group', e => messageHandler.handleMessage(e));
    }
});
