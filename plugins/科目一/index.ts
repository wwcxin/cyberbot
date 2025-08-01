import {definePlugin, log, Structs} from "../../src"
import * as fs from 'fs'
import * as path from 'path'

// 用户状态接口
interface UserState {
  groupId: number;
  userId: number;
  currentQuestion: any;
  isWaitingForAnswer: boolean;
  startTime: number;
}

// 题目数据接口
interface QuestionData {
  id: string;
  question: string;
  answer: string;
  answerSkill: string;
  answerSkillExplain: string;
  itemsTitleArray: string[];
  itemsDescArray: string[];
  type: number;
  chapterId: string;
  difficulty: number;
  url: string;
  remark: string;
}

export default definePlugin({
  name: "科目一",
  description: "科目一练习",
  setup: (ctx) => {
    // 内存缓存
    let questionBank: QuestionData[] = [];
    let userStates: Map<string, UserState> = new Map();
    let questionBankLoaded = false;

    // 加载题库数据
    const loadQuestionBank = () => {
      try {
        const filePath = path.join(__dirname, 'kmy.json');
        const data = fs.readFileSync(filePath, 'utf8');
        questionBank = JSON.parse(data);
        questionBankLoaded = true;
        log.info(`[科目一] 题库加载成功，共 ${questionBank.length} 道题`);
      } catch (error) {
        log.error(`[科目一] 题库加载失败: ${error}`);
      }
    };

    // 随机抽取题目
    const getRandomQuestion = (): QuestionData => {
      const randomIndex = Math.floor(Math.random() * questionBank.length);
      return questionBank[randomIndex];
    };

    // 生成题目消息
    const generateQuestionMessage = (question: QuestionData): any[] => {
      const messages: any[] = [];
      
      // 添加题目文本
      messages.push(`【科目一练习】\n${question.question}\n`);
      
      // 添加选项
      question.itemsTitleArray.forEach((title, index) => {
        messages.push(`${title}. ${question.itemsDescArray[index]}\n`);
      });
      
      // 添加图片（如果有）
      if (question.url && question.url.trim() !== '') {
        messages.push(Structs.image(question.url));
      }
      
      return messages;
    };

    // 检查答案
    const checkAnswer = (userAnswer: string, correctAnswer: string): boolean => {
      const normalizedUserAnswer = userAnswer.trim().toUpperCase();
      const normalizedCorrectAnswer = correctAnswer.trim().toUpperCase();
      
      // 如果答案完全匹配，直接返回true
      if (normalizedUserAnswer === normalizedCorrectAnswer) {
        return true;
      }
      
      // 处理多选题答案格式
      // 支持多种格式：A,B,C,D 或 ABCD 或 A B C D
      if (normalizedCorrectAnswer.includes(',')) {
        // 移除所有分隔符（逗号、空格、点等）
        const cleanUserAnswer = normalizedUserAnswer.replace(/[,.\s]/g, '');
        const cleanCorrectAnswer = normalizedCorrectAnswer.replace(/[,.\s]/g, '');
        
        // 检查字母是否相同（顺序无关）
        const userLetters = cleanUserAnswer.split('').sort().join('');
        const correctLetters = cleanCorrectAnswer.split('').sort().join('');
        
        return userLetters === correctLetters;
      }
      
      return false;
    };

    // 生成答案反馈消息
    const generateAnswerFeedback = (isCorrect: boolean, question: QuestionData): string => {
      if (isCorrect) {
        return `✅ 回答正确！\n\n💡 答题技巧：${question.answerSkill}\n\n📖 详细解释：${question.answerSkillExplain}`;
      } else {
        return `❌ 回答错误！\n\n正确答案：${question.answer}\n\n💡 答题技巧：${question.answerSkill}\n\n📖 详细解释：${question.answerSkillExplain}`;
      }
    };

    // 清理超时的用户状态（5分钟超时）
    const cleanupExpiredStates = () => {
      const now = Date.now();
      const timeout = 5 * 60 * 1000; // 5分钟
      
      for (const [key, state] of userStates.entries()) {
        if (now - state.startTime > timeout) {
          userStates.delete(key);
          log.info(`[科目一] 清理超时用户状态: ${key}`);
      }
      }
    };

    // 定期清理超时状态
    setInterval(cleanupExpiredStates, 60000); // 每分钟检查一次

    ctx.handle("message.group", async (e) => {
      const groupId = e.group_id;
      const userId = e.user_id;
      const userKey = `${groupId}_${userId}`;

      // 处理"科目一"命令
      if (e.raw_message === "科目一") {
        // 首次加载题库
        if (!questionBankLoaded) {
          loadQuestionBank();
          if (!questionBankLoaded) {
            await e.reply("题库加载失败，请稍后重试");
            return;
      }
        }

        // 检查用户是否已在答题中
        if (userStates.has(userKey)) {
          const state = userStates.get(userKey)!;
          if (state.isWaitingForAnswer) {
            await e.reply("您正在答题中，请先回答当前题目或等待超时");
            return;
      }
        }

        // 随机抽取题目
        const question = getRandomQuestion();
        
        // 更新用户状态
        userStates.set(userKey, {
          groupId,
          userId,
          currentQuestion: question,
          isWaitingForAnswer: true,
          startTime: Date.now()
        });

        log.info(`[科目一] 用户 ${userId} 在群 ${groupId} 开始答题，题目ID: ${question.id}`);
      
        // 发送题目
        const questionMessages = generateQuestionMessage(question);
        await e.reply(questionMessages);
      }
      
      // 处理答案回复
      else if (userStates.has(userKey)) {
        const state = userStates.get(userKey)!;
        
        if (state.isWaitingForAnswer) {
          const userAnswer = e.raw_message.trim().toUpperCase();
          const correctAnswer = state.currentQuestion.answer;
          
          // 检查答案格式（支持单个字母或多个字母组合）
          const validAnswerPattern = /^[A-Da-d]+$/;
          if (!validAnswerPattern.test(userAnswer)) {
            // 忽略不相关的消息，不回复任何内容
            return;
          }

          // 检查答案
          const isCorrect = checkAnswer(userAnswer, correctAnswer);
          
          // 生成反馈消息
          const feedback = generateAnswerFeedback(isCorrect, state.currentQuestion);
          
          // 发送反馈
          await e.reply(feedback);
          
          // 清理用户状态
          userStates.delete(userKey);
          
          log.info(`[科目一] 用户 ${userId} 在群 ${groupId} 答题完成，答案: ${userAnswer}，正确: ${isCorrect}`);
        }
      }
    });

    // 注意：内存清理通过定期清理和用户状态管理自动处理
    // 用户状态会在5分钟后自动超时清理
    // 题库数据在插件重启时会重新加载
  }
})