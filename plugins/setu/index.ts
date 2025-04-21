import { definePlugin, Structs, http } from '../../src'

const enableGroup = [937649829]

export default definePlugin({
  name: 'setu',
  version: '1.0.0',
  setup(ctx) {
    async function fetchFbMsgs() {
      const { data } = await http.get('https://api.lolicon.app/setu/v2')
      return data
    }
    // 监听好友消息
    ctx.handle('message', async e => {
      if('group_id' in e && !enableGroup.includes(e.group_id)) return;
      if (['涩图', 'setu'].includes(e.raw_message)) {
        ctx.bot.set_msg_emoji_like({message_id: e.message_id,emoji_id: "424"})
        const data = await fetchFbMsgs()
        const dataDict = data.data;
        if (!dataDict || dataDict.length === 0) {
          return;
        }
        const title = "标题：" + dataDict[0].title + '\n';
        const tags = "标签：" + JSON.stringify(dataDict[0].tags) + '\n';
        const url = dataDict[0].urls.original;
        ctx.bot.set_msg_emoji_like({message_id: e.message_id,emoji_id: "424"})
        const {message_id} = await e.reply([Structs.text(title), Structs.text(tags), Structs.image(url)])
        //延时3s
        setTimeout(() => {
          ctx.delete_msg(message_id)
        }, 30000)
      }
    })
  },
})
