import type { AnalysisResult, Usage } from "./analysis.ts";

function safe(text: string): string {
	return [...text]
		.map((character) =>
			character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127 ? " " : character,
		)
		.join("")
		.replace(/[|`<>]/g, "_");
}

export function formatReport(result: AnalysisResult): string {
	const incomplete = result.sources.some(
		(source) => source.warnings.length > 0 || source.invalid > 0 || source.messages === 0,
	);
	const used = result.usage.filter((row) => row.lastUsed);
	const unused = result.usage.filter((row) => !row.lastUsed && row.known);
	const unknown = result.usage.filter((row) => !row.lastUsed && !row.known);
	const lines = [
		`# Skills 使用分析 · 最近 ${result.days} 天`,
		"",
		`窗口（UTC）：${result.since} 至 ${result.until}`,
		"",
		"宽松口径：显式调用、读取/加载请求、用户或助手正文提及均算证据。每条消息每个 skill 每类最多计一次；一次调用可同时计为提及。加载计数不保证工具成功执行。",
		"系统清单、工具返回内容、thinking、压缩摘要及本报告不计入统计。未观察到使用不等于不再需要。",
		"",
		"## 扫描范围与数据质量",
	];
	for (const source of result.sources) {
		lines.push(
			`- ${source.source}: ${safe(source.root)} — ${source.files} 个 JSONL 文件，窗口内 ${source.messages} 条去重消息，${source.invalid} 条损坏/无法识别时间或内容的记录。`,
		);
		for (const warning of source.warnings.slice(0, 20)) lines.push(`  - ${safe(warning)}`);
		if (source.warnings.length > 20)
			lines.push(`  - 另有 ${source.warnings.length - 20} 条扫描警告。`);
		if (!source.messages) lines.push("  - 此来源没有窗口内可用消息；不能据此判断未使用。");
	}
	const table = (title: string, rows: Usage[]) => {
		lines.push("", `## ${title}`, "");
		if (!rows.length) {
			lines.push("（无）");
			return;
		}
		lines.push(
			"| Skill | 调用 | 加载请求 | 提及 | 最近使用（UTC） | 状态 |",
			"| --- | ---: | ---: | ---: | --- | --- |",
		);
		for (const row of rows)
			lines.push(
				`| ${safe(row.name)} | ${row.invocation} | ${row.load} | ${row.mention} | ${row.lastUsed ?? "—"} | ${row.excluded ? "已配置排除；" : ""}${row.known ? "当前可发现" : "当前不可发现"} |`,
			);
	};
	table(
		"窗口内有使用证据（当前可发现）",
		used.filter((row) => row.known),
	);
	table(
		"历史有证据，但当前不可发现",
		used.filter((row) => !row.known),
	);
	table(
		incomplete ? "未观察到使用，但数据不足：仅供人工复核" : "窗口内未观察到使用，可考虑排除",
		unused,
	);
	table("数据不足或无法判断（仅在排除配置中）", unknown);
	const candidates = incomplete ? [] : unused.filter((row) => !row.excluded).map((row) => row.name);
	lines.push(
		"",
		"## 可人工合并的排除建议",
		"",
		incomplete
			? "数据来源不完整，本次不自动推荐排除任何 skill；可人工参考上面的未观察到使用清单。"
			: "以下仅包含本次新增候选，合并时请保留原配置中的名称。",
		"",
		"```json",
		JSON.stringify(candidates, null, 2),
		"```",
		"",
		"本命令没有修改 Pi skill visibility settings。普通提及只能识别当前可发现/已配置的名称；历史未知 skill 仅从明确调用或 SKILL.md 路径识别，路径推断的名称可能与 frontmatter 不同。日志已删除、非标准目录或未记录的活动无法恢复。",
	);
	return lines.join("\n");
}
