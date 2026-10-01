# MR/分支 main 代码评审报告

## 📋 评审总结

本次变更引入 SQLite 存储提示历史并提供了完备的迁移与生命周期单测。经批判性审查，仅保留 1 项确定性严重级缺陷：遗留文件在入库提交后若删除失败将导致后续提示词录入被永久阻断，必须予以修复。

## 📊 统计信息

| 指标 | 数值 |
| --- | --- |
| 🔴 阻断级 | 0 个 |
| 🟠 严重级 | 1 个 |
| 🟡 次要级 | 0 个 |
| 🟢 提示级 | 0 个 |
| **结论** | ❌ 必须修改 |

## 🔍 问题详情

### 🟠 严重级问题

#### 问题 #1：遗留文件删除失败抛出异常导致该工作区提示词录入永久被阻断

- **位置:** `packages/pi-history/src/store.ts:125-128`
- **触发条件:** 遗留文件 `pi-history.json` 所在的目录或文件本身存在权限限制（如 `EACCES`）或在 Windows 下被其他进程锁定（`EPERM`）。
- **确定影响:** 数据库事务已成功提交且已记录迁移标记，但清理阶段 `rmSync(source)` 抛出非 `ENOENT` 异常未被捕获。由于 `appendHistory` 与 `loadHistory` 均在入口处无条件调用 `migrateLegacy`，导致后续每次录入提示词均在清理阶段失败并中断，该工作区将永久无法继续录入提示词，且会话启动时无法恢复历史。
- **代码依据:**
  ```typescript
  // store.ts:122-128
  try {
      if (readFileSync(source, "utf8") !== raw)
          throw new Error(`legacy history changed after migration at ${source}`);
      rmSync(source);
  } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  ```
  在事务提交后执行 `rmSync`，发生 `EACCES`/`EPERM` 时向上抛出。`appendHistory` 入口 `migrateLegacy(cwd)` 抛出后，`history.ts:43-48` 捕获并将 `appendFailureReported` 置为 `true` 并不再录入。下一次录入时 `migrateLegacy` 仍会触发相同异常。
- **建议修复:** 清理旧文件属于非关键副作用，捕获非 `ENOENT` 异常并记录告警日志即可，避免因辅助文件清理失败阻断核心录入流程：
  ```typescript
  try {
      if (readFileSync(source, "utf8") !== raw)
          throw new Error(`legacy history changed after migration at ${source}`);
      rmSync(source);
  } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
          console.warn(`pi-history: could not remove migrated legacy file at ${source}: ${describe(error)}`);
      }
  }
  ```

---

## 🧪 单元测试覆盖度

**整体覆盖结论:** ✅ 核心场景已覆盖，存在边界容错缺口

核心迁移与生命周期测试覆盖完备，但缺少遗留文件已入库后清理失败场景的容错与持续录入验证。

---

> 🔍 本报告已通过批判性审查，仅保留经验证的真实问题（原 5 项，保留 1 项）

critic完成
