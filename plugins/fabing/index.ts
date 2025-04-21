import { definePlugin, http } from '../../src'

export default definePlugin({
  name: 'fabing',
  version: '1.0.0',
  setup: (ctx) => {
    ctx.handle('message.group', async (e) => {
      const reg = /^\s*(每日)?(发病|发癫)\s*(.*)$/
      const matches = e.raw_message.match(reg)

      if (matches) {
        const name = matches[2] || (e.sender.card ?? e.sender.nickname)
        const { message_id } = await e.reply(await fetchFbMsgs(name))
        //延时3s
        setTimeout(() => {
            ctx.delete_msg(message_id)
        }, 60000)
      }
    })

    ctx.handle('notice', async (e) => {
        console.log("poke:" + JSON.stringify(e));
        if(!('group_id' in e  && e.notice_type =="notify"  && e.sub_type === "poke")) return;
        
        const { target_id, user_id } = e
        console.log(target_id, user_id);
        console.log(ctx.bot_uin);

        if (target_id === ctx.bot_uin) {
          const member = await ctx.bot.get_group_member_info({group_id:e.group_id, user_id: user_id})
          const msg = await fetchFbMsgs((member.card || user_id).toString())
          const { message_id } = await ctx.sendGroupMessage(e.group_id, msg)
          //延时60s
          setTimeout(() => {
              ctx.delete_msg(message_id)
          }, 60000)
        }
    })
  },
})

async function fetchFbMsgs(name: string) {
  const { data } = await http.get('https://fb.viki.moe', { params: { name } })
  return data
}
