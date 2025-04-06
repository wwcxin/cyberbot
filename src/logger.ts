import pino from "pino";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
// @ts-ignore
import * as cron from "node-cron";

// 从index.ts导入Config类型，但避免循环依赖问题
interface Config {
  logger: {
    level: string,
    maxSize: string,
    maxDays: number
  }
}

// 日志路径
const logPath = join(process.cwd(), "log");
// 确保日志目录存在
if (!existsSync(logPath)) {
  mkdirSync(logPath, { recursive: true });
}

/**
 * 初始化日志系统
 * @param config 应用配置
 * @returns 配置好的日志记录器
 */
export function initLogger(config: Config) {
  // 创建Pino日志系统，使用更简单的配置确保稳定性
  const loggerOptions = {
    level: config.logger.level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
        messageFormat: '{level} {time} {msg}'
      }
    }
  };

  // 确保Windows环境下正确显示中文
  // 这只在启动时执行一次，不会影响性能
  if (process.platform === 'win32') {
    // 设置控制台代码页为UTF-8
    try {
      const { execSync } = require('child_process');
      execSync('chcp 65001', { stdio: 'ignore' });
    } catch (e) {
      // 忽略错误
    }
  }

  // 创建日志记录器
  // @ts-ignore - 解决TypeScript类型问题
  const baseLogger = pino(loggerOptions);
  
  // 增强logger对象，添加文件写入功能
  enhanceLogger(baseLogger);
  
  // 启动时清理一次过期日志，然后每天定时清理
  cleanupOldLogs(config);
  // 每天凌晨2点执行清理
  cron.schedule('0 2 * * *', () => cleanupOldLogs(config));
  
  return baseLogger;
}

/**
 * 增强logger对象，添加文件写入功能
 * @param logger pino日志记录器实例
 */
function enhanceLogger(logger: any) {
  // 保存原始方法
  const originalInfo = logger.info;
  const originalError = logger.error;
  const originalWarn = logger.warn;
  
  // 重写info方法
  logger.info = function(obj: any, msg?: string) {
    try {
      // 调用原始的info方法
      originalInfo.apply(this, [obj, msg]);
      
      // 写入到文件
      if (typeof obj === 'object' && msg) {
        writeLogToFile(`${msg} ${JSON.stringify(obj)}`, 'info');
      } else if (typeof obj === 'string') {
        writeLogToFile(obj, 'info');
      }
    } catch (error) {
      console.error("日志记录错误:", error);
    }
    
    return this;
  }
  
  // 重写error方法
  logger.error = function(obj: any, msg?: string) {
    try {
      // 调用原始的error方法
      originalError.apply(this, [obj, msg]);
      
      // 写入到文件
      if (typeof obj === 'object' && msg) {
        writeLogToFile(`${msg} ${JSON.stringify(obj)}`, 'error');
      } else if (typeof obj === 'string') {
        writeLogToFile(obj, 'error');
      }
    } catch (error) {
      console.error("日志记录错误:", error);
    }
    
    return this;
  }
  
  // 重写warn方法
  logger.warn = function(obj: any, msg?: string) {
    try {
      // 调用原始的warn方法
      originalWarn.apply(this, [obj, msg]);
      
      // 写入到文件
      if (typeof obj === 'object' && msg) {
        writeLogToFile(`${msg} ${JSON.stringify(obj)}`, 'warn');
      } else if (typeof obj === 'string') {
        writeLogToFile(obj, 'warn');
      }
    } catch (error) {
      console.error("日志记录错误:", error);
    }
    
    return this;
  }
}

/**
 * 向日志文件写入消息
 * @param msg 消息内容
 * @param level 日志级别
 */
function writeLogToFile(msg: string, level: string = 'info') {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD格式
  const timeStr = now.toLocaleTimeString('zh-CN');
  const logLine = `[${level.toUpperCase()}] ${timeStr} ${msg}\n`;
  
  try {
    const logFile = join(logPath, `${dateStr}.log`);
    // 显式指定UTF-8编码
    writeFileSync(logFile, logLine, { flag: 'a', encoding: 'utf8' });
  } catch (err) {
    console.error(`写入日志文件失败: ${err}`);
  }
}

/**
 * 清理过期日志文件
 * @param config 应用配置
 */
function cleanupOldLogs(config: Config) {
  try {
    const logFiles = readdirSync(logPath)
      .filter(file => file.endsWith('.log') || file.endsWith('.log.gz'))
      .map(file => ({
        name: file,
        path: join(logPath, file),
        // 从文件名中提取日期（格式假设为YYYY-MM-DD.log或YYYY-MM-DD.log.gz）
        date: new Date(file.replace(/\.log(\.gz)?$/, ''))
      }))
      .filter(file => !isNaN(file.date.getTime())); // 过滤掉无效日期的文件
    
    // 根据日期进行排序（从新到旧）
    logFiles.sort((a, b) => b.date.getTime() - a.date.getTime());
    
    // 保留最新的配置中指定天数的日志文件，删除其余的
    const filesToKeep = config.logger.maxDays;
    if (logFiles.length > filesToKeep) {
      logFiles.slice(filesToKeep).forEach(file => {
        try {
          const { unlinkSync } = require('fs');
          unlinkSync(file.path);
          console.log(`已删除过期日志文件: ${file.name}`);
        } catch (err) {
          console.error(`删除日志文件失败: ${file.name}`, err);
        }
      });
    }
  } catch (err) {
    console.error('清理日志文件时出错:', err);
  }
} 