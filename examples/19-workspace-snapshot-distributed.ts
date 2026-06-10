/**
 * Example 19 — DEPRECATED: 这个文件原本想"在同一进程内串行跑两个 OAK"模拟跨节点,
 * 但实际上 AGS 那边同 toolId 下只要有 RUNNING 实例就 reuse,inst.release() 在
 * scope='shared' 下又是 no-op (ags-stateful-sandbox.ts:1058)。所以这种写法在
 * AGS 层永远共用同一物理容器,workspace 物理还在,不会触发 COS restore。
 * 用它做"跨节点"演示是误导性的。
 *
 * 真正验证 cross-node restore 闭环,请看:
 *   - examples/19a-snapshot-write.ts  (写 + send-end snapshot)
 *   - 手动 tcb sandbox instance stop <id>(让 AGS 容器真停)
 *   - examples/19b-snapshot-read.ts   (新进程 startSession,验 restoreStatus=full)
 *
 * 这个文件保留只是为了把人引导到正确的 19a/19b。
 */

console.log(
  '[example 19] DEPRECATED: 改用 19a-snapshot-write.ts + 手动 tcb sandbox instance stop + 19b-snapshot-read.ts',
)
console.log('请看 19a / 19b 文件顶部注释了解为什么。')
process.exit(0)
