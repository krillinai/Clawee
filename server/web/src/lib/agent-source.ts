export function agentCreationSourceLabel(source?: string): string {
  switch (source) {
    case "collector":
      return "采集器创建";
    case "clawee_login":
      return "Clawee";
    case "manual":
      return "手动创建";
    case "legacy":
      return "历史数据";
    default:
      return "未知";
  }
}
