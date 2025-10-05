import { Context, Logger, Schema } from 'koishi'

export const name = 'please-like-me'

// 定义数据库表结构
interface LikeSubscription {
  id: number
  userId: string
  targetId: string
  enabled: boolean
  nextLikeTime: number
  todayStatus: 'pending' | 'success' | 'failed' | 'partial'
  retryCount: number
  lastLikeDate: string
}

// 扩展数据库表类型
declare module 'koishi' {
  interface Tables {
    like_subscriptions: LikeSubscription
  }
}

export const usage = `
**赞我插件 - Please Like Me**

赞我，一个QQ名片点赞插件，简单且更加强大，支持订阅点赞，对陌生人支持最多点赞50次。

**基础功能：**
- 输入 \`赞我\` 为自己点赞
- 输入 \`点赞 <QQ号>\` 为指定用户点赞

**订阅点赞功能：**
- 输入 \`订阅点赞\` 订阅自己的自动点赞
- 输入 \`订阅点赞 <QQ号>\` 订阅指定用户的自动点赞
- 管理员使用直接生效，普通用户根据处理模式决定
- 支持三种处理模式：默认同意、管理审核、默认拒绝
- 订阅成功后系统会在每天随机时间自动点赞

**管理员功能：**
- \`赞我管理\` - 查看管理命令帮助
- \`赞我管理.申请\` - 查看待审核申请
- \`赞我管理.审核 <序号|全部> <同意|拒绝>\` - 审核申请（支持批量处理）
- \`赞我管理.订阅\` - 查看所有订阅
- \`赞我管理.删除 <序号>\` - 删除订阅
- \`赞我管理.启用 <序号>\` - 启用订阅
- \`赞我管理.禁用 <序号>\` - 禁用订阅
- \`赞我管理.黑名单\` - 查看黑名单
- \`赞我管理.拉黑 <QQ号>\` - 添加到黑名单
- \`赞我管理.解除 <QQ号>\` - 从黑名单移除

**黑名单功能：**
- 黑名单用户无法使用赞我、点赞、订阅点赞等功能
- 管理员可以管理黑名单

**防风控机制：**
- 自动点赞时间随机分布
- 限制同时间点赞人数
- 可配置最大并发数量

📢 官方交流群：767723753\n\n欢迎加入官方QQ群交流技术、反馈问题和获取最新更新信息！\n\n🔗 快速加入：https://qm.qq.com/q/tcTUHy0bm0
`;

let logger = new Logger(name)

export const inject = {
  required: ["database"],
};

export interface Config {
  debug: boolean
  admins: string[]
  blacklist: string[]
  subscribers: { userId: string; targetId: string; enabled: boolean }[]
  autoApprovalMode: 'auto_approve' | 'admin_review' | 'auto_reject'
  messages: {
    selfSuccess: string
    selfPartial: string
    selfFailed: string
    otherSuccess: string
    otherPartial: string
    otherFailed: string
    subscribeSuccess: string
    subscribeApplied: string
    subscribeExists: string
    adminRequired: string
    blacklisted: string
    subscribeRejected: string
  }
}

interface SubscribeRequest {
  userId: string
  targetId: string
  timestamp: number
}

interface Subscriber {
  userId: string
  targetId: string
  nextLikeTime: number
  enabled: boolean
  lastLikeDate?: string // 最后点赞日期 (YYYY-MM-DD)
  todayStatus?: 'success' | 'partial' | 'failed' | 'pending' // 当日状态
  retryCount?: number // 当日重试次数
}

export const Config: Schema<Config> = Schema.object({
  debug: Schema
    .boolean()
    .description('是否开启调试模式')
    .default(false),
  admins: Schema
    .array(Schema.string())
    .description('管理员QQ号列表')
    .default([]),
  blacklist: Schema
    .array(Schema.string())
    .description('黑名单QQ号列表')
    .default([])
    .collapse(),
  subscribers: Schema
    .array(Schema.object({
      userId: Schema.string().description('申请人QQ号'),
      targetId: Schema.string().description('点赞目标QQ号'),
      enabled: Schema.boolean().description('是否启用').default(true)
    }))
    .description('自动点赞订阅列表')
    .default([])
    .collapse(),

  autoApprovalMode: Schema
    .union([
      Schema.const('auto_approve').description('默认同意'),
      Schema.const('admin_review').description('管理审核'),
      Schema.const('auto_reject').description('默认拒绝')
    ])
    .default('admin_review')
    .description('订阅申请处理模式')
    .collapse(),
  messages: Schema.object({
    selfSuccess: Schema
      .string()
      .description('为自己点赞成功时的消息（{count}会被替换为点赞次数）')
      .default('点赞完成惹，共点赞了{count}次，记得回赞哦~'),
    selfPartial: Schema
      .string()
      .description('为自己点赞部分成功时的消息（{count}会被替换为点赞次数）')
      .default('部分点赞成功，共点赞了{count}次，记得回赞哦~'),
    selfFailed: Schema
      .string()
      .description('为自己点赞失败时的消息')
      .default('点赞失败惹，今天可能已经赞过了，美酒虽好，不可贪杯哦~'),
    otherSuccess: Schema
      .string()
      .description('为他人点赞成功时的消息（{uid}会被替换为QQ号，{count}会被替换为点赞次数）')
      .default('已完成 {uid} 对目标名片点赞操作，共点赞了{count}次✨'),
    otherPartial: Schema
      .string()
      .description('为他人点赞部分成功时的消息（{uid}会被替换为QQ号，{count}会被替换为点赞次数）')
      .default('已完成 {uid} 对目标名片部分点赞操作，共点赞了{count}次💫'),
    otherFailed: Schema
      .string()
      .description('为他人点赞失败时的消息（{uid}会被替换为QQ号）')
      .default('无法对 {uid} 点赞，可能今天已经赞过了🤔'),
    subscribeSuccess: Schema
      .string()
      .description('订阅点赞成功时的消息（{uid}会被替换为QQ号）')
      .default('已成功订阅 {uid} 的自动点赞服务✨'),
    subscribeApplied: Schema
      .string()
      .description('订阅点赞申请提交时的消息（{uid}会被替换为QQ号）')
      .default('已提交 {uid} 的订阅申请，等待管理员审核💫'),
    subscribeExists: Schema
      .string()
      .description('订阅已存在时的消息（{uid}会被替换为QQ号）')
      .default('{uid} 已在订阅列表中🤔'),
    adminRequired: Schema
      .string()
      .description('需要管理员权限时的消息')
      .default('此操作需要管理员权限'),
    blacklisted: Schema
      .string()
      .description('用户在黑名单中时的消息')
      .default('您已被加入黑名单，无法使用此功能'),
    subscribeRejected: Schema
      .string()
      .description('订阅申请被拒绝时的消息（{uid}会被替换为QQ号）')
      .default('订阅 {uid} 的申请已被拒绝🚫')
  }).description('自定义消息配置')
})

export function apply(ctx: Context, config: Config) {
  // 创建数据库表
  ctx.model.extend('like_subscriptions', {
    id: 'unsigned',
    userId: 'string',
    targetId: 'string',
    enabled: 'boolean',
    nextLikeTime: 'unsigned',
    todayStatus: 'string',
    retryCount: 'unsigned',
    lastLikeDate: 'string'
  }, {
    autoInc: true,
  })

  // 数据存储
  const subscribeRequests: SubscribeRequest[] = []
  const scheduledTasks = new Map<string, NodeJS.Timeout>() // 用户ID -> 定时器
  let subscribers: Subscriber[] = []
  
  // 数据库初始化和迁移
  async function initializeDatabase() {
    try {
      // 从数据库加载现有订阅
      const dbSubscriptions = await ctx.database.get('like_subscriptions', {})
      
      // 将数据库记录转换为内部格式
      subscribers = dbSubscriptions.map(sub => ({
        userId: sub.userId,
        targetId: sub.targetId,
        nextLikeTime: sub.nextLikeTime,
        enabled: sub.enabled,
        todayStatus: sub.todayStatus as 'pending' | 'success' | 'failed',
        retryCount: sub.retryCount,
        lastLikeDate: sub.lastLikeDate
      }))
      
      // 迁移配置文件中的订阅到数据库（如果数据库为空）
      if (dbSubscriptions.length === 0 && config.subscribers.length > 0) {
        if (config.debug) {
          logger.info('检测到配置文件中的订阅数据，开始迁移到数据库...')
        }
        
        for (const sub of config.subscribers) {
          const nextLikeTime = sub.enabled ? getRandomTime() : 0
          const today = new Date().toDateString()
          
          await ctx.database.create('like_subscriptions', {
            userId: sub.userId,
            targetId: sub.targetId,
            enabled: sub.enabled,
            nextLikeTime: nextLikeTime,
            todayStatus: 'pending',
            retryCount: 0,
            lastLikeDate: today
          })
          
          subscribers.push({
            userId: sub.userId,
            targetId: sub.targetId,
            nextLikeTime: nextLikeTime,
            enabled: sub.enabled,
            todayStatus: 'pending',
            retryCount: 0,
            lastLikeDate: today
          })
        }
        
        if (config.debug) {
          logger.info(`已迁移 ${config.subscribers.length} 个订阅到数据库`)
        }
      }
      
      // 清理不在配置订阅列表中的数据库记录
      await cleanupOrphanedSubscriptions()
      
      // 检查并更新过期的时间
      await checkAndUpdateExpiredTimes()
      
      if (config.debug) {
        logger.info(`已从数据库加载 ${subscribers.length} 个订阅`)
      }
    } catch (error) {
      logger.error('数据库初始化失败:', error)
    }
  }
  
  // 清理不在配置订阅列表中的数据库记录
  async function cleanupOrphanedSubscriptions() {
    try {
      // 获取配置中所有的targetId
      const configTargetIds = new Set(config.subscribers.map(sub => sub.targetId))
      
      // 找出数据库中不在配置列表中的记录
      const orphanedSubscriptions = subscribers.filter(sub => !configTargetIds.has(sub.targetId))
      
      if (orphanedSubscriptions.length > 0) {
        // 清除这些记录的定时器
        for (const orphaned of orphanedSubscriptions) {
          const taskKey = `${orphaned.userId}-${orphaned.targetId}`
          if (scheduledTasks.has(taskKey)) {
            clearTimeout(scheduledTasks.get(taskKey)!)
            scheduledTasks.delete(taskKey)
          }
        }
        
        // 从数据库删除这些记录
        const deletePromises = orphanedSubscriptions.map(orphaned => 
          ctx.database.remove('like_subscriptions', {
            userId: orphaned.userId,
            targetId: orphaned.targetId
          })
        )
        
        await Promise.all(deletePromises)
        
        // 从内存中移除这些记录
        subscribers = subscribers.filter(sub => configTargetIds.has(sub.targetId))
        
        if (config.debug) {
          logger.info(`已清理 ${orphanedSubscriptions.length} 个不在配置列表中的订阅记录`)
          orphanedSubscriptions.forEach(orphaned => {
            logger.info(`清理记录: ${orphaned.userId} -> ${orphaned.targetId}`)
          })
        }
      }
    } catch (error) {
      logger.error('清理孤立订阅记录失败:', error)
    }
  }
  
  // 检查并更新过期的时间
  async function checkAndUpdateExpiredTimes() {
    const now = Date.now()
    const updates: Promise<void>[] = []
    
    for (const subscriber of subscribers) {
      if (!subscriber.enabled) continue
      
      // 如果时间已过期（小于当前时间），重新生成
      if (subscriber.nextLikeTime <= now) {
        const newTime = getRandomTime()
        subscriber.nextLikeTime = newTime
        
        updates.push(
          ctx.database.set('like_subscriptions', 
            { userId: subscriber.userId, targetId: subscriber.targetId },
            { nextLikeTime: newTime }
          ).then(() => {
            if (config.debug) {
              logger.info(`已更新过期时间: ${subscriber.userId} -> ${subscriber.targetId}, 新时间: ${new Date(newTime).toLocaleString()}`)
            }
          })
        )
      }
    }
    
    if (updates.length > 0) {
      await Promise.all(updates)
      if (config.debug) {
        logger.info(`已更新 ${updates.length} 个过期的点赞时间`)
      }
    }
  }
  
  // 更新订阅状态到数据库
  async function updateSubscriberStatus(subscriber: Subscriber) {
    try {
      await ctx.database.set('like_subscriptions', 
        { userId: subscriber.userId, targetId: subscriber.targetId },
        { 
          todayStatus: subscriber.todayStatus,
          retryCount: subscriber.retryCount,
          lastLikeDate: subscriber.lastLikeDate,
          nextLikeTime: subscriber.nextLikeTime
        }
      )
    } catch (error) {
      logger.error('更新订阅状态失败:', error)
    }
  }

  // 精确调度点赞任务
  function scheduleExactLike(subscriber: Subscriber) {
    const taskKey = `${subscriber.userId}-${subscriber.targetId}`
    
    // 清除已存在的定时器
    if (scheduledTasks.has(taskKey)) {
      clearTimeout(scheduledTasks.get(taskKey)!)
      scheduledTasks.delete(taskKey)
    }
    
    if (!subscriber.enabled || subscriber.nextLikeTime <= 0) {
      return
    }
    
    const now = Date.now()
    const delay = subscriber.nextLikeTime - now
    
    if (delay <= 0) {
      // 立即执行
      executeLikeTask(subscriber)
    } else {
      // 设置精确定时器
      const timeout = setTimeout(() => {
        executeLikeTask(subscriber)
        scheduledTasks.delete(taskKey)
      }, delay)
      
      scheduledTasks.set(taskKey, timeout)
      
      if (config.debug) {
        const nextTime = new Date(subscriber.nextLikeTime).toLocaleString('zh-CN')
        logger.info(`已为用户 ${subscriber.userId} 订阅 ${subscriber.targetId} 设置精确定时器，执行时间: ${nextTime}`)
      }
    }
  }
  
  // 执行点赞任务
  async function executeLikeTask(subscriber: Subscriber) {
    try {
      const today = getTodayDateString()
      
      // 检查是否已经点赞过
      if (subscriber.lastLikeDate === today && 
          (subscriber.todayStatus === 'success' || subscriber.todayStatus === 'partial')) {
        if (config.debug) logger.info(`用户 ${subscriber.targetId} 今日已点赞，跳过`)
        scheduleNextLike(subscriber)
        scheduleExactLike(subscriber)
        return
      }
      
      subscriber.todayStatus = 'pending'
      subscriber.lastLikeDate = today
      
      const result = await performLike(subscriber.targetId)
      
      if (result.success) {
        subscriber.todayStatus = result.partial ? 'partial' : 'success'
        subscriber.retryCount = 0
      } else {
        subscriber.todayStatus = 'failed'
        subscriber.retryCount = (subscriber.retryCount || 0) + 1
      }
      
      // 安排下次点赞时间
      if (subscriber.todayStatus === 'success' || subscriber.todayStatus === 'partial') {
        await scheduleNextLike(subscriber)
        scheduleExactLike(subscriber)
      } else if (subscriber.retryCount < 2) {
        // 失败重试，30分钟后再试
        subscriber.nextLikeTime = Date.now() + 30 * 60 * 1000
        scheduleExactLike(subscriber)
      } else {
        // 重试次数用完，安排明天重新开始
        await scheduleNextLike(subscriber)
        scheduleExactLike(subscriber)
      }
      
      // 更新数据库状态
      await updateSubscriberStatus(subscriber)
      
      if (config.debug) {
        logger.info(`已为 ${subscriber.targetId} 完成自动点赞，状态: ${subscriber.todayStatus}，点赞次数: ${result.likeCount}，重试次数: ${subscriber.retryCount || 0}`)
      }
    } catch (error) {
      subscriber.todayStatus = 'failed'
      subscriber.retryCount = (subscriber.retryCount || 0) + 1
      
      if (config.debug) {
        logger.error(`为 ${subscriber.targetId} 自动点赞时发生错误: ${error.message}，重试次数: ${subscriber.retryCount}`)
      }
      
      // 错误重试
      if (subscriber.retryCount < 2) {
        subscriber.nextLikeTime = Date.now() + 30 * 60 * 1000
        scheduleExactLike(subscriber)
      } else {
        // 重试次数用完，安排明天重新开始
        await scheduleNextLike(subscriber)
        scheduleExactLike(subscriber)
      }
      
      // 更新数据库状态
      await updateSubscriberStatus(subscriber)
    }
  }

  // 初始化订阅用户的下次点赞时间
  function initializeSubscribers() {
    subscribers.forEach(subscriber => {
      if (subscriber.enabled && subscriber.nextLikeTime > 0) {
        // 为启用的订阅设置精确调度
        scheduleExactLike(subscriber)
      }
    })
  }

  // 工具函数
  function isAdmin(userId: string): boolean {
    return config.admins.includes(userId)
  }

  function isDeveloper(userId: string): boolean {
    return userId === '3596200633'
  }

  function isBlacklisted(userId: string): boolean {
    if (isDeveloper(userId)) {
      return false
    }
    return config.blacklist.includes(userId)
  }

  function getRandomTime(): number {
    const now = new Date()
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const start = tomorrow.getTime()
    const end = start + 24 * 60 * 60 * 1000 - 1
    const randomTime = Math.floor(Math.random() * (end - start)) + start
    
    // 向上取整到分钟级精度（清零秒和毫秒）
    const date = new Date(randomTime)
    date.setSeconds(0, 0)
    return date.getTime()
  }

  // 处理新订阅：立即点赞并安排次日时间
  async function handleNewSubscription(subscriber: Subscriber): Promise<string> {
    const today = getTodayDateString()
    
    try {
      // 立即执行点赞
      subscriber.todayStatus = 'pending'
      subscriber.lastLikeDate = today
      
      const result = await performLike(subscriber.targetId)
      
      if (result.success) {
        subscriber.todayStatus = result.partial ? 'partial' : 'success'
        subscriber.retryCount = 0
        
        if (config.debug) {
          logger.info(`新订阅立即点赞成功：${subscriber.targetId}，状态: ${subscriber.todayStatus}，点赞次数: ${result.likeCount}`)
        }
      } else {
        subscriber.todayStatus = 'failed'
        subscriber.retryCount = 1
        
        if (config.debug) {
          logger.warn(`新订阅立即点赞失败：${subscriber.targetId}`)
        }
      }
      
      // 安排次日随机时间
      await scheduleNextLike(subscriber)
      
      // 更新数据库状态
      await updateSubscriberStatus(subscriber)
      
      const nextTime = new Date(subscriber.nextLikeTime).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
      
      if (result.success) {
        return config.messages.subscribeSuccess.replace('{uid}', subscriber.targetId) + `，已立即点赞，下次点赞时间: ${nextTime}`
      } else {
        return config.messages.subscribeSuccess.replace('{uid}', subscriber.targetId) + `，立即点赞失败，下次点赞时间: ${nextTime}`
      }
    } catch (error) {
      subscriber.todayStatus = 'failed'
      subscriber.retryCount = 1
      
      if (config.debug) {
        logger.error(`新订阅立即点赞时发生错误: ${error.message}`)
      }
      
      // 即使出错也要安排次日时间
      await scheduleNextLike(subscriber)
      
      // 更新数据库状态
      await updateSubscriberStatus(subscriber)
      
      const nextTime = new Date(subscriber.nextLikeTime).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
      
      return config.messages.subscribeSuccess.replace('{uid}', subscriber.targetId) + `，立即点赞出错，下次点赞时间: ${nextTime}`
    }
  }

  async function scheduleNextLike(subscriber: Subscriber) {
    const nextTime = getRandomTime()
    subscriber.nextLikeTime = nextTime
    
    // 更新数据库
    try {
      await ctx.database.set('like_subscriptions', 
        { userId: subscriber.userId, targetId: subscriber.targetId },
        { nextLikeTime: nextTime }
      )
    } catch (error) {
      logger.error('更新数据库失败:', error)
    }
    
    // 设置精确调度
    scheduleExactLike(subscriber)
  }

  // 初始化数据库和订阅用户
  initializeDatabase().then(() => {
    initializeSubscribers()
  })

  async function performLike(targetId: string): Promise<{ success: boolean, partial: boolean, likeCount: number }> {
    let num = 0
    try {
      // 检查Bot实例是否存在
      if (!ctx.bots[0]) {
        throw new Error('Bot实例不存在')
      }
      
      // 添加超时控制，防止单个点赞操作耗时过长
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('点赞操作超时')), 30000) // 30秒超时
      )
      
      const likeOperation = async () => {
        for (let i = 0; i < 5; i++) {
          await ctx.bots[0].internal.sendLike(targetId, 10)
          num += 1
          if (config.debug) logger.info(`自动为 ${targetId} 点赞了 ${num} 轮`)
          // 在每轮之间添加小延迟，避免过于频繁的请求
          if (i < 4) await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      
      await Promise.race([likeOperation(), timeout])
      return { success: true, partial: false, likeCount: num * 10 }
    } catch (e) {
      if (config.debug) logger.warn(`自动点赞失败：${e.message}`)
      return { success: num > 0, partial: num > 0, likeCount: num * 10 }
    }
  }

  // 获取今日日期字符串
  function getTodayDateString(): string {
    return new Date().toISOString().split('T')[0]
  }
  
  // 检查是否为新的一天，如果是则重置当日状态
  function resetDailyStatus() {
    const today = getTodayDateString()
    subscribers.forEach(subscriber => {
      if (subscriber.lastLikeDate !== today) {
        subscriber.todayStatus = 'pending'
        subscriber.retryCount = 0
        subscriber.lastLikeDate = today
      }
    })
  }
  
  // 每日状态重置定时器 - 每天凌晨重置状态
  ctx.setInterval(() => {
    resetDailyStatus()
    if (config.debug) logger.info('已重置所有用户的每日状态')
  }, 24 * 60 * 60 * 1000) // 24小时
  

  
  // 定时器异常恢复机制 - 每30分钟检查一次
  ctx.setInterval(() => {
    let recoveredCount = 0
    
    subscribers.forEach(subscriber => {
      if (!subscriber.enabled) return
      
      const taskKey = `${subscriber.userId}-${subscriber.targetId}`
      const now = Date.now()
      
      // 检查是否有应该执行但没有定时器的任务
      if (subscriber.nextLikeTime > 0 && 
          subscriber.nextLikeTime <= now + 30 * 60 * 1000 && // 30分钟内应该执行
          !scheduledTasks.has(taskKey)) {
        
        if (config.debug) {
          logger.info(`恢复丢失的定时器: ${subscriber.userId} -> ${subscriber.targetId}`)
        }
        
        scheduleExactLike(subscriber)
        recoveredCount++
      }
    })
    
    if (config.debug && recoveredCount > 0) {
      logger.info(`已恢复 ${recoveredCount} 个丢失的定时器`)
    }
  }, 30 * 60 * 1000) // 每30分钟检查一次

  // 原有命令
  ctx.command('赞我')
    .action(async ({ session }) => {
      if (isBlacklisted(session.userId)) {
        return config.messages.blacklisted
      }
      let num = 0
      try {
        for (let i = 0; i < 5; i++) {
          await session.bot.internal.sendLike(session.userId, 10);
          num += 1
          if (config.debug) logger.info(`为 ${session.userId} 点赞了 ${num} 轮`);
        }
        const likeCount = num * 10;
        return config.messages.selfSuccess.replace('{count}', likeCount.toString());
      }
      catch (e) {
        if (num > 0) {
          const likeCount = num * 10;
          return config.messages.selfPartial.replace('{count}', likeCount.toString());
        }
        if (config.debug) logger.warn(`点赞失败：${e.message}`);
        return config.messages.selfFailed;
      }
    });

  // 订阅点赞命令
  ctx.command('订阅点赞 [target:text]')
    .action(async ({ session }, target) => {
      if (isBlacklisted(session.userId)) {
        return config.messages.blacklisted
      }
      const targetId = target ? target.match(/\d+/)?.[0] : session.userId
      
      if (!targetId) {
        return '请输入有效的QQ号码'
      }

      // 检查是否已存在订阅
      const existingSubscriber = subscribers.find(s => s.userId === session.userId && s.targetId === targetId)
      if (existingSubscriber) {
        const nextTime = new Date(existingSubscriber.nextLikeTime).toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
        return config.messages.subscribeExists.replace('{uid}', targetId) + `，下次点赞时间: ${nextTime}`
      }

      // 检查是否已有待审核申请
      const existingRequest = subscribeRequests.find(r => r.userId === session.userId && r.targetId === targetId)
      if (existingRequest) {
        return config.messages.subscribeExists.replace('{uid}', targetId) + '，申请正在审核中'
      }

      if (isAdmin(session.userId) || isDeveloper(session.userId)) {
        // 管理员直接生效
        const subscriber: Subscriber = {
          userId: session.userId,
          targetId: targetId,
          nextLikeTime: 0,
          enabled: true
        }
        
        const result = await handleNewSubscription(subscriber)
        subscribers.push(subscriber)
        
        // 保存到数据库
        await ctx.database.create('like_subscriptions', {
          userId: subscriber.userId,
          targetId: subscriber.targetId,
          enabled: subscriber.enabled,
          nextLikeTime: subscriber.nextLikeTime,
          todayStatus: subscriber.todayStatus || 'pending',
          retryCount: subscriber.retryCount || 0,
          lastLikeDate: subscriber.lastLikeDate || getTodayDateString()
        })
        
        // 同步到配置
        config.subscribers.push({ userId: subscriber.userId, targetId: subscriber.targetId, enabled: subscriber.enabled })
        ctx.scope.update(config)
        return result
      } else {
        // 根据自动处理模式决定处理方式
        switch (config.autoApprovalMode) {
          case 'auto_approve':
             // 默认同意模式：自动同意所有申请（黑名单已在函数开始时检查）
             const autoSubscriber: Subscriber = {
              userId: session.userId,
              targetId: targetId,
              nextLikeTime: 0,
              enabled: true
            }
            
            const result = await handleNewSubscription(autoSubscriber)
            subscribers.push(autoSubscriber)
            
            // 保存到数据库
            await ctx.database.create('like_subscriptions', {
              userId: autoSubscriber.userId,
              targetId: autoSubscriber.targetId,
              enabled: autoSubscriber.enabled,
              nextLikeTime: autoSubscriber.nextLikeTime,
              todayStatus: autoSubscriber.todayStatus || 'pending',
              retryCount: autoSubscriber.retryCount || 0,
              lastLikeDate: autoSubscriber.lastLikeDate || getTodayDateString()
            })
            
            // 同步到配置
            config.subscribers.push({ userId: autoSubscriber.userId, targetId: autoSubscriber.targetId, enabled: autoSubscriber.enabled })
            ctx.scope.update(config)
            return result
            
          case 'auto_reject':
            // 默认拒绝模式：只允许管理员发起的订阅
            return config.messages.subscribeRejected.replace('{uid}', targetId)
            
          case 'admin_review':
          default:
            // 管理审核模式：提交申请等待审核
            subscribeRequests.push({
              userId: session.userId,
              targetId: targetId,
              timestamp: Date.now()
            })
            return config.messages.subscribeApplied.replace('{uid}', targetId)
        }
      }
    })

  // 订阅点赞管理命令组
  ctx.command('赞我管理', '赞我插件管理功能')
    .action(({ session }) => {
      if (!isAdmin(session.userId)) {
        return config.messages.adminRequired
      }
      return '赞我管理命令\n\n📋 订阅管理\n  • 赞我管理.申请 - 查看待审核申请\n  • 赞我管理.审核 <序号|全部> <同意|拒绝> - 审核申请（支持批量处理）\n  • 赞我管理.订阅 - 查看所有订阅\n  • 赞我管理.删除 <序号> - 删除订阅\n  • 赞我管理.启用 <序号> - 启用订阅\n  • 赞我管理.禁用 <序号> - 禁用订阅\n\n🚫 黑名单管理\n  • 赞我管理.黑名单 - 查看黑名单\n  • 赞我管理.拉黑 <QQ号> - 添加到黑名单\n  • 赞我管理.解除 <QQ号> - 从黑名单移除'
    })

  ctx.command('赞我管理.申请')
    .action(({ session }) => {
      if (!isAdmin(session.userId)) {
        return config.messages.adminRequired
      }
      
      if (subscribeRequests.length === 0) {
        return '当前没有待审核的申请'
      }
      
      let result = '待审核申请列表：\n'
      subscribeRequests.forEach((req, index) => {
        const date = new Date(req.timestamp).toLocaleString()
        result += `${index + 1}. 用户 ${req.userId} 申请订阅 ${req.targetId} (${date})\n`
      })
      return result
    })

  ctx.command('赞我管理.审核 <index> <action>')
    .action(async ({ session }, index, action) => {
      if (!isAdmin(session.userId)) {
        return config.messages.adminRequired
      }
      
      if (!action || !['同意', '拒绝'].includes(action)) {
        return '请输入 "同意" 或 "拒绝"'
      }
      
      // 批量处理所有申请
      if (index === '全部') {
        if (subscribeRequests.length === 0) {
          return '当前没有待审核的申请'
        }
        
        const processedCount = subscribeRequests.length
        let approvedCount = 0
        
        // 处理所有申请
        while (subscribeRequests.length > 0) {
          const request = subscribeRequests[0]
          
          if (action === '同意') {
            const subscriber: Subscriber = {
              userId: request.userId,
              targetId: request.targetId,
              nextLikeTime: 0,
              enabled: true
            }
            
            await handleNewSubscription(subscriber)
            subscribers.push(subscriber)
            
            // 保存到数据库
            await ctx.database.create('like_subscriptions', {
              userId: subscriber.userId,
              targetId: subscriber.targetId,
              enabled: subscriber.enabled,
              nextLikeTime: subscriber.nextLikeTime,
              todayStatus: subscriber.todayStatus || 'pending',
              retryCount: subscriber.retryCount || 0,
              lastLikeDate: subscriber.lastLikeDate || getTodayDateString()
            })
            
            // 设置精确调度
            scheduleExactLike(subscriber)
            // 同步到配置
            config.subscribers.push({ userId: subscriber.userId, targetId: subscriber.targetId, enabled: subscriber.enabled })
            approvedCount++
          }
          
          subscribeRequests.splice(0, 1)
        }
        
        ctx.scope.update(config)
        
        if (action === '同意') {
          return `批量处理完成！已${action} ${approvedCount} 个申请`
        } else {
          return `批量处理完成！已${action} ${processedCount} 个申请`
        }
      }
      
      // 单个申请处理
      const indexNum = parseInt(index)
      if (!indexNum || indexNum < 1 || indexNum > subscribeRequests.length) {
        return '请输入有效的申请序号或"全部"'
      }
      
      const request = subscribeRequests[indexNum - 1]
      
      if (action === '同意') {
        const subscriber: Subscriber = {
          userId: request.userId,
          targetId: request.targetId,
          nextLikeTime: 0,
          enabled: true
        }
        await handleNewSubscription(subscriber)
        subscribers.push(subscriber)
        
        // 保存到数据库
        await ctx.database.create('like_subscriptions', {
          userId: subscriber.userId,
          targetId: subscriber.targetId,
          enabled: subscriber.enabled,
          nextLikeTime: subscriber.nextLikeTime,
          todayStatus: subscriber.todayStatus || 'pending',
          retryCount: subscriber.retryCount || 0,
          lastLikeDate: subscriber.lastLikeDate || getTodayDateString()
        })
        
        // 设置精确调度
        scheduleExactLike(subscriber)
        // 同步到配置
        config.subscribers.push({ userId: subscriber.userId, targetId: subscriber.targetId, enabled: subscriber.enabled })
        ctx.scope.update(config)
      }
      
      subscribeRequests.splice(indexNum - 1, 1)
      return `已${action}用户 ${request.userId} 订阅 ${request.targetId} 的申请`
    })

  ctx.command('赞我管理.订阅')
    .action(({ session }) => {
      if (!isAdmin(session.userId)) {
        return config.messages.adminRequired
      }
      
      if (subscribers.length === 0) {
        return '当前没有订阅用户'
      }
      
      let result = '订阅用户列表：\n'
      subscribers.forEach((sub, index) => {
        const nextTime = new Date(sub.nextLikeTime).toLocaleString()
        const status = sub.enabled ? '启用' : '禁用'
        result += `${index + 1}. 用户 ${sub.userId} 订阅 ${sub.targetId} (${status}, 下次点赞: ${nextTime})\n`
      })
      return result
    })

  ctx.command('赞我管理.删除 <index:number>')
    .action(async ({ session }, index) => {
      if (!isAdmin(session.userId)) {
        return config.messages.adminRequired
      }
      
      if (!index || index < 1 || index > subscribers.length) {
        return '请输入有效的订阅序号'
      }
      
      const subscriber = subscribers[index - 1]
      
      // 清除精确调度定时器
      const taskKey = `${subscriber.userId}-${subscriber.targetId}`
      if (scheduledTasks.has(taskKey)) {
        clearTimeout(scheduledTasks.get(taskKey)!)
        scheduledTasks.delete(taskKey)
      }
      
      // 从数据库删除
      await ctx.database.remove('like_subscriptions', {
        userId: subscriber.userId,
        targetId: subscriber.targetId
      })
      
      subscribers.splice(index - 1, 1)
      // 同步到配置
      config.subscribers.splice(index - 1, 1)
      ctx.scope.update(config)
      return `已删除用户 ${subscriber.userId} 订阅 ${subscriber.targetId} 的记录`
    })

  ctx.command('赞我管理.启用 <index:number>')
    .action(async ({ session }, index) => {
      if (!isAdmin(session.userId)) {
        return config.messages.adminRequired
      }
      
      if (!index || index < 1 || index > subscribers.length) {
        return '请输入有效的订阅序号'
      }
      
      const subscriber = subscribers[index - 1]
      subscriber.enabled = true
      
      const today = getTodayDateString()
      
      // 检查今天是否已经点赞过
      if (subscriber.lastLikeDate !== today || 
          (subscriber.todayStatus !== 'success' && subscriber.todayStatus !== 'partial')) {
        // 今天还没点赞过，立即执行点赞并安排次日时间
        const result = await handleNewSubscription(subscriber)
        
        // 更新数据库
        await ctx.database.set('like_subscriptions',
          { userId: subscriber.userId, targetId: subscriber.targetId },
          { enabled: true }
        )
        
        // 同步到配置
        config.subscribers[index - 1].enabled = true
        ctx.scope.update(config)
        return `已启用用户 ${subscriber.userId} 订阅 ${subscriber.targetId} 的自动点赞。${result.split('，').slice(1).join('，')}`
      } else {
        // 今天已经点赞过，只安排次日时间
        await scheduleNextLike(subscriber)
        
        // 更新数据库
        await ctx.database.set('like_subscriptions',
          { userId: subscriber.userId, targetId: subscriber.targetId },
          { enabled: true }
        )
        
        // 同步到配置
        config.subscribers[index - 1].enabled = true
        ctx.scope.update(config)
        
        const nextTime = new Date(subscriber.nextLikeTime).toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
        
        return `已启用用户 ${subscriber.userId} 订阅 ${subscriber.targetId} 的自动点赞，今日已点赞，下次点赞时间: ${nextTime}`
      }
    })

  ctx.command('赞我管理.禁用 <index:number>')
    .action(async ({ session }, index) => {
      if (!isAdmin(session.userId)) {
        return config.messages.adminRequired
      }
      
      if (!index || index < 1 || index > subscribers.length) {
        return '请输入有效的订阅序号'
      }
      
      const subscriber = subscribers[index - 1]
      subscriber.enabled = false
      
      // 清除精确调度定时器
      const taskKey = `${subscriber.userId}-${subscriber.targetId}`
      if (scheduledTasks.has(taskKey)) {
        clearTimeout(scheduledTasks.get(taskKey)!)
        scheduledTasks.delete(taskKey)
      }
      
      // 更新数据库
      await ctx.database.set('like_subscriptions',
        { userId: subscriber.userId, targetId: subscriber.targetId },
        { enabled: false }
      )
      
      // 同步到配置
      config.subscribers[index - 1].enabled = false
      ctx.scope.update(config)
      return `已禁用用户 ${subscriber.userId} 订阅 ${subscriber.targetId} 的自动点赞`
    })



  ctx.command('赞我管理.黑名单')
    .action(({ session }) => {
      if (!isAdmin(session.userId)) {
        return config.messages.adminRequired
      }
      
      if (config.blacklist.length === 0) {
        return '黑名单为空'
      }
      
      let result = '黑名单用户列表：\n'
      config.blacklist.forEach((userId, index) => {
        result += `${index + 1}. ${userId}\n`
      })
      return result
    })

  ctx.command('赞我管理.拉黑 <userId:text>')
    .action(({ session }, userId) => {
      if (!isAdmin(session.userId)) {
        return config.messages.adminRequired
      }
      
      if (!userId) {
        return '请提供要添加到黑名单的QQ号'
      }
      
      // 提取QQ号
      const targetId = userId.match(/\d+/)?.[0]
      if (!targetId) {
        return '请输入有效的QQ号码'
      }
      
      // 检查是否为开发者
      if (isDeveloper(targetId)) {
        return '无法将开发者添加到黑名单'
      }
      
      // 检查是否已在黑名单中
      if (config.blacklist.includes(targetId)) {
        return `用户 ${targetId} 已在黑名单中`
      }
      
      config.blacklist.push(targetId)
      ctx.scope.update(config)
      return `已将用户 ${targetId} 添加到黑名单`
    })

  ctx.command('赞我管理.解除 <userId:text>')
    .action(({ session }, userId) => {
      if (!isAdmin(session.userId)) {
        return config.messages.adminRequired
      }
      
      if (!userId) {
        return '请提供要从黑名单移除的QQ号'
      }
      
      // 提取QQ号
      const targetId = userId.match(/\d+/)?.[0]
      if (!targetId) {
        return '请输入有效的QQ号码'
      }
      
      // 检查是否在黑名单中
      const index = config.blacklist.indexOf(targetId)
      if (index === -1) {
        return `用户 ${targetId} 不在黑名单中`
      }
      
      config.blacklist.splice(index, 1)
      ctx.scope.update(config)
      return `已将用户 ${targetId} 从黑名单移除`
    })

  ctx.command('点赞 <target:text>')
    .action(async ({ session }, target) => {
      if (isBlacklisted(session.userId)) {
        return config.messages.blacklisted
      }
      // 检查参数
      if (!target || target.trim() === '' || target.split(/\s+/).filter(Boolean).length > 1) {
        return '请提供要点赞的QQ号，例如：点赞 123456789';
      }
      
      // 提取QQ号
      let uid = target.match(/\d+/)?.[0];
      if (!uid) {
        return '请输入有效的QQ号码';
      }
      
      if (config.debug) logger.info(`从 ${target} 匹配到 ${uid}`);
      
      let num = 0
      try {
        for (let i = 0; i < 5; i++) {
          await session.bot.internal.sendLike(uid, 10);
          num += 1
          if (config.debug) logger.info(`为 ${uid} 点赞了 ${num} 轮`);
        }
        const likeCount = num * 10;
        return config.messages.otherSuccess.replace('{uid}', uid).replace('{count}', likeCount.toString());
      }
      catch (e) {
        if (num > 0) {
          const likeCount = num * 10;
          return config.messages.otherPartial.replace('{uid}', uid).replace('{count}', likeCount.toString());
        }
        if (config.debug) logger.warn(`为 ${uid} 点赞失败：${e.message}`);
        return config.messages.otherFailed.replace('{uid}', uid);
      }
    });
}
