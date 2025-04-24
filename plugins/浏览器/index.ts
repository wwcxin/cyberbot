import { definePlugin } from '../../src';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';

// 浏览器实例
let browser: Browser | null = null;

class BrowserService {
    private static instance: BrowserService;
    private browser: Browser | null = null;
    private pagePool: Page[] = [];
    private maxPages = 3; // 最大并发数

    private constructor() { }

    public static getInstance(): BrowserService {
        if (!BrowserService.instance) {
            BrowserService.instance = new BrowserService();
        }
        return BrowserService.instance;
    }

    public async initialize() {
        if (!this.browser) {
            this.browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
        }
    }

    public async getBrowser(): Promise<Browser> {
        if (!this.browser) {
            await this.initialize();
        }
        return this.browser!;
    }

    public async createPage(): Promise<Page> {
        if (this.pagePool.length >= this.maxPages) {
            // 等待一个页面释放
            await new Promise(resolve => setTimeout(resolve, 1000));
            return this.createPage();
        }
        
        const browser = await this.getBrowser();
        const page = await browser.newPage();
        this.pagePool.push(page);
        return page;
    }

    public async releasePage(page: Page) {
        const index = this.pagePool.indexOf(page);
        if (index > -1) {
            this.pagePool.splice(index, 1);
        }
        await page.close();
    }

    public async cleanup() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}

export default definePlugin({
    name: '浏览器',
    version: '1.0.0',
    description: '浏览器服务插件 - 提供无头浏览器渲染服务',
    setup: async () => {
        try {
            console.log('初始化浏览器服务...');
            await BrowserService.getInstance().initialize();
            console.log('浏览器服务初始化成功');

            // 注册进程退出时的清理函数
            process.on('exit', async () => {
                console.log('清理浏览器资源...');
                await BrowserService.getInstance().cleanup();
            });

            // 注册意外退出的处理
            process.on('SIGINT', async () => {
                console.log('收到退出信号，清理资源...');
                await BrowserService.getInstance().cleanup();
                process.exit();
            });
        } catch (error) {
            console.error('浏览器服务初始化失败:', error);
            throw error;
        }
    }
});

// 导出浏览器服务类，供其他插件使用
export { BrowserService };