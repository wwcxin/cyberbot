import log4js from 'log4js';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// 日志配置接口
interface LoggerConfig {
  level: string;
  maxSize: string;
  maxDays: number;
}

// 默认日志配置
const defaultLoggerConfig: LoggerConfig = {
  level: 'info',
  maxSize: '10m',
  maxDays: 3
};

export class Logger {
  private logger!: log4js.Logger;
  private config: LoggerConfig;

  constructor(category: string = 'default', config?: LoggerConfig) {
    this.config = config || this.loadConfig() || defaultLoggerConfig;
    this.configureLogger(category);
  }

  private loadConfig(): LoggerConfig | null {
    try {
      const configPath = 'config.json';
      if (existsSync(configPath)) {
        const configData = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configData);
        if (config.logger) {
          return config.logger;
        }
      }
      return null;
    } catch (error) {
      console.error('加载日志配置失败:', error);
      return null;
    }
  }

  private configureLogger(category: string): void {
    // 确保日志目录存在
    const logDir = join(process.cwd(), 'logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    // 计算最大日志大小（确保每天小于10MB）
    const maxSize = Math.min(this.parseSize(this.config.maxSize), 10 * 1024 * 1024);

    log4js.configure({
      appenders: {
        console: {
          type: 'console',
          layout: {
            type: 'pattern',
            pattern: '%[%d{yyyy-MM-dd hh:mm:ss.SSS} %p%] %m'
          }
        },
        file: {
          type: 'file',
          filename: join(logDir, `${category}.log`),
          maxLogSize: maxSize,
          backups: this.config.maxDays,
          compress: true,
          // 添加压缩选项
          compressBackups: true,
          // 使用更高效的压缩
          compressionLevel: 9
        },
        dateFile: {
          type: 'dateFile',
          filename: join(logDir, `${category}`),
          pattern: 'yyyy-MM-dd.log',
          keepFileExt: true,
          alwaysIncludePattern: true,
          numBackups: this.config.maxDays,
          // 添加压缩选项
          compress: true,
          // 使用更高效的压缩
          compressionLevel: 9
        }
      },
      categories: {
        default: { 
          appenders: ['console', 'file', 'dateFile'], 
          level: this.config.level 
        }
      }
    });
    
    this.logger = log4js.getLogger(category);
  }

  private parseSize(size: string): number {
    const units: { [key: string]: number } = {
      'b': 1,
      'k': 1024,
      'm': 1024 * 1024,
      'g': 1024 * 1024 * 1024
    };
    
    const match = size.match(/^(\d+)([bkmg])$/i);
    if (!match) {
      return 10 * 1024 * 1024; // 默认 10MB
    }
    
    const [, value, unit] = match;
    return parseInt(value) * (units[unit.toLowerCase()] || 1);
  }

  info(message: string): void {
    this.logger.info(message);
  }

  warn(message: string): void {
    this.logger.warn(message);
  }

  error(message: string, error?: any): void {
    if (error) {
      this.logger.error(`${message} ${error.message || error}`);
    } else {
      this.logger.error(message);
    }
  }

  debug(message: string): void {
    this.logger.debug(message);
  }

  trace(message: string): void {
    this.logger.trace(message);
  }
}

// 创建全局 logger 实例
export const logger = new Logger('cyberbot-log');