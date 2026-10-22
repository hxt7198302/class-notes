package com.hxt.classnotes

import android.content.Context
import android.content.Intent

/**
 * 监督员（com.hxt.screenguard）上课模式联动（v1.9）：开录音=上课（白名单外停用），下课/取消=解除。
 * 开源比对第九节结论落地，要点：
 *  - **显式广播**（指定对方组件）：监督员没装/没更新时 sendBroadcast 静默无异常——无感跳过不报错
 *    （需求确认单定的），上课录音本身绝不受影响；
 *  - 对方 receiver 由签名级权限护住，两 APP 同 debug 签名自动互信，第三方伪造不了上课/下课；
 *  - extras 只用基础类型（boolean/string），action 全名带对方包名前缀防撞名；
 *  - 幂等：重复发上课=对方续期安全阀（无害），重复发下课=写零（无害），不加任何去重状态。
 * 全部调用点都在 Rec 服务（:rec 独立进程）内：下课/取消/收尸都跟着真实录音状态走，
 * 页面进程崩了也照发；每段录音（10 分钟轮转）成功续期一次——录音进程被杀没来得及发
 * 「下课」时，对方 15 分钟安全阀自动解除，不会把人锁到下课。
 */
object GuardLink {
    private const val GUARD_PKG = "com.hxt.screenguard"
    private const val GUARD_RECV = "com.hxt.screenguard.ClassReceiver"
    const val ACTION = "com.hxt.screenguard.action.CLASS_MODE"

    fun classMode(ctx: Context, on: Boolean, course: String) {
        try {
            val i = Intent(ACTION).setClassName(GUARD_PKG, GUARD_RECV)
            // 对方处于 stopped state（被「强行停止」过/装后从未打开）时系统默认不投递——
            // 加此旗标让广播穿透并唤醒 receiver，否则联动静默失效（对抗性审查补）
            i.addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
            i.putExtra("on", on)
            if (course.isNotEmpty()) i.putExtra("course", course)
            ctx.sendBroadcast(i)
        } catch (_: Throwable) { }   // 对方不在/权限不匹配：静默跳过
    }
}
