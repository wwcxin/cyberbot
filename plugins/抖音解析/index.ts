import { definePlugin, Structs } from '../../src'
import { BrowserService } from '../浏览器';
import path from 'path'
import fs from 'fs'

// 基础配置
const config = {
    // 抖音链接匹配模式
    URL_PATTERNS: [
        /https?:\/\/v\.douyin\.com\/[A-Za-z0-9]+\/?/,  // 短链接
        /https?:\/\/www\.douyin\.com\/video\/[0-9]+/  // 长链接
    ]
}

// 抖音解析器类
class DouyinParser {
    private static instance: DouyinParser
    private browser: BrowserService

    private constructor() {
        this.browser = BrowserService.getInstance()
    }

    public static getInstance(): DouyinParser {
        if (!DouyinParser.instance) {
            DouyinParser.instance = new DouyinParser()
        }
        return DouyinParser.instance
    }

    // 检测是否为抖音链接
    public isDouyinUrl(url: string): boolean {
        return config.URL_PATTERNS.some(pattern => pattern.test(url))
    }

    // 添加新的备选解析方法
    private async parseAlternative(url: string): Promise<string> {
        const page = await this.browser.createPage();
        
        try {
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });

            // 等待视频元素加载
            await page.waitForSelector('video', { timeout: 5000 });

            // 尝试多种方式获取视频直链
            const videoUrl = await page.evaluate(() => {
                // 1. 直接从video标签获取
                const video = document.querySelector('video') as HTMLVideoElement | null;
                if (video?.src) return video.src;

                // 2. 从source标签获取
                const source = document.querySelector('video source') as HTMLSourceElement | null;
                if (source?.src) return source.src;

                // 3. 从页面数据中获取
                const scripts = Array.from(document.getElementsByTagName('script'));
                for (const script of scripts) {
                    const content = script.textContent || '';
                    // 匹配视频地址
                    const urlMatch = content.match(/\"(http[^\"]+\.mp4[^\"]*)\"/);
                    if (urlMatch) return urlMatch[1];
                }

                return null;
            });

            if (!videoUrl) {
                throw new Error('备选方案未能获取到视频地址');
            }

            return videoUrl;

        } finally {
            await page.close();
        }
    }

    // 主要解析方法
    private async _parseMain(url: string): Promise<string> {
        const page = await this.browser.createPage();

        try {
            // 设置请求拦截
            await page.setRequestInterception(true);

            let videoUrl: string | null = null;

            // 监听所有请求
            page.on('request', request => {
                const reqUrl = request.url();

                // 如果是视频资源请求，记录URL并中断请求
                if (reqUrl.includes('douyinvod.com/') ||
                    reqUrl.includes('aweme.snssdk.com/') ||
                    reqUrl.includes('api.amemv.com/')) {
                    videoUrl = reqUrl;
                    request.abort();
                    return;
                }

                // 如果是图片、字体等资源，直接中断
                if (['image', 'font', 'stylesheet'].includes(request.resourceType())) {
                    request.abort();
                    return;
                }

                // 其他请求放行
                request.continue();
            });

            // 监听响应
            page.on('response', response => {
                const respUrl = response.url();
                // 检查重定向响应
                if (response.status() === 302) {
                    const location = response.headers()['location'];
                    if (location && (
                        location.includes('douyinvod.com/') ||
                        location.includes('aweme.snssdk.com/') ||
                        location.includes('api.amemv.com/')
                    )) {
                        videoUrl = location;
                    }
                }
            });

            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            }).catch(() => { });

            if (!videoUrl) {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            if (!videoUrl) {
                throw new Error('未能获取到视频地址');
            }

            return videoUrl;

        } finally {
            await page.close();
        }
    }

    // 修改原有的parse方法
    public async parse(url: string): Promise<{url: string; isDirectLink: boolean}> {
        try {
            const videoUrl = await this._parseMain(url);  // 使用主要解析方法
            return { url: videoUrl, isDirectLink: false };
        } catch (error) {
            console.log('主要解析方法失败，尝试备选方案...');
            try {
                const directUrl = await this.parseAlternative(url);
                return { url: directUrl, isDirectLink: true };
            } catch (alternativeError) {
                throw new Error(`视频解析失败。主要方法：${error.message}，备选方案：${alternativeError.message}`);
            }
        }
    }
}

export default definePlugin({
    name: '抖音解析',
    version: '1.1.1',  // 更新版本号
    description: '抖音视频解析插件 - 支持无水印视频下载，支持视频直链获取',
    async setup(ctx) {
        // 确保临时文件夹存在
        const tempDir = path.join(__dirname, 'temp')
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir)
        }

        // 获取解析器实例
        const parser = DouyinParser.getInstance()

        // 注册消息处理器
        ctx.handle('message', async e => {
            const text = ctx.getText(e)

            try {
                const urls = text.match(/https?:\/\/[^\s]+/g)
                if (!urls) return

                for (const url of urls) {
                    if (!parser.isDouyinUrl(url)) continue

                    const processingMsg = await e.reply('正在解析抖音视频，请稍候...')

                    try {
                        const result = await parser.parse(url)
                        
                        try {
                            // 尝试发送视频
                            if (!result.isDirectLink) {
                                await e.reply([Structs.video(result.url)])
                            } else {
                                throw new Error('使用备选方案') // 触发发送直链
                            }
                        } catch (sendError) {
                            // 如果发送视频失败，发送直链
                            await e.reply([
                                '无法直接发送视频，这是视频直链：\n',
                                result.url,
                                '\n(可以复制链接到浏览器打开)'
                            ].join(''))
                        }

                    } catch (error) {
                        await e.reply(`视频解析失败: ${error.message}`, true)
                    } finally {
                            if (processingMsg && processingMsg.message_id && e.message_type == "group") {
                            await ctx.delete_msg(processingMsg.message_id)
                        }
                    }
                }
            } catch (error) {
                console.error('视频解析出错:', error)
            }
        })
    }
}) 
