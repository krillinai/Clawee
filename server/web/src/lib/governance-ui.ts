export type DecisionVariant = "success" | "danger" | "warning" | "muted";

export type LifecycleStep = {
  state: "allow" | "deny" | "neutral";
  title: string;
  copy: string;
};
