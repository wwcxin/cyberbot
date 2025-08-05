import {definePlugin, log, http, Structs} from "../../src"
import * as fs from 'fs'
import * as path from 'path'

/**
 * 该插件依赖【bilidown】项目，请先安装该项目并启动服务
 * 项目地址 https://github.com/wwcxin/bilidown
 */

// 配置项
const BILIDOWN_API_BASE = "http://127.0.0.1:8098";
const POLL_INTERVAL = 3000; // 轮询间隔3秒
const MAX_WAIT_TIME = 300000; // 最大等待时间5分钟
const DOWNLOAD_DIR = path.join(__dirname, 'downloads'); // 下载目录

// 任务状态接口
interface TaskStatus {
  task_id: number;
  status: 'waiting' | 'running' | 'done' | 'error';
  download_url?: string;
  error?: string;
}

// 下载任务响应接口
interface DownloadResponse {
  success: boolean;
  message: string;
  data: {
    task_id: number;
    title: string;
  };
}

export default definePlugin({
  name: "Bilidown",
  description: "B站视频下载插件",
  setup: (ctx) => {
    // 确保下载目录存在
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
    
    // 检测B站视频链接 - 简化逻辑，直接匹配所有可能的B站链接
    const extractBilibiliUrl = (message: string): string | null => {
      // 匹配所有可能的B站视频链接格式
      const bilibiliPattern = /https?:\/\/(?:www\.|m\.)?(?:bilibili\.com\/video\/|b23\.tv\/)([^\s]+)/i;
      const match = message.match(bilibiliPattern);
      
      if (match) {
        // 直接返回完整的原始链接，让API自己处理
        return match[0];
      }
      
      return null;
    };
    
    // 创建下载任务
    const createDownloadTask = async (url: string): Promise<DownloadResponse> => {
        const response = await http.post(`${BILIDOWN_API_BASE}/api/downloadVideoByURL`, {
          url: url,
        format: 80
        });
        return response.data;
    };
    
    // 获取任务状态
    const getTaskStatus = async (taskId: number): Promise<TaskStatus> => {
        const response = await http.get(`${BILIDOWN_API_BASE}/api/getTaskStatus?task_id=${taskId}`);
        return response.data.data;
    };
    
    // 轮询任务状态直到完成
    const waitForTaskCompletion = async (taskId: number): Promise<TaskStatus> => {
      const startTime = Date.now();
      
      while (true) {
          const status = await getTaskStatus(taskId);
          
          if (Date.now() - startTime > MAX_WAIT_TIME) {
            throw new Error('下载超时');
          }
          
          if (status.status === 'done') {
            return status;
          } else if (status.status === 'error') {
            throw new Error(status.error || '下载失败');
          }
          
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      }
    };
    
    // 下载视频文件
    const downloadVideoFile = async (downloadUrl: string, fileName: string): Promise<Buffer> => {
        const response = await http.get(downloadUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        
        const filePath = path.join(DOWNLOAD_DIR, fileName);
        fs.writeFileSync(filePath, buffer);
      
      // 日志：本地下载的路径
      log.info(`[Bilidown] 本地下载的路径: ${filePath}`);
        
        return buffer;
    };
    
    // 处理群消息
    ctx.handle("message.group", async (e) => {
      const message = e.raw_message;
      const bilibiliUrl = extractBilibiliUrl(message);
      
      if (!bilibiliUrl) {
        return;
      }
      
      try {
        // 回应开始解析的消息
        // await e.reply("🎬 检测到B站视频链接，正在解析...");
        
        // 向API接口请求
        const downloadResponse = await createDownloadTask(bilibiliUrl);
        
        if (!downloadResponse.success) {
          await e.reply(`❌ 创建下载任务失败: ${downloadResponse.message}`);
          return;
        }
        
        const taskId = downloadResponse.data.task_id;
        const title = downloadResponse.data.title;
        
        await e.reply(`📥 开始下载: ${title}\n⏳ 任务ID: ${taskId}\n🔄 正在下载中，请稍候...`);
        
        // 创建循环查询状态
        const status = await waitForTaskCompletion(taskId);
        
                // 下载完成后下载至插件临时文件夹
        const downloadUrl = `${BILIDOWN_API_BASE}/api/downloadVideo?task_id=${taskId}`;
        const fileName = `${taskId}_${Date.now()}.mp4`;
        
        // 日志：服务端返回的视频链接
        log.info(`[Bilidown] 服务端返回的视频链接: ${downloadUrl}`);
        
        const videoBuffer = await downloadVideoFile(downloadUrl, fileName);
              
        // 发送文件
              await e.reply([
                Structs.video(videoBuffer, title)
              ]);
              
        // 立即删除临时文件
        const filePath = path.join(DOWNLOAD_DIR, fileName);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        
      } catch (error) {
        await e.reply(`❌ 处理失败: ${error.message}`);
      }
    });
  }
}) 