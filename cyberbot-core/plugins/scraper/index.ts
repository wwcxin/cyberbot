import {definePlugin, Structs, http} from "../../src"
import { fetchLatestNotice } from './helper'
import * as cheerio from 'cheerio';

let lastCreatedTime = 0;
const enableGroup = [
  635606882,623882084
]

export default definePlugin({
  // 插件名应和文件名一致, 不然可能会出问题
  name: "scraper",
  description: "爬虫",
  setup: (ctx) => {
    ctx.handle("message", async (e) => {
      if('group_id' in e && !(enableGroup.includes(e.group_id))) return;
      // 处理群消息
      if(e.raw_message === "#最新公告"){
        const response = await fetchLatestNotice()
        if(!response.status || !response.text){
          return;
        }
        const replyMsg = buildReplyMessage(response.text, response.urls);
        e.reply(replyMsg);
      }else if(e.raw_message === "#下载阴阳师"){
        const link = await getAndroidDownloadLink()
        e.reply("🚀 全渠道版本阴阳师APK:\n" + link);
  
      }
    }),
    ctx.cron([
      [
        '*/5 * * * *', // 每5秒执行一次
        async (ctx, e) => {

          const response = await fetchLatestNotice()
          if (!response.status || response.createTime === lastCreatedTime) return;

          lastCreatedTime = response.createTime
          const replyMsg = buildReplyMessage(response.text, response.urls);

          for (const groupId of enableGroup) {
            ctx.sendGroupMessage(groupId, replyMsg);
          }
        }
      ]
    ])
  }
})

// 构建回复消息
const buildReplyMessage = (text: string, urls: string[]): any[] | string => {
  const imageSegments = urls.map(url => Structs.image(url));
  return imageSegments.length > 0 ? [Structs.text(text), ...imageSegments] : text;
}
//获取下载链接
const getAndroidDownloadLink = async () => {
  try {
      // 使用Axios获取网页内容
      const response = await http.get('https://mumu.163.com/games/14372.html');
      const html = response.data;

      // 使用Cheerio解析HTML
      const $ = cheerio.load(html);

      // 选择包含安卓版下载链接的元素
      const androidLink = $('.btn_android').attr('href');
      console.log("link:" + androidLink)

      if (androidLink) {
          return androidLink
      } else {
          return '未找到apk下载链接';
      }
  } catch (error) {
      return '获取网页内容失败:';
  }
}