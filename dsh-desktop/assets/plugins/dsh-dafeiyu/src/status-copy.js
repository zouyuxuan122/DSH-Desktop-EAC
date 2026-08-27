const COPY = Object.freeze({
  idle: [
    '我在这儿等新任务哦',
    '现在暂时没任务呢',
    '大肥鱼正在待命中~',
  ],
  preparing: [
    '新任务正在梳理中哦~',
    '让我先看看项目呢',
    '正在理清接下来要做什么呀',
  ],
  thinking: [
    '正在认真想下一步呢',
    '正在梳理思路哦~',
    '让我整理一下刚才的结果呢',
  ],
  searching: [
    '正在帮你找相关内容呢',
    '正在项目里仔细找找哦~',
    '正在查看相关文件呢',
  ],
  editing: [
    '这部分正在修改中哦',
    '正在把改动写进去呢',
    '正在认真调整实现呢',
  ],
  testing: [
    '正在认真检查结果呢',
    '正在跑测试确认一下哦',
    '正在验证改动有没有问题呢',
  ],
  commanding: [
    '正在执行项目命令呢',
    '正在让项目跑起来哦',
    '正在看看命令执行得怎么样呢',
  ],
  working: [
    '正在继续处理任务呢',
    '这一步正在进行中哦',
    '大肥鱼还在认真干活呢',
  ],
  result: [
    '正在整理刚才的结果呢',
    '这一步处理好了，继续看看哦',
    '正在确认下一步怎么做呢',
  ],
  waiting: [
    '需要你确认一下后续呢',
    '这里要等你看一下哦',
    '轮到你来决定下一步啦',
  ],
  approval: [
    '需要你审批一下哦',
    '这里在等你的批准呢',
    '有个权限操作要你确认一下啦',
  ],
  success: [
    '这次的任务搞定啦~',
    '这一轮顺利完成啦',
    '任务完成咯~',
  ],
  toolError: [
    '这一步好像没跑通呢',
    '刚才的操作遇到一点问题哦',
    '这里卡了一下，我再等等你呢',
  ],
  error: [
    '任务好像遇到一点问题呢',
    '这里需要回来看看啦',
    '这次没有顺利跑完呢',
  ],
  stopped: [
    '任务已经停下来啦',
    '这次任务先停在这里哦',
  ],
  limit: [
    '内容有点多，到上限啦',
    '这次输出已经到上限咯',
  ],
})

function seedNumber(seed) {
  const number = Number(seed)
  if (Number.isFinite(number)) return Math.abs(Math.trunc(number))
  return [...String(seed ?? '')].reduce((total, character) => total + character.codePointAt(0), 0)
}

export function statusCopy(group, seed = 0) {
  const variants = COPY[group] ?? COPY.working
  return variants[seedNumber(seed) % variants.length]
}

export function activityCopy(activity, seed = 0) {
  return statusCopy({
    searching: 'searching',
    editing: 'editing',
    testing: 'testing',
    commanding: 'commanding',
  }[activity] ?? 'working', seed)
}

export function activityStage(activity) {
  return {
    searching: '查找阶段',
    editing: '实现阶段',
    testing: '验证阶段',
    commanding: '执行阶段',
  }[activity] ?? '处理阶段'
}

export function taskCopy(task) {
  const value = String(task ?? '').trim().replace(/[。！？.!?]+$/u, '')
  if (!value) return statusCopy('working')
  if (/^(正在|继续)/u.test(value)) {
    return `${value}呢`
  }
  if (/^(准备|检查|验证|修改|修复|测试|构建|整理|分析|梳理|查找|搜索|读取|实现)/u.test(value)) {
    return `正在${value}呢`
  }
  return `正在处理「${value}」呢`
}

export { COPY as statusCopyLibrary }
