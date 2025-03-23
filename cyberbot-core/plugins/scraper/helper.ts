import axios from 'axios';

// 配置项
const config = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    acceptHeader: 'application/json, text/plain, */*',
    feedsUrl: 'https://inf.ds.163.com/v1/web/feed/basic/getSomeOneFeeds?feedTypes=1,2,3,4,6,7,10,11&someOneUid=5b00c224c7de46d98d33a6e0722ce28f'
};

// 返回结果类型
interface NoticeResults {
    status: boolean;
    text: string;
    urls: string[];
    createTime: number;
    message?: string;
}

const fetchLatestNotice = async (): Promise<NoticeResults> => {
    try {
        const headers = {
            'User-Agent': config.userAgent,
            'Accept': config.acceptHeader
        };

        const response = await axios.get(config.feedsUrl, { headers });

        if (response.status === 200 && response.data.result?.feeds?.length > 0) {
            const { createTime, content } = response.data.result.feeds[0];
            const parsedContent = JSON.parse(content);
            const imageMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
            // 过滤出有效的图片 URL
            const urls = (parsedContent.body.media || []).filter((item: { mimeType: string; }) => 
                imageMimeTypes.includes(item.mimeType)
            ).map((item: { url: any; }) => item.url);

            return {
                status: true,
                text: parsedContent.body.text,
                urls: urls,
                createTime
            };
        } else {
            throw new Error(`Request failed with status code ${response.status}`);
        }
    } catch (error) {
        console.error('Error occurred:', error);
        return {
            status: false,
            text: '获取失败',
            urls: [],
            createTime: 0,
            message: error instanceof Error ? error.message : String(error)
        };
    }
};

export { fetchLatestNotice };