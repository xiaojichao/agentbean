export function appendManagedOutputContext(prompt: string, outputDir: string): string {
  return [
    prompt,
    '## AgentBean 受管交付目录',
    `如果本次任务生成文件，请把所有最终交付文件写入 ${outputDir}。`,
    '环境变量 AGENTBEAN_OUTPUT_DIR 指向同一目录；只有进入该目录的最终交付文件才能同步到频道文件与 OutputPackage 卡片。',
    '不要只把最终交付文件写到桌面或 Agent 自身数据目录。仅需文字回复时无需创建文件。',
  ].join('\n\n');
}
